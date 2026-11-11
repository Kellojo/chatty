-- Web Push subscriptions: one row per browser/device that turned on push. The
-- server sends notices to these through the browser's push service (FCM, APNs,
-- Mozilla), so they arrive while Chatty is closed. A subscription the push
-- service reports gone (404/410) is deleted.
CREATE TABLE push_subscriptions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
	endpoint TEXT NOT NULL UNIQUE,
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL,
	user_agent TEXT,
	created_at INTEGER NOT NULL,
	last_success_at INTEGER,
	failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

-- The server's generated VAPID key pair, when none is set in the environment.
-- Kept out of `settings` (which the settings MCP lists) with the private key
-- encrypted by the app secret. One row; replacing it would orphan every
-- subscription, since browsers bind them to the public key.
CREATE TABLE push_vapid_keys (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	public_key TEXT NOT NULL,
	private_key_encrypted TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
