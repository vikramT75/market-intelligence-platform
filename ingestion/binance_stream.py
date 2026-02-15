import asyncio
import json
import websockets

BINANCE_WS_URL = "wss://stream.binance.com:9443/ws/btcusdt@trade"

async def stream_prices():
    async with websockets.connect(BINANCE_WS_URL) as ws:
        print("Connected to Binance stream")

        while True:
            message = await ws.recv()
            data = json.loads(message)

            price = data["p"]
            quantity = data["q"]
            trade_time = data["T"]

            print(f"Price: {price} | Qty: {quantity} | Time: {trade_time}")

if __name__ == "__main__":
    asyncio.run(stream_prices())
