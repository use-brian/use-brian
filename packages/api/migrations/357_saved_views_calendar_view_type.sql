-- 357: widen saved_views.view_type to allow 'calendar'.
--
-- The Q5 views system ships its first calendar binding (tasks/calendar,
-- dateBy 'due'): a `renderView` call or doc data block can now persist a
-- row whose view_type is 'calendar'. The baseline CHECK
-- (saved_views_view_type_check, from 120/000_open_schema_v1) only allowed
-- ('table','board') — widen it in place. Binding validation stays at the
-- application layer (packages/core/src/views/schemas.ts).
--
-- See docs/architecture/features/views.md → "Calendar view".

BEGIN;

ALTER TABLE saved_views
  DROP CONSTRAINT IF EXISTS saved_views_view_type_check;

ALTER TABLE saved_views
  ADD CONSTRAINT saved_views_view_type_check
  CHECK (view_type = ANY (ARRAY['table'::text, 'board'::text, 'calendar'::text]));

COMMIT;
