CREATE TABLE IF NOT EXISTS crypto_metrics (
    id               SERIAL PRIMARY KEY,
    symbol           VARCHAR(20)  NOT NULL,
    price            NUMERIC      NOT NULL,
    rolling_avg_20   NUMERIC,
    return           NUMERIC,
    volatility       NUMERIC,
    rsi              NUMERIC,
    volume           NUMERIC,
    trade_count      INTEGER,
    change_24h_pct   NUMERIC,
    sharpe           NUMERIC,
    max_drawdown     NUMERIC,
    signal           VARCHAR(10),
    signal_strength  VARCHAR(10),
    trade_time       TIMESTAMP    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_symbol_time
    ON crypto_metrics (symbol, trade_time DESC);
