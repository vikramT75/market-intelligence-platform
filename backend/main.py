import asyncio
import json
import logging
import os
import threading
import time

from datetime import datetime
from dotenv import load_dotenv
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from kafka import KafkaConsumer
from kafka.errors import NoBrokersAvailable
from psycopg2 import pool as pg_pool

load_dotenv()

# ── Config ────────────────────────────────────────────────────────────────
KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
METRICS_TOPIC   = os.getenv("KAFKA_METRICS_TOPIC", "crypto_metrics")
DB_HOST         = os.getenv("DB_HOST", "localhost")
DB_NAME         = os.getenv("DB_NAME", "marketdb")
DB_USER         = os.getenv("DB_USER", "market")
DB_PASSWORD     = os.getenv("DB_PASSWORD", "marketpass")
DB_PORT         = int(os.getenv("DB_PORT", 5432))

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

# ── DB Pool ───────────────────────────────────────────────────────────────
db_pool = pg_pool.SimpleConnectionPool(
    minconn=2, maxconn=10,
    host=DB_HOST, database=DB_NAME,
    user=DB_USER, password=DB_PASSWORD, port=DB_PORT,
)

def get_connection():
    return db_pool.getconn()

def release_connection(conn):
    db_pool.putconn(conn)

# ── WebSocket Manager ─────────────────────────────────────────────────────
class ConnectionManager:
    def __init__(self):
        self.active: dict[str, list[WebSocket]] = {}
        self.main_loop: asyncio.AbstractEventLoop | None = None  # FastAPI's event loop

    async def connect(self, symbol: str, ws: WebSocket):
        await ws.accept()
        self.active.setdefault(symbol, []).append(ws)
        logger.info(f"WS connected: {symbol} | total: {len(self.active.get(symbol, []))}")

    def disconnect(self, symbol: str, ws: WebSocket):
        if symbol in self.active:
            try:
                self.active[symbol].remove(ws)
            except ValueError:
                pass

    async def broadcast(self, symbol: str, message: dict):
        connections = self.active.get(symbol, [])
        if not connections:
            return
        dead = []
        for ws in connections:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(symbol, ws)

    def broadcast_from_thread(self, symbol: str, message: dict):
        """Called from Kafka thread — schedules broadcast on FastAPI's event loop."""
        if self.main_loop is None:
            return
        asyncio.run_coroutine_threadsafe(
            self.broadcast(symbol, message),
            self.main_loop
        )

manager = ConnectionManager()


# ── Capture FastAPI's event loop on startup ───────────────────────────────
@app.on_event("startup")
async def startup():
    manager.main_loop = asyncio.get_running_loop()
    logger.info("FastAPI event loop captured.")
    # Start Kafka thread after loop is captured
    thread = threading.Thread(target=kafka_broadcast_loop, daemon=True)
    thread.start()


# ── Kafka Background Thread ───────────────────────────────────────────────
def kafka_broadcast_loop():
    retry_delay = 2
    max_delay   = 30

    while True:
        try:
            logger.info("Kafka consumer: connecting...")
            consumer = KafkaConsumer(
                METRICS_TOPIC,
                bootstrap_servers=KAFKA_BOOTSTRAP,
                auto_offset_reset="latest",
                value_deserializer=lambda v: json.loads(v.decode("utf-8")),
                request_timeout_ms=5000,
                connections_max_idle_ms=10000,
            )
            logger.info("Kafka consumer: connected.")
            retry_delay = 2

            for message in consumer:
                metrics = message.value
                symbol  = metrics.get("symbol", "").upper()
                manager.broadcast_from_thread(symbol, metrics)

        except NoBrokersAvailable:
            logger.warning(f"Kafka unavailable. Retry in {retry_delay}s...")
        except Exception as e:
            logger.error(f"Kafka error: {e}. Retry in {retry_delay}s...")

        time.sleep(retry_delay)
        retry_delay = min(retry_delay * 2, max_delay)


# ── Routes ────────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"message": "Market Intelligence API is running"}

@app.get("/health")
def health():
    return {"status": "ok"}

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
                    FROM crypto_metrics WHERE symbol = %s
                    ORDER BY id DESC LIMIT %s OFFSET %s
                """, (symbol.upper(), limit, offset))
            else:
                cursor.execute("""
                    SELECT symbol, price, rolling_avg_20, return, volatility,
                           rsi, volume, trade_count, change_24h_pct, trade_time
                    FROM crypto_metrics
                    ORDER BY id DESC LIMIT %s OFFSET %s
                """, (limit, offset))
            rows = cursor.fetchall()
    finally:
        release_connection(conn)
    return {"count": len(rows), "limit": limit, "offset": offset, "data": [_row_to_dict(r) for r in rows]}

@app.get("/metrics/history")
def get_metrics_history(symbol: str, start: str, end: str):
    start_dt = datetime.fromisoformat(start)
    end_dt   = datetime.fromisoformat(end)
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
    return [_row_to_dict(r) for r in rows]

@app.get("/metrics/summary")
def get_summary():
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT DISTINCT ON (symbol)
                    symbol, price, rolling_avg_20, return, volatility,
                    rsi, volume, trade_count, change_24h_pct, trade_time
                FROM crypto_metrics ORDER BY symbol, id DESC
            """)
            rows = cursor.fetchall()
    finally:
        release_connection(conn)
    return [_row_to_dict(r) for r in rows]

@app.websocket("/ws/{symbol}")
async def websocket_endpoint(websocket: WebSocket, symbol: str):
    sym = symbol.upper()
    await manager.connect(sym, websocket)
    try:
        while True:
            await asyncio.sleep(30)
    except WebSocketDisconnect:
        manager.disconnect(sym, websocket)

def _row_to_dict(row):
    return {
        "symbol": row[0], "price": row[1], "rolling_avg_20": row[2],
        "return": row[3], "volatility": row[4], "rsi": row[5],
        "volume": row[6], "trade_count": row[7], "change_24h_pct": row[8],
        "trade_time": row[9].isoformat(),
    }