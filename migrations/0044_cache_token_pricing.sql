-- 0044_cache_token_pricing.sql
-- Separate prices (USD per 1M tokens) for prompt-cache reads and writes. NULL
-- falls back to the regular input price, so existing costs are unchanged until
-- these are set. Proxy/agent request logs also keep the cached token counts.

ALTER TABLE models ADD COLUMN price_cache_read REAL;
ALTER TABLE models ADD COLUMN price_cache_write REAL;

ALTER TABLE proxy_requests ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE proxy_requests ADD COLUMN cache_write_tokens INTEGER;
