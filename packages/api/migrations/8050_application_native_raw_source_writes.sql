BEGIN;
-- [COMP:api/application-records] Restriction-only source admission also applies
-- below typed adapters and to unowned native destinations. Existing canonical
-- row, mutation, field and command predicates remain independently mandatory.
ALTER FUNCTION application_native_entity_field_writes_allowed(uuid,jsonb,text[])
 RENAME TO application_native_entity_field_writes_before_raw_ancestry;
REVOKE ALL ON FUNCTION application_native_entity_field_writes_before_raw_ancestry(uuid,jsonb,text[]) FROM PUBLIC;
CREATE FUNCTION application_native_entity_field_writes_allowed(record_id uuid,patch jsonb,typed_fields text[] DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source record;
BEGIN
 IF application_native_entity_field_writes_before_raw_ancestry(record_id,patch,typed_fields) IS NOT TRUE THEN RETURN false;END IF;
 SELECT e.workspace_id,e.kind,e.scope_version INTO source FROM public.entities e WHERE e.id=record_id;
 IF FOUND AND source.kind IN('company','person','deal') THEN
  RETURN application_canonical_ancestry_allowed(source.workspace_id,'entity',record_id,source.scope_version::text,true);
 END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_entity_field_writes_allowed(uuid,jsonb,text[]) FROM PUBLIC;

-- The existing DELETE field check stays exactly as restrictive as before this
-- UPDATE closure. Privacy erasure must not acquire a read-of-ancestors condition.
DO $migration$
DECLARE definition text;previous text:='public.application_native_entity_field_writes_allowed(canonical.id,''{}''::jsonb,fields)';
BEGIN
 SELECT pg_get_functiondef('public.application_guard_native_entity_fields()'::regprocedure) INTO definition;
 IF position(previous IN definition)=0 THEN RAISE EXCEPTION 'Native field mutation guard changed';END IF;
 EXECUTE replace(definition,previous,'(CASE WHEN TG_OP=''DELETE'' THEN public.application_native_entity_field_writes_before_raw_ancestry(canonical.id,''{}''::jsonb,fields) ELSE public.application_native_entity_field_writes_allowed(canonical.id,''{}''::jsonb,fields) END)');
END $migration$;

-- Hold-only and nonsemantic maintenance must still work when source access is
-- unavailable. The column-specific trigger additionally covers equal business
-- assignments, which the semantic comparison cannot distinguish from a no-op.
CREATE FUNCTION application_guard_native_entity_source_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.kind NOT IN('company','person','deal') AND NEW.kind NOT IN('company','person','deal') THEN RETURN NEW;END IF;
 IF TG_ARGV[0] IS DISTINCT FROM 'business'
  AND (entity_scope_semantic_row(to_jsonb(NEW))-'scope_held') IS NOT DISTINCT FROM (entity_scope_semantic_row(to_jsonb(OLD))-'scope_held')
  AND (NEW.scope_held IS DISTINCT FROM OLD.scope_held OR NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at) THEN RETURN NEW;END IF;
 IF application_canonical_ancestry_allowed(OLD.workspace_id,'entity',OLD.id,OLD.scope_version::text,true) IS NOT TRUE THEN
  RAISE EXCEPTION 'access_unavailable: native source authority unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_guard_native_entity_source_update() FROM PUBLIC;
CREATE TRIGGER application_native_entity_source_update BEFORE UPDATE ON public.entities
 FOR EACH ROW EXECUTE FUNCTION application_guard_native_entity_source_update();
CREATE TRIGGER application_native_entity_source_business BEFORE UPDATE OF
 id,workspace_id,kind,display_name,canonical_id,aliases,attributes,sensitivity,compartments,project_ids,user_id,assistant_id,valid_to,retracted_at
 ON public.entities FOR EACH ROW EXECUTE FUNCTION application_guard_native_entity_source_update('business');
-- Current input authority is re-read after other statements and immediately
-- before commit. No result/allow flag or previous actor is retained or replayed.
CREATE CONSTRAINT TRIGGER application_native_entity_source_commit AFTER UPDATE ON public.entities
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION application_guard_native_entity_source_update();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON FUNCTION application_native_entity_field_writes_before_raw_ancestry(uuid,jsonb,text[]) FROM app_user;
 GRANT EXECUTE ON FUNCTION application_native_entity_field_writes_allowed(uuid,jsonb,text[]) TO app_user;
END IF;END $$;
COMMIT;
