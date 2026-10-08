BEGIN;
-- [COMP:api/crm-integration-auth] Capture real issuance authority without backfilling history.
CREATE OR REPLACE FUNCTION audit_subject_scope(w uuid,k text,i uuid,lock_source boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE canonical_kind text; source_id uuid; tab text; body jsonb;
BEGIN
  IF k='crm_integration_credential' THEN
    IF lock_source THEN
      SELECT department_binding INTO body FROM crm_integration_credentials WHERE workspace_id=w AND id=i FOR SHARE;
    ELSE
      SELECT department_binding INTO body FROM crm_integration_credentials WHERE workspace_id=w AND id=i;
    END IF;
    IF body IS NULL OR body->>'workspaceId' IS DISTINCT FROM w::text OR body->>'version'<>'1'
      OR jsonb_typeof(body->'binding')<>'array' OR body->>'cap' NOT IN('public','internal','confidential') THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity',body->>'cap',
      'compartments',(SELECT coalesce(jsonb_agg('team:'||d ORDER BY d),'[]'::jsonb) FROM jsonb_array_elements_text(body->'binding') d),
      'projectIds','[]'::jsonb,'resourceKind',k,'resourceId',i,'version',1,'held',false,'validTo',NULL,'retractedAt',NULL);
  END IF;
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
CREATE OR REPLACE FUNCTION audit_scope_visible(row_data jsonb,mutation boolean DEFAULT false) RETURNS boolean
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
  IF row_data->>'scope_origin'='captured' AND row_data->>'scope_subject_kind'='crm_integration_credential'
    AND EXISTS(SELECT 1 FROM workspaces WHERE id=w AND department_read_v2) THEN
    current_primary=audit_subject_scope(w,'crm_integration_credential',(row_data->>'subject_id')::uuid,false);
    IF current_primary IS NULL OR row_data->'scope_sources' IS DISTINCT FROM jsonb_build_array(current_primary) THEN RETURN false; END IF;
    RETURN department_row_allows(department_read_grants_for(actor),w,current_primary->>'sensitivity',
      ARRAY(SELECT jsonb_array_elements_text(current_primary->'compartments')),NULL)
      AND agent_visibility_allows(w,NULL,NULL)
      AND (NOT mutation OR agent_mutation_scope_allows(ARRAY(SELECT jsonb_array_elements_text(current_primary->'compartments'))));
  END IF;
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
-- Append permission does not grant read/update/delete permission to the receipt.
CREATE FUNCTION credential_audit_append_allows(row_data jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w uuid=(row_data->>'workspace_id')::uuid;
  actor uuid=nullif(current_setting('app.current_user_id',true),'')::uuid; source jsonb;
BEGIN
  IF row_data->>'actor_user_id' IS DISTINCT FROM actor::text
    OR row_data->>'event_type' NOT IN('crm.integration_credential_created','crm.integration_credential_revoked')
    OR row_data->>'scope_origin' IS DISTINCT FROM 'captured'
    OR row_data->>'scope_subject_kind' IS DISTINCT FROM 'crm_integration_credential'
    OR row_data->>'scope_held' IS DISTINCT FROM 'false'
    OR row_data->>'scope_erased' IS DISTINCT FROM 'false'
    OR NOT EXISTS(SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id
      WHERE m.workspace_id=(row_data->>'workspace_id')::uuid AND m.user_id=actor AND m.role IN('owner','admin') AND w.department_read_v2)
    THEN RETURN false; END IF;
  source=audit_subject_scope(w,'crm_integration_credential',(row_data->>'subject_id')::uuid,false);
  RETURN source IS NOT NULL AND row_data->'scope_sources'=jsonb_build_array(source);
END;
$$;
DROP POLICY audit_scope_insert ON workspace_audit_log;
CREATE POLICY audit_scope_insert ON workspace_audit_log AS RESTRICTIVE FOR INSERT
  WITH CHECK(audit_scope_visible(to_jsonb(workspace_audit_log),true) OR credential_audit_append_allows(to_jsonb(workspace_audit_log)));
COMMIT;
