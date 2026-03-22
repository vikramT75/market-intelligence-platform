-- Add signal columns
ALTER TABLE crypto_metrics
ADD COLUMN IF NOT EXISTS signal VARCHAR(10),
ADD COLUMN IF NOT EXISTS signal_strength VARCHAR(10);