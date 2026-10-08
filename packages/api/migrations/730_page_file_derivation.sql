BEGIN;
-- [COMP:api/workflow-input-evidence] Register only behind output/read barriers.
ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check CHECK(source_kind IN
 ('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','crm_event','memory_verification','brain_verification','correction_audit','session_message','feedback_event','workspace_skill_revision','knowledge_source','recording','file_segment','transcript_segment','blueprint_record','browser_profile','browser_session','workflow_run',
 'page_event_changed','page_event_destination','page_live_changed','page_live_destination'));

ALTER FUNCTION read_scope_source(uuid,text,uuid) RENAME TO read_scope_source_before_page;
REVOKE ALL ON FUNCTION read_scope_source_before_page(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_scope_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF k IN('page_event_changed','page_event_destination','page_live_changed','page_live_destination') THEN
  RETURN page_scope_source_snapshot(w,k,i)||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);
 END IF;
 RETURN read_scope_source_before_page(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_scope_source(uuid,text,uuid) FROM PUBLIC;

ALTER FUNCTION read_entity_derivation_source(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_page;
REVOKE ALL ON FUNCTION read_entity_derivation_source_before_page(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; source jsonb; admitted jsonb; dependencies jsonb; required jsonb:='[]';
BEGIN
 IF k IN('page_event_changed','page_event_destination','page_live_changed','page_live_destination') THEN RETURN read_page_derivation_source(w,k,i); END IF;
 result:=read_entity_derivation_source_before_page(w,k,i);
 IF result IS NULL THEN RETURN NULL; END IF;
 dependencies:=read_resource_page_dependencies(w,k,i,result->>'version');
 IF jsonb_array_length(dependencies)=0 THEN RETURN result; END IF;
 required:=coalesce(result->'requiredSources','[]');
 FOR source IN SELECT value FROM jsonb_array_elements(dependencies) LOOP
  admitted:=read_page_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);
  IF admitted IS NULL OR admitted->>'version' IS DISTINCT FROM source->>'version' THEN RETURN NULL; END IF;
  required:=required||jsonb_build_array(source)||(admitted->'requiredSources');
 END LOOP;
 RETURN result||jsonb_build_object('requiredSources',(SELECT coalesce(jsonb_agg(DISTINCT value),'[]') FROM jsonb_array_elements(required)));
END $$;
REVOKE ALL ON FUNCTION read_entity_derivation_source(uuid,text,uuid) FROM PUBLIC;
-- The canonical writer uses the non-bypass app role. Keep the facade
-- callable only by that role and its owner, not by every database role.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION read_entity_derivation_source(uuid,text,uuid) TO app_user;
 END IF;
END $$;

CREATE FUNCTION validate_page_derivation_dependencies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source jsonb; admitted jsonb; parent jsonb; output scope_derivations;
BEGIN
 SELECT * INTO output FROM scope_derivations WHERE workspace_id=NEW.workspace_id AND id=NEW.derivation_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(read_resource_page_dependencies(NEW.workspace_id,NEW.source_kind,NEW.source_id,NEW.source_version)) LOOP
  IF output.resource_kind NOT IN('workspace_file','file_segment') THEN RAISE EXCEPTION 'page_derivation_output_not_integrated'; END IF;
  admitted:=read_page_derivation_source(NEW.workspace_id,source->>'resourceKind',(source->>'resourceId')::uuid);
  IF admitted IS NULL OR admitted->>'version' IS DISTINCT FROM source->>'version' THEN RAISE EXCEPTION 'scope_source_changed'; END IF;
  FOR parent IN SELECT value FROM jsonb_array_elements(jsonb_build_array(source)||(admitted->'requiredSources')) LOOP
   IF NOT EXISTS(SELECT 1 FROM scope_derivation_sources p WHERE p.workspace_id=NEW.workspace_id AND p.derivation_id=NEW.derivation_id
    AND p.source_kind=parent->>'resourceKind' AND p.source_id=(parent->>'resourceId')::uuid AND p.source_version=parent->>'version') THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
   IF (parent->>'userId' IS NOT NULL AND parent->>'userId' IS DISTINCT FROM output.user_id::text)
    OR (parent->>'assistantId' IS NOT NULL AND parent->>'assistantId' IS DISTINCT FROM output.assistant_id::text)
    OR sensitivity_rank(parent->>'sensitivity')>sensitivity_rank(output.sensitivity)
    OR NOT(to_jsonb(output.compartments) @> (parent->'compartments'))
    OR NOT(to_jsonb(output.project_ids) @> (parent->'projectIds')) THEN RAISE EXCEPTION 'scope_visibility_incompatible'; END IF;
  END LOOP;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION validate_page_derivation_dependencies() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER page_derivation_dependencies AFTER INSERT OR UPDATE ON scope_derivation_sources
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_page_derivation_dependencies();

CREATE FUNCTION guard_page_derivation_receipts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE output scope_derivations; dependencies jsonb;
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='scope_derivations' THEN output:=OLD;
 ELSE SELECT * INTO output FROM scope_derivations WHERE workspace_id=OLD.workspace_id AND id=OLD.derivation_id; END IF;
 IF output.id IS NOT NULL AND EXISTS(SELECT 1 FROM workspaces WHERE id=output.workspace_id) THEN
  dependencies:=read_resource_page_dependencies(output.workspace_id,output.resource_kind,output.resource_id,output.resource_version);
  IF jsonb_array_length(dependencies)>0 AND read_scope_source(output.workspace_id,output.resource_kind,output.resource_id) IS NOT NULL THEN
   RAISE EXCEPTION 'page_derivation_receipt_immutable' USING ERRCODE='42501';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_page_derivation_receipts() FROM PUBLIC;
CREATE TRIGGER page_derivation_receipts BEFORE UPDATE OR DELETE ON scope_derivation_sources
 FOR EACH ROW EXECUTE FUNCTION guard_page_derivation_receipts();
CREATE TRIGGER page_derivation_output_receipts BEFORE UPDATE OR DELETE ON scope_derivations
 FOR EACH ROW EXECUTE FUNCTION guard_page_derivation_receipts();
ALTER FUNCTION read_media_parent_snapshot(uuid,text,uuid) RENAME TO read_media_parent_snapshot_before_page;
REVOKE ALL ON FUNCTION read_media_parent_snapshot_before_page(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_media_parent_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF k IN('page_event_changed','page_event_destination','page_live_changed','page_live_destination') THEN RETURN read_page_derivation_source(w,k,i); END IF;
 RETURN read_media_parent_snapshot_before_page(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_media_parent_snapshot(uuid,text,uuid) FROM PUBLIC;

ALTER FUNCTION record_media_lineage(uuid,text,uuid,text,uuid,text) RENAME TO record_media_lineage_before_page;
REVOKE ALL ON FUNCTION record_media_lineage_before_page(uuid,text,uuid,text,uuid,text) FROM PUBLIC;
CREATE FUNCTION record_media_lineage(w uuid,k text,i uuid,sk text,si uuid,sv text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source jsonb; admitted jsonb; parent jsonb; d uuid;
BEGIN
 PERFORM record_media_lineage_before_page(w,k,i,sk,si,sv);
 SELECT id INTO d FROM scope_derivations WHERE workspace_id=w AND resource_kind=k AND resource_id=i
  AND resource_version=read_scope_source(w,k,i)->>'version';
 FOR source IN SELECT value FROM jsonb_array_elements(read_resource_page_dependencies(w,sk,si,sv)) LOOP
  admitted:=read_page_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);
  IF admitted IS NULL OR admitted->>'version' IS DISTINCT FROM source->>'version' THEN RAISE EXCEPTION 'scope_source_changed'; END IF;
  FOR parent IN SELECT value FROM jsonb_array_elements(jsonb_build_array(source)||(admitted->'requiredSources')) LOOP
   INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
    VALUES(w,d,parent->>'resourceKind',(parent->>'resourceId')::uuid,parent->>'version') ON CONFLICT DO NOTHING;
  END LOOP;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION record_media_lineage(uuid,text,uuid,text,uuid,text) FROM PUBLIC;

CREATE FUNCTION read_admitted_page_dependencies(w uuid,k text,i uuid,v text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 dependencies jsonb; source jsonb;
BEGIN
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501'; END IF;
 dependencies:=read_resource_page_dependencies(w,k,i,v);
 -- No page metadata is disclosed; ordinary D1 lifecycle checks remain in the caller.
 IF jsonb_array_length(dependencies)=0 THEN RETURN dependencies; END IF;
 IF read_scope_source(w,k,i) IS NOT NULL AND read_entity_derivation_source(w,k,i) IS NULL THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501'; END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(dependencies) LOOP
  IF read_page_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid) IS NULL THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501'; END IF;
 END LOOP;
 RETURN dependencies;
END $$;
REVOKE ALL ON FUNCTION read_admitted_page_dependencies(uuid,text,uuid,text) FROM PUBLIC;

CREATE FUNCTION read_admitted_page_authority(w uuid,k text,i uuid,actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF actor IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
  OR read_page_derivation_source(w,k,i) IS NULL THEN RETURN NULL; END IF;
 RETURN read_page_scope_authority(w,k,i,actor);
END $$;
REVOKE ALL ON FUNCTION read_admitted_page_authority(uuid,text,uuid,uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION read_admitted_page_dependencies(uuid,text,uuid,text),read_admitted_page_authority(uuid,text,uuid,uuid) TO app_user;
 END IF;
END $$;

COMMIT;
