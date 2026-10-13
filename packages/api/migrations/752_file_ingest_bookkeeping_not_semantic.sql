-- 752_file_ingest_bookkeeping_not_semantic.sql  (OPEN table -> use-brian/packages/api/migrations/)
--
-- File ingest stopped holding its own output.
--
-- The file-ingest worker publishes file_segments against the parent file's
-- current scope_version, then writes two bookkeeping fields on that parent:
-- `metadata.indexing` (the ready stamp, artifact-index.ts setFileIndexing) and
-- `source_episode_id` (the Pipeline B back-reference). 635's versioning used
-- 631's entity projection, which excludes neither, so each stamp advanced the
-- file version and `invalidate_derived_file` held every descendant derived
-- from the earlier version - i.e. the segments the same job had just written.
-- 643's `media_scope_holding` policy then hid them, and its live-parent policy
-- rejects them anyway because their lineage names a superseded file version.
-- Since 643, every ingested document was unreadable: searchFileContent reported
-- "zero indexed segments" for files whose text was extracted and embedded.
--
-- 1. Versioning: a file-specific semantic projection that also ignores the
--    ingest bookkeeping. A real edit (path, name, bytes, labels, tags, the rest
--    of metadata) still advances the version and holds descendants.
-- 2. Repair: re-publish the existing segment text through the canonical
--    `publish_media_segments` (replace mode), against the file's CURRENT
--    version, only where the version gap since publication is fully explained
--    by the ingest job's own bookkeeping writes: the ready stamp (+1), a source
--    episode stamp (+1), and the worker-side truncation re-stamp (+1). Any other
--    gap means something else changed the file; those stay held and are fixed
--    by re-ingesting the file. Each file is its own subtransaction, so one
--    refusal (e.g. the creator lost access) is reported and skipped rather than
--    aborting the deploy. Republished segments re-embed through the drain.
--    The repair is a one-shot DO block, never a reusable function (see below).
--
-- See docs/architecture/brain/file-artifacts.md -> "Ingest bookkeeping is not a
-- file change".

BEGIN;

CREATE FUNCTION file_scope_semantic_row(r jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(r->'metadata')='object'
    THEN jsonb_set(entity_scope_semantic_row(r)-'source_episode_id','{metadata}',(r->'metadata')-'indexing')
    ELSE entity_scope_semantic_row(r)-'source_episode_id' END
$$;
REVOKE ALL ON FUNCTION file_scope_semantic_row(jsonb) FROM PUBLIC;

-- Same bodies as 635, with the file projection. Triggers keep their bindings.
CREATE OR REPLACE FUNCTION advance_derived_file_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF file_scope_semantic_row(to_jsonb(NEW)) IS DISTINCT FROM file_scope_semantic_row(to_jsonb(OLD))
    THEN NEW.scope_version:=OLD.scope_version+1;
  ELSE NEW.scope_version:=OLD.scope_version; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION invalidate_derived_file() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
      PERFORM hold_scope_descendants(OLD.workspace_id,'workspace_file',OLD.id);
    END IF;
    RETURN OLD;
  ELSIF (file_scope_semantic_row(to_jsonb(NEW))-'scope_held')
    IS DISTINCT FROM (file_scope_semantic_row(to_jsonb(OLD))-'scope_held')
    OR (NOT OLD.scope_held AND NEW.scope_held AND pg_trigger_depth()=1) THEN
    PERFORM hold_scope_descendants(OLD.workspace_id,'workspace_file',OLD.id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION advance_derived_file_version(),invalidate_derived_file() FROM PUBLIC;

-- One-shot, in the same transaction as the trigger change: the version-gap
-- rule below only describes files ingested under the OLD versioning (where the
-- ready stamp advanced the version). Do not lift it into a reusable function -
-- after this migration a single real edit produces the same gap.
DO $$
DECLARE c record; expected jsonb; segs jsonb; n integer:=0;
BEGIN
  FOR c IN
    WITH live AS (
      SELECT s.file_id, s.workspace_id, bool_and(s.scope_held) all_held,
             min(ds.source_version::bigint) lo, max(ds.source_version::bigint) hi,
             (array_agg(s.created_by_user_id ORDER BY s.segment_index))[1] creator
        FROM file_segments s
        JOIN scope_derivations d ON d.workspace_id=s.workspace_id AND d.resource_kind='file_segment' AND d.resource_id=s.id
        JOIN scope_derivation_sources ds ON ds.derivation_id=d.id AND ds.source_kind='workspace_file' AND ds.source_id=s.file_id
       WHERE s.valid_to IS NULL AND s.retracted_at IS NULL AND ds.source_version ~ '^[0-9]+$'
       GROUP BY s.file_id, s.workspace_id)
    SELECT f.id, f.workspace_id, l.creator
      FROM live l JOIN workspace_files f ON f.id=l.file_id AND f.workspace_id=l.workspace_id
     WHERE l.all_held AND l.lo=l.hi
       AND f.valid_to IS NULL AND f.retracted_at IS NULL AND NOT f.scope_held
       AND NOT scope_review_state_held('workspace_file',f.id)
       AND f.metadata->'indexing'->>'status'='ready'
       AND f.scope_version-l.hi = 1 + (f.source_episode_id IS NOT NULL)::int
         + (coalesce(f.metadata->'indexing'->>'truncatedAtChar','')='2000000')::int
  LOOP
    BEGIN
      PERFORM set_config('app.current_user_id',coalesce(c.creator::text,''),true);
      expected:=read_entity_derivation_source(c.workspace_id,'workspace_file',c.id);
      IF expected IS NULL THEN RAISE EXCEPTION 'file_source_unavailable'; END IF;
      SELECT jsonb_agg(jsonb_build_object('segmentIndex',segment_index,'charStart',char_start,'charEnd',char_end,
               'headingPath',to_jsonb(coalesce(heading_path,'{}'::text[])),'content',content) ORDER BY segment_index)
        INTO segs FROM file_segments WHERE file_id=c.id AND workspace_id=c.workspace_id AND valid_to IS NULL AND retracted_at IS NULL;
      PERFORM publish_media_segments(expected,NULL,NULL,NULL,segs,true);
      n:=n+1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'file % segments left held: %', c.id, SQLERRM;
    END;
  END LOOP;
  PERFORM set_config('app.current_user_id','',true);
  RAISE NOTICE 'republished held file segments for % file(s)', n;
END $$;

COMMIT;
