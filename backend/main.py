from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import psycopg2

app = FastAPI(title="Market Intelligence API")

# --- CORS Middleware (for future React dashboard) ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Later restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Database Connection Helper ---
def get_connection():
    return psycopg2.connect(
        host="localhost",
        database="marketdb",
        user="market",
        password="marketpass"
    )

# --- Root Endpoint ---
@app.get("/")
def root():
    return {"message": "Market Intelligence API is running"}

# --- Health Check Endpoint ---
@app.get("/health")
def health():
    return {"status": "ok"}

# --- Latest Metrics Endpoint ---
@app.get("/metrics/latest")
def get_latest_metrics(limit: int = Query(10, ge=1, le=100)):
    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT symbol, price, rolling_avg_20, return, volatility, trade_time
                FROM crypto_metrics
                ORDER BY id DESC
                LIMIT %s
            """, (limit,))
            
            rows = cursor.fetchall()

    return [
        {
            "symbol": row[0],
            "price": row[1],
            "rolling_avg_20": row[2],
            "return": row[3],
            "volatility": row[4],
            "trade_time": row[5].isoformat()
        }
        for row in rows
    ]
