import json
import os
import time
from kafka import KafkaConsumer, KafkaProducer
from collections import deque
import statistics
import psycopg2
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

# ── Config from .env ──────────────────────────────────────────────────────
KAFKA_BOOTSTRAP      = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
TRADES_TOPIC         = os.getenv("KAFKA_TRADES_TOPIC", "crypto_trades")
METRICS_TOPIC        = os.getenv("KAFKA_METRICS_TOPIC", "crypto_metrics")

DB_HOST              = os.getenv("DB_HOST", "localhost")
DB_NAME              = os.getenv("DB_NAME", "marketdb")
DB_USER              = os.getenv("DB_USER", "market")
DB_PASSWORD          = os.getenv("DB_PASSWORD", "marketpass")
DB_PORT              = int(os.getenv("DB_PORT", 5432))

BATCH_SIZE           = int(os.getenv("BATCH_SIZE", 20))
BATCH_FLUSH_INTERVAL = int(os.getenv("BATCH_FLUSH_INTERVAL", 5))

# ── Kafka ─────────────────────────────────────────────────────────────────
consumer = KafkaConsumer(
    TRADES_TOPIC,
    bootstrap_servers=KAFKA_BOOTSTRAP,
    auto_offset_reset="latest",
    value_deserializer=lambda v: json.loads(v.decode("utf-8")),
)

producer = KafkaProducer(
    bootstrap_servers=KAFKA_BOOTSTRAP,
    value_serializer=lambda v: json.dumps(v).encode("utf-8"),
)

# ── Database ──────────────────────────────────────────────────────────────
conn = psycopg2.connect(
    host=DB_HOST,
    database=DB_NAME,
    user=DB_USER,
    password=DB_PASSWORD,
    port=DB_PORT,
)
cursor = conn.cursor()

print("Metrics worker started...\n")
print(f"Batch config: size={BATCH_SIZE}, flush_interval={BATCH_FLUSH_INTERVAL}s\n")

# ── Per-symbol state ──────────────────────────────────────────────────────
symbol_state = {}

def get_state(symbol):
    if symbol not in symbol_state:
        symbol_state[symbol] = {
            "price_window":     deque(maxlen=20),
            "rsi_gains":        deque(maxlen=14),
            "rsi_losses":       deque(maxlen=14),
            "previous_price":   None,
            "open_price_24h":   None,
            "cumulative_volume": 0.0,
            "trade_count":      0,
        }
    return symbol_state[symbol]


def compute_rsi(gains, losses):
    if len(gains) < 14:
        return None
    avg_gain = sum(gains) / len(gains)
    avg_loss = sum(losses) / len(losses)
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 2)


# ── Batch buffer ──────────────────────────────────────────────────────────
batch = []
last_flush = time.time()


def flush_batch():
    global batch, last_flush
    if not batch:
        return
    cursor.executemany(
        """
        INSERT INTO crypto_metrics
        (symbol, price, rolling_avg_20, return, volatility, rsi, volume, trade_count, change_24h_pct, trade_time)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        batch
    )
    conn.commit()
    print(f"[DB] Flushed {len(batch)} rows to PostgreSQL")
    batch = []
    last_flush = time.time()


# ── Main loop ─────────────────────────────────────────────────────────────
for message in consumer:
    trade      = message.value
    symbol     = trade["symbol"]
    price      = float(trade["price"])
    quantity   = float(trade["quantity"])
    trade_time = datetime.strptime(trade["trade_time"], "%Y-%m-%d %H:%M:%S")

    state = get_state(symbol)

    state["price_window"].append(price)
    state["cumulative_volume"] += quantity
    state["trade_count"] += 1

    if state["open_price_24h"] is None:
        state["open_price_24h"] = price

    rolling_avg = sum(state["price_window"]) / len(state["price_window"])

    if state["previous_price"] is not None:
        change        = price - state["previous_price"]
        simple_return = change / state["previous_price"]
        state["rsi_gains"].append(max(change, 0))
        state["rsi_losses"].append(abs(min(change, 0)))
    else:
        simple_return = 0.0

    state["previous_price"] = price

    volatility     = statistics.stdev(state["price_window"]) if len(state["price_window"]) > 1 else 0.0
    rsi            = compute_rsi(state["rsi_gains"], state["rsi_losses"])
    change_24h_pct = ((price - state["open_price_24h"]) / state["open_price_24h"]) * 100

    metrics = {
        "symbol":         symbol,
        "price":          price,
        "rolling_avg_20": round(rolling_avg, 4),
        "return":         round(simple_return, 6),
        "volatility":     round(volatility, 4),
        "rsi":            rsi,
        "volume":         round(state["cumulative_volume"], 4),
        "trade_count":    state["trade_count"],
        "change_24h_pct": round(change_24h_pct, 4),
        "trade_time":     trade_time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    # Always push to Kafka immediately for real-time frontend updates
    producer.send(METRICS_TOPIC, metrics)

    # Buffer for batch DB write
    batch.append((
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
    ))

    print(f"[{symbol}] price={price} | rsi={rsi} | buffer={len(batch)}/{BATCH_SIZE}")

    # Flush if batch full OR time interval exceeded
    if len(batch) >= BATCH_SIZE or (time.time() - last_flush) >= BATCH_FLUSH_INTERVAL:
        flush_batch()