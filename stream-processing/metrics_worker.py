import json
import math
import os
import time
from kafka import KafkaConsumer, KafkaProducer
from collections import deque
import statistics
import psycopg2
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

# ── Config ────────────────────────────────────────────────────────────────
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
    host=DB_HOST, database=DB_NAME,
    user=DB_USER, password=DB_PASSWORD, port=DB_PORT,
)
cursor = conn.cursor()

print("Metrics worker started...\n")
print(f"Batch config: size={BATCH_SIZE}, flush_interval={BATCH_FLUSH_INTERVAL}s\n")

# ── Per-symbol state ──────────────────────────────────────────────────────
symbol_state = {}

def get_state(symbol):
    if symbol not in symbol_state:
        symbol_state[symbol] = {
            "price_window":      deque(maxlen=20),
            "rsi_gains":         deque(maxlen=14),
            "rsi_losses":        deque(maxlen=14),
            "returns_window":    deque(maxlen=30),  # for Sharpe
            "previous_price":    None,
            "open_price_24h":    None,
            "cumulative_volume": 0.0,
            "trade_count":       0,
            "peak_price":        None,   # for max drawdown
            "max_drawdown":      0.0,
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


def compute_sharpe(returns: deque) -> float | None:
    """
    Annualised Sharpe ratio using a rolling window of simple returns.
    Assumes risk-free rate = 0 (common for crypto).
    Annualisation factor: sqrt(365 * 24 * 60 * 60) for per-second returns,
    but we approximate with sqrt(N_trades_per_year). We use sqrt(252 * 390)
    as a conventional approximation for high-frequency crypto.
    """
    if len(returns) < 30:
        return None
    returns_list = list(returns)
    mean_r = sum(returns_list) / len(returns_list)
    try:
        std_r = statistics.stdev(returns_list)
    except statistics.StatisticsError:
        return None
    if std_r == 0:
        return None
    # Annualise: crypto trades ~365 days, ~1440 min/day, assume ~1 trade/sec avg
    annualisation_factor = math.sqrt(365 * 24 * 60)
    sharpe = (mean_r / std_r) * annualisation_factor
    return round(sharpe, 4)


def compute_max_drawdown(state: dict, price: float) -> float:
    """
    Tracks the running peak and returns the maximum drawdown seen so far.
    Drawdown = (peak - current) / peak, expressed as a negative percentage.
    """
    if state["peak_price"] is None or price > state["peak_price"]:
        state["peak_price"] = price

    drawdown = (price - state["peak_price"]) / state["peak_price"] * 100
    # Keep the most negative (worst) drawdown seen
    if drawdown < state["max_drawdown"]:
        state["max_drawdown"] = drawdown

    return round(state["max_drawdown"], 4)


# ── Batch buffer ──────────────────────────────────────────────────────────
batch      = []
last_flush = time.time()


def flush_batch():
    global batch, last_flush
    if not batch:
        return
    cursor.executemany(
        """
        INSERT INTO crypto_metrics
        (symbol, price, rolling_avg_20, return, volatility, rsi,
         volume, trade_count, change_24h_pct, sharpe, max_drawdown, trade_time)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        batch
    )
    conn.commit()
    print(f"[DB] Flushed {len(batch)} rows to PostgreSQL")
    batch      = []
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
    state["trade_count"]       += 1

    if state["open_price_24h"] is None:
        state["open_price_24h"] = price

    rolling_avg = sum(state["price_window"]) / len(state["price_window"])

    if state["previous_price"] is not None:
        change        = price - state["previous_price"]
        simple_return = change / state["previous_price"]
        state["rsi_gains"].append(max(change, 0))
        state["rsi_losses"].append(abs(min(change, 0)))
        state["returns_window"].append(simple_return)
    else:
        simple_return = 0.0

    state["previous_price"] = price

    volatility     = statistics.stdev(state["price_window"]) if len(state["price_window"]) > 1 else 0.0
    rsi            = compute_rsi(state["rsi_gains"], state["rsi_losses"])
    change_24h_pct = ((price - state["open_price_24h"]) / state["open_price_24h"]) * 100
    sharpe         = compute_sharpe(state["returns_window"])
    max_drawdown   = compute_max_drawdown(state, price)

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
        "sharpe":         sharpe,
        "max_drawdown":   max_drawdown,
        "trade_time":     trade_time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    producer.send(METRICS_TOPIC, metrics)

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
        metrics["sharpe"],
        metrics["max_drawdown"],
        trade_time,
    ))

    print(f"[{symbol}] price={price} | sharpe={sharpe} | drawdown={max_drawdown}% | buffer={len(batch)}/{BATCH_SIZE}")

    if len(batch) >= BATCH_SIZE or (time.time() - last_flush) >= BATCH_FLUSH_INTERVAL:
        flush_batch()