-- 365_tasks_status_in_review.sql
--
-- Add `in_review` to the tasks.status CHECK. A GitHub PR that addresses an
-- issue-derived task (via `Closes #N`) moves that task to `in_review` — a
-- distinct, reversible signal ("work is up for review") between `in_progress`
-- and `done`. Merging the PR advances it to `done`; closing it unmerged
-- reopens it to `todo`. See the GitHub task lifecycle in
-- docs/architecture/brain/ingest-pipeline.md and the plan
-- docs/plans/github-task-extraction-fix.md.
--
-- `status` is a text column with a CHECK (not a Postgres enum), so this is a
-- constraint swap, not `ALTER TYPE`. Existing rows are unaffected — no value
-- is removed, only `in_review` added.

BEGIN;

ALTER TABLE public.tasks
    DROP CONSTRAINT tasks_status_check;

ALTER TABLE public.tasks
    ADD CONSTRAINT tasks_status_check
        CHECK (status = ANY (ARRAY[
            'todo'::text,
            'in_progress'::text,
            'in_review'::text,
            'blocked'::text,
            'done'::text,
            'archived'::text
        ]));

COMMIT;
