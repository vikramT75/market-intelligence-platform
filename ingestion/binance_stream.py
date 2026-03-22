import asyncio
import json
import os
import sys
import websockets
from datetime import datetime, timezone
from kafka import KafkaProducer
from dotenv import load_dotenv

load_dotenv()

# ── Config from .env ──────────────────────────────────────────────────────
KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
TOPIC           = os.getenv("KAFKA_TRADES_TOPIC", "crypto_trades")
DEFAULT_SYMBOL  = os.getenv("DEFAULT_SYMBOL", "btcusdt")

# Accept symbol as CLI argument, fall back to .env, then hardcoded default
SYMBOL = sys.argv[1].lower() if len(sys.argv) > 1 else DEFAULT_SYMBOL.lower()
BINANCE_WS_URL = f"wss://stream.binance.com:9443/ws/{SYMBOL}@trade"

# ── Kafka Producer ────────────────────────────────────────────────────────
producer = KafkaProducer(
    bootstrap_servers=KAFKA_BOOTSTRAP,
    value_serializer=lambda v: json.dumps(v).encode("utf-8"),
    linger_ms=5,
    acks="all",
)


async def stream_prices():
    print(f"Connecting to Binance stream for {SYMBOL.upper()}...")
    async with websockets.connect(BINANCE_WS_URL) as ws:
        print(f"Connected to Binance stream: {SYMBOL.upper()}")

        while True:
            message = await ws.recv()
            data = json.loads(message)

            trade_time_utc = datetime.fromtimestamp(
                data["T"] / 1000, tz=timezone.utc
            ).strftime("%Y-%m-%d %H:%M:%S")

            trade = {
                "symbol":     data["s"],
                "price":      data["p"],
                "quantity":   data["q"],
                "trade_time": trade_time_utc,
            }

            producer.send(TOPIC, trade)
            print(f"[{trade['symbol']}] price={trade['price']}")


if __name__ == "__main__":
    asyncio.run(stream_prices())