-- Companion to 616: partial indexes so the column walk stays an index lookup
-- as the two large versioned source tables grow (616's hash join is already
-- milliseconds at today's sizes). Built CONCURRENTLY, outside a transaction,
-- because a plain CREATE INDEX takes a SHARE lock on `entities`: on a database
-- where a compose UPDATE is mid-flight it would wait behind that statement
-- (up to the 120 s background timeout) and queue every other entities write
-- behind itself for the whole wait. `tasks` already carries
-- idx_tasks_privacy_superseded_by (511); workspace_files and kb_chunks are
-- small enough that the hash join is the plan either way.
-- No BEGIN/COMMIT on purpose: the migrator sends each statement on its own.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entities_workspace_superseded_by
  ON entities(workspace_id, superseded_by) WHERE superseded_by IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memories_workspace_superseded_by
  ON memories(workspace_id, superseded_by) WHERE superseded_by IS NOT NULL;
