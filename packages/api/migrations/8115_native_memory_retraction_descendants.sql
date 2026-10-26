BEGIN;
-- [COMP:corrections/retraction-store] Factual invalidation keeps every hold.
-- A successor can be its own derived descendant through original predecessors.
-- Let the base row update finish before the unchanged holder updates that row.
DO $retraction_before_order$
DECLARE definition text;before text;metadata jsonb;
BEGIN
 SELECT to_jsonb(p)-'prosrc' INTO metadata FROM pg_proc p WHERE oid='public.advance_memory_scope_version()'::regprocedure;
 definition:=pg_get_functiondef('public.advance_memory_scope_version()'::regprocedure);
 before:=$before$    NEW.scope_version := OLD.scope_version + 1;
    PERFORM hold_scope_descendants(OLD.workspace_id,'memory',OLD.id);$before$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory invalidation order prerequisite changed';END IF;
 definition:=replace(definition,before,$after$    NEW.scope_version := OLD.scope_version + 1;
    IF NOT (OLD.retracted_at IS NULL AND NEW.retracted_at IS NOT NULL
      AND (to_jsonb(NEW)-ARRAY['retracted_at','retracted_reason','retracted_by','valid_to','scope_version','updated_at'])
        IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['retracted_at','retracted_reason','retracted_by','valid_to','scope_version','updated_at'])) THEN
      PERFORM hold_scope_descendants(OLD.workspace_id,'memory',OLD.id);
    END IF;$after$);
 EXECUTE definition;
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid='public.advance_memory_scope_version()'::regprocedure) IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'Memory invalidation metadata changed';END IF;
END $retraction_before_order$;

CREATE FUNCTION invalidate_retracted_memory_descendants() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.retracted_at IS NULL AND NEW.retracted_at IS NOT NULL
  AND (to_jsonb(NEW)-ARRAY['retracted_at','retracted_reason','retracted_by','valid_to','scope_version','updated_at'])
    IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['retracted_at','retracted_reason','retracted_by','valid_to','scope_version','updated_at'])
  AND NEW.scope_version=OLD.scope_version+1 THEN
  PERFORM hold_scope_descendants(OLD.workspace_id,'memory',OLD.id);
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION invalidate_retracted_memory_descendants() FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON FUNCTION invalidate_retracted_memory_descendants() FROM app_user;
END IF;END $$;
CREATE TRIGGER memories_retraction_descendants AFTER UPDATE ON memories
 FOR EACH ROW EXECUTE FUNCTION invalidate_retracted_memory_descendants();
COMMIT;
