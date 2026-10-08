BEGIN;
-- [COMP:api/crm-event-scope] Preserve audience, not erased source identity.
-- Spec: docs/architecture/features/crm-operations.md, Event privacy scope survives retirement.
ALTER TABLE crm_domain_event_outbox ADD COLUMN privacy_scope jsonb;
ALTER TABLE crm_domain_event_outbox ADD CONSTRAINT crm_domain_event_outbox_scope_shape CHECK (
  privacy_scope IS NULL OR (
    jsonb_typeof(privacy_scope)='object'
    AND (privacy_scope->>'workspaceId') IS NOT DISTINCT FROM workspace_id::text
    AND privacy_scope ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']
    AND coalesce(privacy_scope->>'sensitivity','') IN ('public','internal','confidential')
    AND jsonb_typeof(privacy_scope->'compartments')='array'
    AND jsonb_typeof(privacy_scope->'projectIds')='array'
  )
);

UPDATE crm_domain_event_outbox SET privacy_scope=jsonb_build_object('workspaceId',scope_source->'workspaceId','userId',scope_source->'userId','assistantId',scope_source->'assistantId','sensitivity',scope_source->'sensitivity','compartments',scope_source->'compartments','projectIds',scope_source->'projectIds') WHERE status<>'retired' AND scope_origin='captured' AND scope_source IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_crm_event_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source_id uuid;
BEGIN
  IF TG_OP='UPDATE' AND NEW.privacy_scope IS DISTINCT FROM OLD.privacy_scope THEN
    RAISE EXCEPTION 'event_scope_release_required';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status<>'retired' AND NEW.status='retired'
    AND NEW.subject_id='00000000-0000-0000-0000-000000000000'::uuid
    AND NEW.payload=jsonb_build_object('erased',true,'eventType',OLD.event_type)
    AND ROW(NEW.id,NEW.workspace_id,NEW.subject_kind,NEW.event_type)
      IS NOT DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.subject_kind,OLD.event_type) THEN
    -- Canonical privacy retirement is terminal and cannot release content.
    NEW.scope_source=NULL; NEW.scope_origin=OLD.scope_origin; NEW.scope_held=true;
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    source_id=crm_event_entity_source(NEW.workspace_id,NEW.subject_kind,NEW.subject_id,true);
    NEW.scope_source=read_scope_source(NEW.workspace_id,'entity',source_id);
    NEW.scope_origin=CASE WHEN NEW.scope_source IS NOT NULL AND NOT(NEW.payload ?| ARRAY['batchId','batchCount']) THEN 'captured' ELSE 'unresolved' END;
    NEW.scope_held=false;
    NEW.privacy_scope=CASE WHEN NEW.scope_origin='captured' THEN jsonb_build_object('workspaceId',NEW.scope_source->'workspaceId','userId',NEW.scope_source->'userId','assistantId',NEW.scope_source->'assistantId','sensitivity',NEW.scope_source->'sensitivity','compartments',NEW.scope_source->'compartments','projectIds',NEW.scope_source->'projectIds') ELSE NULL END;
  ELSIF ROW(NEW.id,NEW.workspace_id,NEW.subject_kind,NEW.subject_id,NEW.event_type,NEW.scope_source,NEW.scope_origin)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.subject_kind,OLD.subject_id,OLD.event_type,OLD.scope_source,OLD.scope_origin)
    OR (OLD.scope_held AND NOT NEW.scope_held) THEN
    RAISE EXCEPTION 'event_scope_release_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm_event_scope_visible(event_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT crm_event_scope_allows(event_id,nullif(current_setting('app.current_user_id',true),'')::uuid)
 OR EXISTS(SELECT 1 FROM crm_domain_event_outbox e JOIN workspace_members m ON m.workspace_id=e.workspace_id
   AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND m.role IN('owner','admin')
   WHERE e.id=event_id AND e.status='retired' AND e.scope_source IS NULL
     AND e.subject_id='00000000-0000-0000-0000-000000000000'::uuid
     AND e.payload=jsonb_build_object('erased',true,'eventType',e.event_type)
     AND CASE WHEN (SELECT department_read_v2 FROM workspaces WHERE id=e.workspace_id) THEN
       e.privacy_scope IS NOT NULL AND department_member_source_allows(m.user_id,e.workspace_id,e.privacy_scope->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(e.privacy_scope->'compartments')),(e.privacy_scope->>'userId')::uuid)
       AND agent_visibility_allows(e.workspace_id,(e.privacy_scope->>'userId')::uuid,(e.privacy_scope->>'assistantId')::uuid)
     ELSE crm_scope_snapshot_allows(jsonb_build_object('workspaceId',e.workspace_id,'userId',NULL,'assistantId',NULL,
       'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb,'held',false),e.workspace_id,m.user_id,NULL,NULL) END)
$$;

COMMIT;
