-- 0057_drop_caveman.sql
-- Caveman mode (proxy prompt compression) was removed: drop its per-request metadata
-- and the per-user settings it kept.

ALTER TABLE proxy_requests DROP COLUMN compression;

DELETE FROM user_settings WHERE key IN ('proxyCaveman', 'cavemanBaseline');
