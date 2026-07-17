-- 334_tasks_source_start_ms.sql
--
-- The moment a task was committed to -- Fathom's actual lesson, cashed in: an
-- action item is a POINTER INTO THE RECORDING, not a detached string.
--
-- `tasks.source_episode_id` already answers "which recording did this come
-- from" (migration 331 made `recordings.id` the anchor Episode id, so it
-- resolves to a recording directly). This answers "WHERE in it": a task
-- extracted from a meeting brief renders "47:21" and deep-links to
-- `/w/<ws>/recordings/<id>#t=2841`, the same target the brief's `[0:47:21]`
-- citation seeks to.
--
-- WHY A COLUMN, not `attributes`.
--   `attributes` is jsonb and already there, so it looks free. It is the wrong
--   home twice over. (1) It is a USER-DEFINED free-form bag (sprint estimates,
--   ordering, velocity) and `updateTask` OVERWRITES THE WHOLE OBJECT by design
--   -- its own tool description says so -- so any ordinary attributes edit
--   would silently wipe the provenance. (2) Provenance on this table already
--   lives in columns: `source`, `source_episode_id`, `source_session_id`,
--   `created_by_assistant_id`. This is that same axis and belongs beside them,
--   not in the bag the user owns.
--
-- Nullable and unconstrained-by-default: only a recording-sourced task has a
-- moment, which is nearly none of them. The CHECK keeps a nonsense value
-- (negative) out without pretending we know the recording's length here --
-- that validation happens at the write boundary, against the transcript
-- itself (packages/shared/src/transcript-citations.ts).
--
-- Store: sidanclaw/packages/core/src/tasks/types.ts (TaskStore.create) +
-- the db impl. Spec: docs/architecture/features/tasks.md -> "Source moment".

BEGIN;

ALTER TABLE public.tasks
    ADD COLUMN source_start_ms integer,
    ADD CONSTRAINT tasks_source_start_ms_check
        CHECK (source_start_ms IS NULL OR source_start_ms >= 0);

COMMENT ON COLUMN public.tasks.source_start_ms IS
    'Offset into `source_episode_id`''s recording where this task was committed to. NULL for every non-recording task. Provenance -- a column, not `attributes`, which updateTask overwrites wholesale.';

COMMIT;
