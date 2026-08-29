-- Goal origin session — the chat session a goal was created/armed from.
--
-- Backs in-chat goal pursuit (docs/architecture/features/goals.md → "In-chat
-- pursuit"): the web transcript lists the goals that originated in the open
-- session and renders their live execution inline; the terminal delivery is
-- also persisted back into this session so the conversation records how the
-- pursuit ended.
--
-- Advisory pointer, deliberately NOT a foreign key: tool contexts can carry
-- synthetic session ids (workflow iterations run as `workflow_run_<uuid>`,
-- which is no sessions row), and a deleted thread must not block or cascade
-- into its goals. Writers stamp only UUID-shaped ids from real chat turns; a
-- dangling id is harmless (the transcript that would read it is gone).

BEGIN;

ALTER TABLE goals ADD COLUMN origin_session_id UUID;

CREATE INDEX idx_goals_origin_session
  ON goals (origin_session_id)
  WHERE origin_session_id IS NOT NULL;

COMMIT;
