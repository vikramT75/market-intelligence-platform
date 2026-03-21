import json
from kafka import KafkaConsumer, KafkaProducer
from collections import deque
import statistics
import psycopg2
from datetime import datetime, timezone

TRADES_TOPIC = "crypto_trades"
METRICS_TOPIC = "crypto_metrics"

# Kafka consumer
consumer = KafkaConsumer(
    TRADES_TOPIC,
    bootstrap_servers="localhost:9092",
    auto_offset_reset="latest",
    value_deserializer=lambda v: json.loads(v.decode("utf-8")),
)

# Kafka producer (for derived metrics topic)
producer = KafkaProducer(
    bootstrap_servers="localhost:9092",
    value_serializer=lambda v: json.dumps(v).encode("utf-8"),
)

# PostgreSQL connection
conn = psycopg2.connect(
    host="localhost",
    database="marketdb",
    user="market",
    password="marketpass"
)
cursor = conn.cursor()

print("Metrics worker started...\n")

# --- Per-symbol state ---
# Each symbol gets its own rolling windows and counters
symbol_state = {}

def get_state(symbol):
    if symbol not in symbol_state:
        symbol_state[symbol] = {
            "price_window": deque(maxlen=20),
            "rsi_gains": deque(maxlen=14),
            "rsi_losses": deque(maxlen=14),
            "previous_price": None,
            "open_price_24h": None,       # first price seen (proxy for 24h open)
            "cumulative_volume": 0.0,
            "trade_count": 0,
        }
    return symbol_state[symbol]


def compute_rsi(gains, losses):
    """Compute RSI-14 from deques of gains and losses."""
    if len(gains) < 14:
        return None
    avg_gain = sum(gains) / len(gains)
    avg_loss = sum(losses) / len(losses)
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 2)


for message in consumer:
    trade = message.value

    symbol = trade["symbol"]
    price = float(trade["price"])
    quantity = float(trade["quantity"])
    trade_time = datetime.strptime(trade["trade_time"], "%Y-%m-%d %H:%M:%S")

    state = get_state(symbol)

    # --- Update state ---
    state["price_window"].append(price)
    state["cumulative_volume"] += quantity
    state["trade_count"] += 1

    # 24h open price (first price seen acts as session open proxy)
    if state["open_price_24h"] is None:
        state["open_price_24h"] = price

    # Rolling avg
    rolling_avg = sum(state["price_window"]) / len(state["price_window"])

    # Simple return + RSI gains/losses
    if state["previous_price"] is not None:
        change = price - state["previous_price"]
        simple_return = change / state["previous_price"]
        state["rsi_gains"].append(max(change, 0))
        state["rsi_losses"].append(abs(min(change, 0)))
    else:
        simple_return = 0.0

    state["previous_price"] = price

    # Volatility
    volatility = statistics.stdev(state["price_window"]) if len(state["price_window"]) > 1 else 0.0

    # RSI
    rsi = compute_rsi(state["rsi_gains"], state["rsi_losses"])

    # 24h price change %
    change_24h_pct = ((price - state["open_price_24h"]) / state["open_price_24h"]) * 100

    metrics = {
        "symbol": symbol,
        "price": price,
        "rolling_avg_20": round(rolling_avg, 4),
        "return": round(simple_return, 6),
        "volatility": round(volatility, 4),
        "rsi": rsi,
        "volume": round(state["cumulative_volume"], 4),
        "trade_count": state["trade_count"],
        "change_24h_pct": round(change_24h_pct, 4),
        "trade_time": trade_time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    # Publish to Kafka derived topic
    producer.send(METRICS_TOPIC, metrics)

    # Insert into PostgreSQL
    cursor.execute(
        """
        INSERT INTO crypto_metrics
        (symbol, price, rolling_avg_20, return, volatility, rsi, volume, trade_count, change_24h_pct, trade_time)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            metrics["symbol"],
            metrics["price"],
            metrics["rolling_avg_20"],
            metrics["return"],
            metrics["volatility"],
            metrics["rsi"],
            metrics["volume"],
            metrics["trade_count"],
            metrics["change_24h_pct"],
            trade_time,
        )
    )
    conn.commit()

    print(f"[{symbol}] price={price} | rsi={rsi} | vol={metrics['volume']} | 24h%={metrics['change_24h_pct']}")