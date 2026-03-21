-- ── Option A: Migrate existing table ─────────────────────────────────────
ALTER TABLE crypto_metrics
ADD COLUMN IF NOT EXISTS rsi NUMERIC,
ADD COLUMN IF NOT EXISTS volume NUMERIC,
ADD COLUMN IF NOT EXISTS trade_count INTEGER,
ADD COLUMN IF NOT EXISTS change_24h_pct NUMERIC;

-- ── Option B: Fresh table (drop old one first if needed) ──────────────────
-- DROP TABLE IF EXISTS crypto_metrics;
-- CREATE TABLE crypto_metrics (
--   id              SERIAL PRIMARY KEY,
--   symbol          VARCHAR(20)  NOT NULL,
--   price           NUMERIC      NOT NULL,
--   rolling_avg_20  NUMERIC,
--   return          NUMERIC,
--   volatility      NUMERIC,
--   rsi             NUMERIC,
--   volume          NUMERIC,
--   trade_count     INTEGER,
--   change_24h_pct  NUMERIC,
--   trade_time      TIMESTAMP    NOT NULL
-- );

CREATE INDEX IF NOT EXISTS idx_metrics_symbol_time ON crypto_metrics (symbol, trade_time DESC);