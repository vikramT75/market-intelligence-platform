-- Add Sharpe ratio and max drawdown columns
ALTER TABLE crypto_metrics
ADD COLUMN IF NOT EXISTS sharpe NUMERIC,
ADD COLUMN IF NOT EXISTS max_drawdown NUMERIC;