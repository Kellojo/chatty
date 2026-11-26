-- Drafts: coding tasks saved while their environment was unreachable (status
-- 'draft'). With auto_start set, the draft starts by itself once the environment
-- answers again; the user can turn it off and start it by hand instead.
ALTER TABLE coding_conversations ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_coding_conversations_auto_start
  ON coding_conversations(environment_id) WHERE status = 'draft' AND auto_start = 1;
