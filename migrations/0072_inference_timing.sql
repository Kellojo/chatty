-- 0072_inference_timing.sql
-- Model speed per logged inference step, for tokens/sec stats. NULL on rows
-- logged before this, on failed calls, and on calls that were not timed.
--   ttft_ms   : model call start -> first generated token (prompt processing + network)
--   decode_ms : first generated token -> model call end (generation)

ALTER TABLE proxy_requests ADD COLUMN ttft_ms INTEGER;
ALTER TABLE proxy_requests ADD COLUMN decode_ms INTEGER;
