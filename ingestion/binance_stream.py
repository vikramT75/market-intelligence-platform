import asyncio
import json
import websockets
from datetime import datetime, timezone
from kafka import KafkaProducer

BINANCE_WS_URL = "wss://stream.binance.com:9443/ws/btcusdt@trade"

producer = KafkaProducer(
    bootstrap_servers="localhost:9092",
    value_serializer=lambda v: json.dumps(v).encode("utf-8"),
    linger_ms=5,
    acks="all",
)

TOPIC = "crypto_trades"


async def stream_prices():
    async with websockets.connect(BINANCE_WS_URL) as ws:
        print("Connected to Binance stream")

        while True:
            message = await ws.recv()
            data = json.loads(message)
            
            trade_time_utc = datetime.fromtimestamp(
                data["T"] / 1000, tz=timezone.utc
            ).strftime("%Y-%m-%d %H:%M:%S")

            trade = {
                "symbol": data["s"],
                "price": data["p"],
                "quantity": data["q"],
                "trade_time": trade_time_utc,
            }

            producer.send(TOPIC, trade)

            print(f"Sent to Kafka: {trade}")


if __name__ == "__main__":
    asyncio.run(stream_prices())
