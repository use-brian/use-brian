BEGIN;

-- Feed revamp 3 (docs/plans/feed-revamp-depth.md D24-D42): calendar depth,
-- brand in the composer, media on a post.

-- D41. LinkedIn reached the planning platform union in migration 392, but that
-- migration only widened content_planning_drafts. content_plan_slots kept the
-- original four-platform CHECK, so a LinkedIn plan slot is a LIVE 500 today:
-- the slot editor offers the chip (FEED_PLATFORMS), the route accepts it
-- (isContentPlanPlatform reads CONTENT_PLANNING_PLATFORMS, which includes
-- linkedin), and only the INSERT fails. Align the two tables.
ALTER TABLE content_plan_slots
  DROP CONSTRAINT IF EXISTS content_plan_slots_platform_check,
  ADD CONSTRAINT content_plan_slots_platform_check
  CHECK (platform IN ('instagram', 'threads', 'twitter', 'xhs', 'linkedin'));

-- D26. Time of day as MINUTES PAST LOCAL MIDNIGHT, never a timestamp.
-- `scheduled_for` (a date) remains the sole authority for WHICH DAY, so no
-- value stored here can shift a slot across a day boundary for an operator in
-- another timezone -- the exact drift feed-revamp.md section 4 rejected
-- timestamptz over. This is a wall-clock LABEL on a named day, not an instant:
-- there is no offset, no DST arithmetic, and no AT TIME ZONE in the read path.
-- Automatic posting stays a non-goal; if it is ever built it brings its own
-- timestamptz publish_at plus a workspace timezone, resolved at schedule time.
-- NULL is first-class and the default: most slots are "that day, no time".
ALTER TABLE content_plan_slots
  ADD COLUMN IF NOT EXISTS scheduled_minute smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'content_plan_slots_scheduled_minute_check'
       AND conrelid = 'content_plan_slots'::regclass
  ) THEN
    ALTER TABLE content_plan_slots
      ADD CONSTRAINT content_plan_slots_scheduled_minute_check
      CHECK (scheduled_minute IS NULL
             OR (scheduled_minute >= 0 AND scheduled_minute < 1440));
  END IF;
END
$$;

-- D28. Cadence: how many posts a week this month's plan intends. An integer,
-- not prose, because the calendar's dashed "gap" ghosts must be DERIVABLE from
-- it in a pure client-side function, and because it is the target count for the
-- opt-in fill-empty-slots action (D30). Ceiling of 21 = 3/day. The ghost never
-- creates anything on its own; this column drives no engine.
ALTER TABLE content_plan_briefs
  ADD COLUMN IF NOT EXISTS cadence_per_week smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'content_plan_briefs_cadence_per_week_check'
       AND conrelid = 'content_plan_briefs'::regclass
  ) THEN
    ALTER TABLE content_plan_briefs
      ADD CONSTRAINT content_plan_briefs_cadence_per_week_check
      CHECK (cadence_per_week IS NULL
             OR (cadence_per_week > 0 AND cadence_per_week <= 21));
  END IF;
END
$$;

-- D32. Media bound to a draft: [{fileId, mimeType, alt?}], where fileId
-- references workspace_files.id -- the same binding convention the brand record
-- uses for logo variants (an id, never a path).
--
-- Its OWN column rather than a key inside format_data: saveDraft rewrites
-- format_data wholesale from post_format, so media stored there would be
-- silently erased the moment an operator switched a post between Post and
-- Thread. Hosted stores the same array at distribution_events.metadata.media,
-- which needs no migration.
ALTER TABLE content_planning_drafts
  ADD COLUMN IF NOT EXISTS media jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
