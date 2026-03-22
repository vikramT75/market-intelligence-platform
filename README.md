# Market Intelligence Platform

A production-style real-time crypto analytics platform built on a streaming data pipeline. Ingests live trade data from Binance, processes it through Apache Kafka, computes technical indicators and quant metrics, and serves everything through a FastAPI backend to a React dashboard.

---

## Features

- **Live price feed** — WebSocket connection to Binance streaming API
- **Real-time metrics** — Rolling average, volatility, RSI (14), volume, trade count, 24h change
- **Quant analytics** — Sharpe ratio, max drawdown
- **Signal generation** — Buy/sell signals from MA crossover + RSI extremes, plotted as markers on the price chart
- **Candlestick chart** — TradingView lightweight-charts with 1m / 5m / 15m / 1h timeframes
- **Resizable dashboard** — 2-panel grid layout with draggable divider, custom scrollbars
- **Full Docker stack** — Single `docker-compose up --build` starts everything

---

## Architecture

```
Binance WebSocket
       │
       ▼
 binance_stream.py  ──► Kafka (crypto_trades topic)
                               │
                               ▼
                      metrics_worker.py
                      ├── Rolling avg, RSI, volatility
                      ├── Sharpe ratio, max drawdown
                      ├── Buy/sell signal generation
                      ├── Kafka (crypto_metrics topic) ──► FastAPI WebSocket ──► React
                      └── PostgreSQL (batch writes)
                                         │
                                         ▼
                                   FastAPI REST API
                                   ├── /metrics/latest
                                   ├── /metrics/history
                                   ├── /metrics/candles
                                   ├── /metrics/summary
                                   ├── /symbols
                                   └── /ws/{symbol}
```

---

## Tech Stack

| Layer             | Technology                                             |
| ----------------- | ------------------------------------------------------ |
| Ingestion         | Python, `websockets`, Binance WS API                   |
| Message broker    | Apache Kafka (Confluent 7.5)                           |
| Stream processing | Python, `kafka-python`                                 |
| Storage           | PostgreSQL 15                                          |
| Backend           | FastAPI, Uvicorn, psycopg2                             |
| Frontend          | React (Vite), Recharts, TradingView lightweight-charts |
| Infrastructure    | Docker, Docker Compose, Nginx                          |

---

## Project Structure

```
market-intelligence-platform/
│
├── .env                          # Local dev config (gitignored)
├── .env.docker                   # Docker config (committed)
├── docker-compose.yml
├── requirements.txt
│
├── backend/
│   └── main.py                   # FastAPI app — REST + WebSocket
│
├── ingestion/
│   └── binance_stream.py         # Binance WS → Kafka producer
│
├── stream-processing/
│   └── metrics_worker.py         # Kafka consumer → metrics + signals → DB
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx               # Main dashboard component
│   │   ├── main.jsx
│   │   ├── App.css
│   │   └── index.css
│   ├── index.html
│   ├── package.json
│   └── .env.production           # VITE_API_URL for production builds
│
├── database/
│   ├── init.sql                  # Auto-runs on fresh Postgres boot
│   ├── migrate.sql               # v1 — base schema
│   ├── migrate_v2.sql            # v2 — sharpe, max_drawdown
│   └── migrate_v3.sql            # v3 — signal, signal_strength
│
├── infrastructure/
│   ├── Dockerfile.backend
│   ├── Dockerfile.worker
│   ├── Dockerfile.ingestion
│   ├── Dockerfile.frontend
│   └── nginx.conf
│
└── docs/
    └── design-decisions.md
```

---

## Getting Started

### Prerequisites

- Docker + Docker Compose
- OR Python 3.12+, Node 20+, PostgreSQL 15, Kafka (for local dev)

---

### Option A — Docker (recommended)

**1. Clone the repo**

```bash
git clone https://github.com/vikramT75/market-intelligence-platform.git
cd market-intelligence-platform
```

**2. Create your local `.env`** (copy from `.env.docker` and change hosts to `localhost`)

```bash
cp .env.docker .env
```

Then edit `.env` and set:

```
DB_HOST=localhost
KAFKA_BOOTSTRAP_SERVERS=localhost:9092
```

**3. Start the full stack**

```bash
docker-compose up --build
```

**4. Open the dashboard**

```
http://localhost
```

All services start automatically in the correct order.

---

### Option B — Local Development

**1. Start infrastructure**

```bash
docker-compose up -d zookeeper kafka postgres
```

**2. Install Python dependencies**

```bash
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

**3. Run the DB migration** (first time only)

```bash
psql -U market -d marketdb -f database/migrate.sql
psql -U market -d marketdb -f database/migrate_v2.sql
psql -U market -d marketdb -f database/migrate_v3.sql
```

**4. Start each service in a separate terminal**

```bash
# Terminal 1 — Backend
cd backend && uvicorn main:app --reload

# Terminal 2 — Stream processor
cd stream-processing && python metrics_worker.py

# Terminal 3 — Ingestion
cd ingestion && python binance_stream.py btcusdt

# Terminal 4 — Frontend
cd frontend && npm install && npm run dev
```

**5. Open the dashboard**

```
http://localhost:5173
```

---

## Configuration

All configuration is via environment variables in `.env` (local) or `.env.docker` (Docker).

| Variable                  | Default          | Description                 |
| ------------------------- | ---------------- | --------------------------- |
| `DB_HOST`                 | `localhost`      | PostgreSQL host             |
| `DB_NAME`                 | `marketdb`       | Database name               |
| `DB_USER`                 | `market`         | Database user               |
| `DB_PASSWORD`             | `marketpass`     | Database password           |
| `DB_PORT`                 | `5432`           | Database port               |
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | Kafka broker address        |
| `KAFKA_TRADES_TOPIC`      | `crypto_trades`  | Raw trades topic            |
| `KAFKA_METRICS_TOPIC`     | `crypto_metrics` | Computed metrics topic      |
| `DEFAULT_SYMBOL`          | `btcusdt`        | Default trading pair        |
| `BATCH_SIZE`              | `20`             | DB batch write size         |
| `BATCH_FLUSH_INTERVAL`    | `5`              | DB flush interval (seconds) |

---

## API Reference

| Method | Endpoint           | Description                               |
| ------ | ------------------ | ----------------------------------------- |
| `GET`  | `/`                | Health check                              |
| `GET`  | `/health`          | Service status                            |
| `GET`  | `/symbols`         | List all tracked symbols                  |
| `GET`  | `/metrics/latest`  | Latest N rows, filterable by symbol       |
| `GET`  | `/metrics/history` | Historical data between timestamps        |
| `GET`  | `/metrics/candles` | OHLCV candles by timeframe (1m/5m/15m/1h) |
| `GET`  | `/metrics/summary` | Latest row per symbol                     |
| `WS`   | `/ws/{symbol}`     | Live metrics WebSocket stream             |

---

## Signal Logic

Signals are generated in `metrics_worker.py` from two independent systems:

**MA Deviation** — fires when price moves more than 0.015% above/below the 20-trade rolling average (filters out micro-oscillations at high tick frequency)

**RSI Extreme** — RSI < 30 → oversold → BUY, RSI > 70 → overbought → SELL

**Combined output:**

| MA Signal   | RSI Signal  | Result        |
| ----------- | ----------- | ------------- |
| BUY         | BUY         | `BUY STRONG`  |
| SELL        | SELL        | `SELL STRONG` |
| BUY         | NEUTRAL     | `BUY WEAK`    |
| SELL        | NEUTRAL     | `SELL WEAK`   |
| Conflicting | Conflicting | `NEUTRAL`     |

---

## Adding More Symbols

The architecture supports multiple symbols. To add ETH:

```bash
# Run a second ingestion instance
cd ingestion && python binance_stream.py ethusdt
```

The worker handles all symbols automatically. The frontend will pick up the new symbol from `/symbols` and show it as a button.

---

## Roadmap

- [x] Live market data ingestion
- [x] Kafka streaming pipeline
- [x] Real-time metrics computation
- [x] Historical storage (PostgreSQL)
- [x] FastAPI backend + WebSocket
- [x] React dashboard
- [x] RSI, volume, candlestick sub-charts
- [x] Timeframe selector (1m/5m/15m/1h)
- [x] Sharpe ratio + max drawdown
- [x] Signal generation (MA crossover + RSI)
- [x] Full Docker stack
- [ ] Cloud deployment
- [ ] Multi-symbol support (ETH, SOL, etc.)
- [ ] Alert system (email/Telegram on strong signals)
- [ ] Backtesting engine

---

## License

MIT
