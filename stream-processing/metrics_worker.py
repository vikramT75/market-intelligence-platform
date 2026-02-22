import json
from kafka import KafkaConsumer, KafkaProducer
from collections import deque
import statistics
import psycopg2
from datetime import datetime

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

price_window = deque(maxlen=20)
previous_price = None

for message in consumer:
    trade = message.value

    price = float(trade["price"])
    price_window.append(price)

    rolling_avg = sum(price_window) / len(price_window)

    if previous_price is not None:
        simple_return = (price - previous_price) / previous_price
    else:
        simple_return = 0.0

    previous_price = price

    if len(price_window) > 1:
        volatility = statistics.stdev(price_window)
    else:
        volatility = 0.0

    trade_time = datetime.strptime(trade["trade_time"], "%Y-%m-%d %H:%M:%S")

    metrics = {
        "symbol": trade["symbol"],
        "price": price,
        "rolling_avg_20": rolling_avg,
        "return": simple_return,
        "volatility": volatility,
        "trade_time": trade_time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    # Publish to Kafka derived topic
    producer.send(METRICS_TOPIC, metrics)

    # Insert into PostgreSQL
    cursor.execute(
        """
        INSERT INTO crypto_metrics 
        (symbol, price, rolling_avg_20, return, volatility, trade_time)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (
            metrics["symbol"],
            metrics["price"],
            metrics["rolling_avg_20"],
            metrics["return"],
            metrics["volatility"],
            trade_time
        )
    )

    conn.commit()

    print(f"Stored in DB + Published: {metrics}")
