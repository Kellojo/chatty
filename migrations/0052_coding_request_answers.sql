-- What the user answered to a coding task's questions and approvals, as a JSON
-- object of request id -> answer text. T3 only reports how a request resolved,
-- so Chatty keeps the words itself to show them in the timeline.
ALTER TABLE coding_conversations ADD COLUMN request_answers TEXT;
