-- Ties each push subscription to the session that turned it on: revoking or
-- signing out that session deletes the subscription, and an expired session
-- stops deliveries, so a lost or handed-on phone stops showing your chats.
-- Rows from before this have no session and receive nothing until the device
-- re-registers (it does on its next app start).
ALTER TABLE push_subscriptions ADD COLUMN session_id TEXT REFERENCES "session"(id) ON DELETE CASCADE;

CREATE INDEX idx_push_subscriptions_session ON push_subscriptions(session_id);
