BEGIN;

ALTER TABLE association_audit_log
  ADD COLUMN scope_subject_kind text,
  ADD COLUMN scope_sources jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(scope_sources)='array'),
  ADD COLUMN scope_origin text NOT NULL DEFAULT 'legacy' CHECK(scope_origin IN('legacy','captured','unresolved')),
  ADD COLUMN scope_held boolean NOT NULL DEFAULT false,
  ADD COLUMN scope_erased boolean NOT NULL DEFAULT false;
ALTER TABLE workspace_audit_log
  ADD COLUMN scope_subject_kind text,
  ADD COLUMN scope_sources jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(scope_sources)='array'),
  ADD COLUMN scope_origin text NOT NULL DEFAULT 'legacy' CHECK(scope_origin IN('legacy','captured','unresolved')),
  ADD COLUMN scope_held boolean NOT NULL DEFAULT false,
  ADD COLUMN scope_erased boolean NOT NULL DEFAULT false;

CREATE FUNCTION audit_subject_scope(w uuid,k text,i uuid,lock_source boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE canonical_kind text; source_id uuid; tab text; body jsonb;
BEGIN
  canonical_kind=CASE k WHEN 'contact' THEN 'entity' WHEN 'person' THEN 'entity' WHEN 'company' THEN 'entity' WHEN 'deal' THEN 'entity' WHEN 'file' THEN 'workspace_file' ELSE k END;
  source_id=i;
  IF k IN('submission','enquiry','entitlement','membership','participation','registration') THEN
    source_id=crm_event_entity_source(w,CASE k WHEN 'enquiry' THEN 'submission' WHEN 'membership' THEN 'entitlement' WHEN 'registration' THEN 'participation' ELSE k END,i,lock_source);
    canonical_kind='entity';
  END IF;
  tab=scope_source_table(canonical_kind);
  IF tab IS NULL OR source_id IS NULL THEN RETURN NULL; END IF;
  IF lock_source THEN RETURN read_scope_source(w,canonical_kind,source_id); END IF;
  -- Read-only exports cannot take source locks. Admission and capture do lock.
  EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE workspace_id=$1 AND id=$2',tab) INTO body USING w,source_id;
  IF body IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('workspaceId',body->'workspace_id','userId',body->'user_id','assistantId',body->'assistant_id',
    'sensitivity',body->'sensitivity','compartments',body->'compartments','projectIds',body->'project_ids',
    'resourceKind',canonical_kind,'resourceId',source_id,'version',body->>'scope_version',
    'held',body->'scope_held','validTo',body->'valid_to','retractedAt',body->'retracted_at');
END;
$$;
REVOKE ALL ON FUNCTION audit_subject_scope(uuid,text,uuid,boolean) FROM PUBLIC;

CREATE FUNCTION capture_audit_scope(w uuid,k text,i uuid,body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sources jsonb='[]'; s jsonb; origin text='captured'; reference_key text; reference_id text;
BEGIN
  s=audit_subject_scope(w,k,i,true);
  IF s IS NULL THEN origin='unresolved'; ELSE sources=jsonb_build_array(s); END IF;
  FOREACH reference_key IN ARRAY ARRAY['contactId','entityId','dealId','companyId','taskId'] LOOP
    reference_id=body->>reference_key;
    IF reference_id IS NULL THEN CONTINUE; END IF;
    IF reference_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN origin='unresolved';CONTINUE; END IF;
    s=audit_subject_scope(w,CASE WHEN reference_key='taskId' THEN 'task' ELSE 'entity' END,reference_id::uuid,true);
    IF s IS NULL THEN origin='unresolved'; ELSIF NOT sources @> jsonb_build_array(s) THEN sources=sources||jsonb_build_array(s); END IF;
  END LOOP;
  IF body ?| ARRAY['contactIds','entityIds','dealIds','taskIds','batchId','batchCount'] THEN origin='unresolved'; END IF;
  RETURN jsonb_build_object('sources',sources,'origin',origin);
END;
$$;
REVOKE ALL ON FUNCTION capture_audit_scope(uuid,text,uuid,jsonb) FROM PUBLIC;

-- Current source floors are conservative protection, not historical review.
UPDATE association_audit_log a SET scope_subject_kind=a.subject_kind,scope_sources=capture_audit_scope(a.workspace_id,a.subject_kind,a.subject_id,a.metadata)->'sources';
UPDATE workspace_audit_log a SET scope_subject_kind=a.details->>'subjectKind',scope_sources=capture_audit_scope(a.workspace_id,a.details->>'subjectKind',a.subject_id,a.details)->'sources';
ALTER TABLE association_audit_log ALTER COLUMN scope_origin SET DEFAULT 'unresolved';
ALTER TABLE workspace_audit_log ALTER COLUMN scope_origin SET DEFAULT 'unresolved';

CREATE FUNCTION guard_audit_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE body jsonb; old_body jsonb; k text; old_kind text; action text; old_action text; captured jsonb; reference_key text; actor_key text;
BEGIN
  IF TG_TABLE_NAME='association_audit_log' THEN
    body=NEW.metadata;k=NEW.subject_kind;action=NEW.action;
    IF TG_OP='UPDATE' THEN old_body=OLD.metadata;old_kind=OLD.subject_kind;old_action=OLD.action; END IF;
  ELSE
    body=NEW.details;k=body->>'subjectKind';action=NEW.event_type;
    IF TG_OP='UPDATE' THEN old_body=OLD.details;old_kind=old_body->>'subjectKind';old_action=OLD.event_type; END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    captured=capture_audit_scope(NEW.workspace_id,k,NEW.subject_id,body);
    NEW.scope_subject_kind=k;
    NEW.scope_sources=captured->'sources';NEW.scope_origin=captured->>'origin';NEW.scope_held=false;NEW.scope_erased=false;
    RETURN NEW;
  END IF;
  IF OLD.scope_erased THEN
    actor_key=CASE TG_TABLE_NAME WHEN 'association_audit_log' THEN 'acting_user_id' ELSE 'actor_user_id' END;
    -- FK deletion may remove the actor; it cannot replace the actor or receipt.
    IF (to_jsonb(NEW)-actor_key) IS DISTINCT FROM (to_jsonb(OLD)-actor_key)
      OR (to_jsonb(NEW)->actor_key IS DISTINCT FROM to_jsonb(OLD)->actor_key
        AND to_jsonb(NEW)->actor_key IS DISTINCT FROM 'null'::jsonb) THEN
      RAISE EXCEPTION 'audit_receipt_erased';
    END IF;
    RETURN NEW;
  END IF;
  IF body='{"erased":true}'::jsonb AND (NEW.subject_id IS NULL OR NEW.subject_id='00000000-0000-0000-0000-000000000000'::uuid)
    AND ROW(NEW.id,NEW.workspace_id,action) IS NOT DISTINCT FROM ROW(OLD.id,OLD.workspace_id,old_action) THEN
    NEW.scope_subject_kind=OLD.scope_subject_kind;NEW.scope_sources='[]';NEW.scope_origin=OLD.scope_origin;NEW.scope_held=true;NEW.scope_erased=true;RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.workspace_id,NEW.subject_id,action,NEW.scope_subject_kind,NEW.scope_sources,NEW.scope_origin,NEW.scope_erased)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.subject_id,old_action,OLD.scope_subject_kind,OLD.scope_sources,OLD.scope_origin,OLD.scope_erased)
    OR (k IS NOT NULL AND k IS DISTINCT FROM OLD.scope_subject_kind)
    OR (OLD.scope_held AND NOT NEW.scope_held) THEN RAISE EXCEPTION 'audit_scope_release_required'; END IF;
  IF body NOT IN('{"erased":true}'::jsonb,'{"retentionRedacted":true}'::jsonb) THEN
    FOREACH reference_key IN ARRAY ARRAY['contactId','entityId','dealId','companyId','taskId','contactIds','entityIds','dealIds','taskIds','batchId','batchCount'] LOOP
      IF body->reference_key IS DISTINCT FROM old_body->reference_key THEN RAISE EXCEPTION 'audit_scope_release_required'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_scope_audit_guard BEFORE INSERT OR UPDATE ON association_audit_log FOR EACH ROW EXECUTE FUNCTION guard_audit_scope();
CREATE TRIGGER crm_scope_audit_guard BEFORE INSERT OR UPDATE ON workspace_audit_log FOR EACH ROW EXECUTE FUNCTION guard_audit_scope();

CREATE FUNCTION audit_scope_visible(row_data jsonb,mutation boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w uuid=(row_data->>'workspace_id')::uuid; actor uuid=nullif(current_setting('app.current_user_id',true),'')::uuid;
  s jsonb; live jsonb; fallback jsonb; current_primary jsonb; primary_kind text;
BEGIN
  fallback=jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb,'held',false);
  IF row_data->>'scope_erased'='true' THEN
    RETURN NOT mutation AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor AND role IN('owner','admin'))
      AND crm_scope_snapshot_allows(fallback,w,actor,NULL,NULL);
  END IF;
  IF row_data->>'scope_held' IS DISTINCT FROM 'false' THEN RETURN false; END IF;
  IF row_data->>'scope_origin'<>'captured' AND EXISTS(SELECT 1 FROM workspace_access_policies WHERE workspace_id=w AND classification_mode='strict') THEN RETURN false; END IF;
  IF NOT crm_scope_snapshot_allows(fallback,w,actor,NULL,NULL) THEN RETURN false; END IF;
  primary_kind=row_data->>'scope_subject_kind';
  IF row_data->>'scope_origin'='captured' THEN
    current_primary=audit_subject_scope(w,primary_kind,(row_data->>'subject_id')::uuid,false);
    IF current_primary IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(row_data->'scope_sources') source
      WHERE source->>'resourceKind'=current_primary->>'resourceKind' AND source->>'resourceId'=current_primary->>'resourceId') THEN RETURN false; END IF;
  END IF;
  FOR s IN SELECT jsonb_array_elements(row_data->'scope_sources') LOOP
    live=audit_subject_scope(w,s->>'resourceKind',(s->>'resourceId')::uuid,false);
    IF NOT coalesce(crm_scope_snapshot_allows(s,w,actor,NULL,NULL) AND crm_scope_snapshot_allows(live,w,actor,NULL,NULL),false) THEN RETURN false; END IF;
    IF mutation AND NOT(agent_mutation_scope_allows(ARRAY(SELECT jsonb_array_elements_text(s->'compartments')))
      AND agent_mutation_scope_allows(ARRAY(SELECT jsonb_array_elements_text(live->'compartments')))) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['association_audit_log','workspace_audit_log'] LOOP
    EXECUTE format('CREATE POLICY audit_scope_read ON %I AS RESTRICTIVE FOR SELECT USING(audit_scope_visible(to_jsonb(%I),false))',tab,tab);
    EXECUTE format('CREATE POLICY audit_scope_insert ON %I AS RESTRICTIVE FOR INSERT WITH CHECK(audit_scope_visible(to_jsonb(%I),true))',tab,tab);
    EXECUTE format('CREATE POLICY audit_scope_update ON %I AS RESTRICTIVE FOR UPDATE USING(audit_scope_visible(to_jsonb(%I),true)) WITH CHECK(audit_scope_visible(to_jsonb(%I),true))',tab,tab,tab);
    EXECUTE format('CREATE POLICY audit_scope_delete ON %I AS RESTRICTIVE FOR DELETE USING(audit_scope_visible(to_jsonb(%I),true))',tab,tab);
  END LOOP;
END $$;
COMMIT;
