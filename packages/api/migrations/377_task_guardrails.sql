-- 377_task_guardrails.sql  (OPEN tables -> use-brian/packages/api/migrations/)
--
-- Task admission guardrails: rules, tombstones, and the held-candidate tray.
-- Spec: docs/architecture/features/task-guardrails.md
--
-- WHY. Task extraction over-produces. The Pipeline B precedence ladder puts
-- Task at tier 1 with first-fit-wins, so any imperative-sounding line becomes a
-- `todo`. On 2026-07-27 one Slack conversation minted 20 tasks in five minutes
-- in workspace 3ccdb5fe, including three near-copies of "revise the daily
-- standup workflow" — one of which the assistant had already created hours
-- earlier through `saveTask`. The 2026-07-23 lane gate
-- (RETROSPECTIVE_SOURCE_KINDS) fixed a whole-source class; this fixes the
-- residual per-item problem, which is workspace-specific and therefore has to
-- be something the workspace can state rather than a constant in the repo.
--
-- WHY TRIGRAM AND NOT EMBEDDINGS. The earlier plan
-- (docs/plans/github-task-extraction-fix.md P2) specified a
-- `tasks.embedding VECTOR(768)` column plus a backfill worker. Measured against
-- the real duplicates, trigram similarity separates them for free:
--
--   'Integrate Shopify'              / 'integrate shopify'                 -> 1.00  dup
--   'Revise daily standup workflow'  / 'Revise the daily standup workflow' -> 0.88  dup
--   'Fix GitHub integration 401…'    / 'Resolve GitHub connector 401…'     -> 0.67  dup
--   'Start trial with Erwin (…)'     / 'Start trial with Ashley (…)'       -> 0.59  NOT
--
-- The 0.59/0.67 gap is too thin for a single threshold, so the middle band
-- holds for review instead of dropping. No model call, no vector column, no
-- worker, synchronous inside the write path. Embeddings stay the upgrade path:
-- only the store's findSimilarTasks implementation would move.
--
-- Filenames are globally unique across BOTH migration dirs (one shared
-- _migrations table). Next free number after this is 378.

BEGIN;

-- Idempotent: already present on the platform databases; keeps a fresh/OSS
-- database self-sufficient (same posture as migration 336).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── task_rules ──────────────────────────────────────────────────────────────
-- User-authored admission policy. Authored in natural language by the
-- assistant (`saveTaskRule`), which compiles the sentence into `predicate`
-- ONCE at authoring time and keeps the sentence in `nl_clause`. The predicate
-- is what the gate enforces; the sentence is what the extraction prompt sees.
-- Neither is derived from the other at runtime, so the stored row stays
-- something the user can read, toggle, and delete.

CREATE TABLE IF NOT EXISTS task_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- `proposed` rules are INERT — inserted by the tombstone-cluster proposer,
  -- enforced only after the user activates them. A wrong auto-rule suppresses
  -- a whole category of real work invisibly.
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'proposed', 'disabled')),
  effect             text NOT NULL CHECK (effect IN ('deny', 'require')),
  -- {source_kinds?, lanes?, title_matches?, channel_refs?, require?}
  -- Conditions AND together; a list within a condition ORs. An empty predicate
  -- on a deny rule would deny everything — rejected at the store boundary, not
  -- here, so the error message can explain itself.
  predicate          jsonb NOT NULL DEFAULT '{}'::jsonb,
  nl_clause          text,
  reason             text,
  origin             text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'proposed')),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_rules_workspace_status
  ON task_rules (workspace_id, status);

-- ── task_tombstones ─────────────────────────────────────────────────────────
-- A user's explicit "this was not a task, and here is why". Written by
-- `rejectTask` / the brain-inbox DELETE-with-reason. Blocks near-identical
-- re-creation immediately and permanently.
--
-- This is the guard corrections.md §"Re-extraction protection" specified but
-- never wired: `findRetractedMatch` shipped with tests and zero callers, and
-- its source_episode_id key would not have caught the 07-27 duplicates anyway
-- because those came from DIFFERENT episodes. Workspace-scoped and
-- similarity-matched is the level the failure actually occurs at.

CREATE TABLE IF NOT EXISTS task_tombstones (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title              text NOT NULL,
  -- normalizeTaskTitle(title) — lowercased, punctuation collapsed. The
  -- similarity lookup runs against this, never the raw title.
  title_norm         text NOT NULL,
  -- Required. A rejection without a reason teaches nothing, and the reason is
  -- what the extraction prompt shows the model as a negative example.
  reason             text NOT NULL,
  source_kind        text,
  lane               text CHECK (lane IS NULL OR lane IN ('extracted', 'assistant')),
  -- No FK: the task row may later be purged by retention, and losing the
  -- tombstone with it would un-teach the lesson.
  original_task_id   uuid,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Tombstones do NOT expire — a rejection is a standing decision. Deleting the
-- row is how a user un-teaches one.
CREATE INDEX IF NOT EXISTS idx_task_tombstones_workspace
  ON task_tombstones (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_tombstones_title_trgm
  ON task_tombstones USING gin (title_norm gin_trgm_ops);

-- ── task_candidates ─────────────────────────────────────────────────────────
-- Both the suggestions tray (status='pending') and the "why didn't this become
-- a task?" audit log (status='dropped'). One table because they are the same
-- event recorded at two confidence levels, and splitting them would mean
-- joining them back together for every diagnostic query.

CREATE TABLE IF NOT EXISTS task_candidates (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title                   text NOT NULL,
  due                     timestamptz,
  source_kind             text,
  lane                    text NOT NULL CHECK (lane IN ('extracted', 'assistant')),
  source_episode_id       uuid,
  created_by_assistant_id uuid,
  status                  text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'accepted', 'dismissed', 'expired', 'dropped')),
  reason_code             text NOT NULL
                            CHECK (reason_code IN ('tombstoned', 'rule', 'rule_requires', 'duplicate', 'near_duplicate')),
  matched_task_id         uuid,
  matched_rule_id         uuid,
  matched_tombstone_id    uuid,
  -- The measured trigram score, when the reason is similarity-based. Makes
  -- threshold tuning empirical instead of a guess.
  similarity              real,
  -- Held: created_at + 14d. Dropped: created_at + 90d. Without expiry the tray
  -- becomes the new task list — the same failure one layer down.
  expires_at              timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  resolved_at             timestamptz,
  resolved_by_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_task_id         uuid
);

CREATE INDEX IF NOT EXISTS idx_task_candidates_tray
  ON task_candidates (workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_candidates_sweep
  ON task_candidates (expires_at)
  WHERE status IN ('pending', 'dropped');

-- ── tasks.title trigram ─────────────────────────────────────────────────────
-- The duplicate lookup runs `similarity(lower(title), $1)` over the
-- workspace's live open tasks on every admission decision. Without this it is
-- a sequential scan of the workspace's task history per extracted item.

CREATE INDEX IF NOT EXISTS idx_tasks_title_trgm
  ON tasks USING gin (title gin_trgm_ops);

-- ── updated_at trigger (task_rules) ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION task_rules_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_rules_set_updated_at_trg ON task_rules;
CREATE TRIGGER task_rules_set_updated_at_trg
  BEFORE UPDATE ON task_rules
  FOR EACH ROW EXECUTE FUNCTION task_rules_set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Same shape as `tasks` (workspace member reads + writes, default-true system
-- bypass so bare query() calls pass through and queryWithRLS() disables it).

ALTER TABLE task_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE task_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE task_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_candidates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_rules_workspace_member ON task_rules;
CREATE POLICY task_rules_workspace_member ON task_rules
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
  ));

DROP POLICY IF EXISTS task_rules_system_bypass ON task_rules;
CREATE POLICY task_rules_system_bypass ON task_rules
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');

DROP POLICY IF EXISTS task_tombstones_workspace_member ON task_tombstones;
CREATE POLICY task_tombstones_workspace_member ON task_tombstones
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
  ));

DROP POLICY IF EXISTS task_tombstones_system_bypass ON task_tombstones;
CREATE POLICY task_tombstones_system_bypass ON task_tombstones
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');

DROP POLICY IF EXISTS task_candidates_workspace_member ON task_candidates;
CREATE POLICY task_candidates_workspace_member ON task_candidates
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
  ));

DROP POLICY IF EXISTS task_candidates_system_bypass ON task_candidates;
CREATE POLICY task_candidates_system_bypass ON task_candidates
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');

COMMIT;
