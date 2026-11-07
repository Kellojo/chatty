-- Last known state of a coding task's pull request (open, draft, merged,
-- closed), mirrored from T3. NULL when there is no PR or it isn't known yet.
ALTER TABLE coding_conversations ADD COLUMN pr_state TEXT;
