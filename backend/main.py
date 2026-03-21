from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from psycopg2 import pool as pg_pool
from kafka import KafkaConsumer
from kafka.errors import NoBrokersAvailable
import asyncio
import json
import threading
import time
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("market-api")

app = FastAPI(title="Market Intelligence API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Connection Pool ---
db_pool = pg_pool.SimpleConnectionPool(
    minconn=2,
    maxconn=10,
    host="localhost",
    database="marketdb",
    user="market",
    password="marketpass"
)


def get_connection():
    return db_pool.getconn()


def release_connection(conn):
    db_pool.putconn(conn)


# --- WebSocket Connection Manager ---
class ConnectionManager:
    def __init__(self):
        self.active: dict[str, list[WebSocket]] = {}

    async def connect(self, symbol: str, ws: WebSocket):
        await ws.accept()
        self.active.setdefault(symbol, []).append(ws)

    def disconnect(self, symbol: str, ws: WebSocket):
        if symbol in self.active:
            try:
                self.active[symbol].remove(ws)
            except ValueError:
                pass

    async def broadcast(self, symbol: str, message: dict):
        connections = self.active.get(symbol, [])
        dead = []
        for ws in connections:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(symbol, ws)


manager = ConnectionManager()


# --- Background Kafka Consumer Thread with retry ---
def kafka_broadcast_loop():
    loop = asyncio.new_event_loop()
    retry_delay = 2
    max_delay = 30

    while True:
        try:
            logger.info("Kafka consumer: attempting to connect...")
            consumer = KafkaConsumer(
                "crypto_metrics",
                bootstrap_servers="localhost:9092",
                auto_offset_reset="latest",
                value_deserializer=lambda v: json.loads(v.decode("utf-8")),
                request_timeout_ms=5000,
                connections_max_idle_ms=10000,
            )
            logger.info("Kafka consumer: connected successfully.")
            retry_delay = 2  # reset backoff on successful connect

            for message in consumer:
                metrics = message.value
                symbol = metrics.get("symbol", "").upper()
                loop.run_until_complete(manager.broadcast(symbol, metrics))

        except NoBrokersAvailable:
            logger.warning(f"Kafka not available. Retrying in {retry_delay}s...")
        except Exception as e:
            logger.error(f"Kafka consumer error: {e}. Retrying in {retry_delay}s...")

        time.sleep(retry_delay)
        retry_delay = min(retry_delay * 2, max_delay)  # exponential backoff


thread = threading.Thread(target=kafka_broadcast_loop, daemon=True)
thread.start()


# --- Root ---
@app.get("/")
def root():
    return {"message": "Market Intelligence API is running"}


# --- Health ---
@app.get("/health")
def health():
    return {"status": "ok"}


# --- Available Symbols ---
@app.get("/symbols")
def get_symbols():
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT DISTINCT symbol FROM crypto_metrics ORDER BY symbol")
            rows = cursor.fetchall()
        return {"symbols": [row[0] for row in rows]}
    finally:
        release_connection(conn)


# --- Latest Metrics ---
@app.get("/metrics/latest")
def get_latest_metrics(
    limit: int = Query(10, ge=1, le=100),
    offset: int = Query(0, ge=0),
    symbol: str | None = None
):
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            if symbol:
                cursor.execute("""
                    SELECT symbol, price, rolling_avg_20, return, volatility,
                           rsi, volume, trade_count, change_24h_pct, trade_time
                    FROM crypto_metrics
                    WHERE symbol = %s
                    ORDER BY id DESC
                    LIMIT %s OFFSET %s
                """, (symbol.upper(), limit, offset))
            else:
                cursor.execute("""
                    SELECT symbol, price, rolling_avg_20, return, volatility,
                           rsi, volume, trade_count, change_24h_pct, trade_time
                    FROM crypto_metrics
                    ORDER BY id DESC
                    LIMIT %s OFFSET %s
                """, (limit, offset))
            rows = cursor.fetchall()
    finally:
        release_connection(conn)

    return {
        "count": len(rows),
        "limit": limit,
        "offset": offset,
        "data": [_row_to_dict(row) for row in rows]
    }


# --- Historical Metrics ---
@app.get("/metrics/history")
def get_metrics_history(symbol: str, start: str, end: str):
    start_dt = datetime.fromisoformat(start)
    end_dt = datetime.fromisoformat(end)

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT symbol, price, rolling_avg_20, return, volatility,
                       rsi, volume, trade_count, change_24h_pct, trade_time
                FROM crypto_metrics
                WHERE symbol = %s AND trade_time BETWEEN %s AND %s
                ORDER BY trade_time ASC
            """, (symbol.upper(), start_dt, end_dt))
            rows = cursor.fetchall()
    finally:
        release_connection(conn)

    return [_row_to_dict(row) for row in rows]


# --- Summary ---
@app.get("/metrics/summary")
def get_summary():
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT DISTINCT ON (symbol)
                    symbol, price, rolling_avg_20, return, volatility,
                    rsi, volume, trade_count, change_24h_pct, trade_time
                FROM crypto_metrics
                ORDER BY symbol, id DESC
            """)
            rows = cursor.fetchall()
    finally:
        release_connection(conn)
    return [_row_to_dict(row) for row in rows]


# --- WebSocket ---
@app.websocket("/ws/{symbol}")
async def websocket_endpoint(websocket: WebSocket, symbol: str):
    sym = symbol.upper()
    await manager.connect(sym, websocket)
    try:
        while True:
            await asyncio.sleep(30)
    except WebSocketDisconnect:
        manager.disconnect(sym, websocket)


# --- Helper ---
def _row_to_dict(row):
    return {
        "symbol": row[0],
        "price": row[1],
        "rolling_avg_20": row[2],
        "return": row[3],
        "volatility": row[4],
        "rsi": row[5],
        "volume": row[6],
        "trade_count": row[7],
        "change_24h_pct": row[8],
        "trade_time": row[9].isoformat(),
    }