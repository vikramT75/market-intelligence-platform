import json
from kafka import KafkaConsumer, KafkaProducer
from collections import deque
import statistics

TRADES_TOPIC = "crypto_trades"
METRICS_TOPIC = "crypto_metrics"

consumer = KafkaConsumer(
    TRADES_TOPIC,
    bootstrap_servers="localhost:9092",
    auto_offset_reset="latest",
    value_deserializer=lambda v: json.loads(v.decode("utf-8")),
)

producer = KafkaProducer(
    bootstrap_servers="localhost:9092",
    value_serializer=lambda v: json.dumps(v).encode("utf-8"),
)

print("Metrics worker started...\n")

price_window = deque(maxlen=20)
previous_price = None

for message in consumer:
    trade = message.value

    price = float(trade["price"])
    price_window.append(price)

    # Rolling average
    rolling_avg = sum(price_window) / len(price_window)

    # Return
    if previous_price is not None:
        simple_return = (price - previous_price) / previous_price
    else:
        simple_return = 0.0

    previous_price = price

    # Volatility
    if len(price_window) > 1:
        volatility = statistics.stdev(price_window)
    else:
        volatility = 0.0

    metrics = {
        "symbol": trade["symbol"],
        "price": price,
        "rolling_avg_20": rolling_avg,
        "return": simple_return,
        "volatility": volatility,
        "trade_time": trade["trade_time"],
    }

    # Publish computed metrics
    producer.send(METRICS_TOPIC, metrics)

    print(f"Published metrics: {metrics}")
