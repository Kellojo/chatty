-- 0056_coding_usage_reset_credits.sql
-- Extra resets ("reset credits") a provider account can redeem to refill its limits early,
-- as T3 Code reports them (`usageLimits.resetCredits`). Latest snapshot per account,
-- replaced on each sync like coding_usage_limits.

CREATE TABLE coding_usage_reset_credits (
  environment_id TEXT NOT NULL REFERENCES coding_environments(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,                     -- provider instance id on the remote server
  available_count INTEGER NOT NULL,
  next_expires_at INTEGER,                      -- when the soonest-expiring credit lapses
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, account_id)
);
