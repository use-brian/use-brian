-- Migration 603 gave read_scope_review_source() a generic fallback version
-- ("<scope_version|timestamp>:<md5(row)>") for every kind outside its canonical
-- delegation list. workspace_skill_revision (migration 602) fell into that
-- fallback, while hold_scope_descendants() writes its scope_resource_states row
-- with the plain canonical scope_version. 603 also switched the
-- scope_resource_states reference trigger to read_scope_review_source(), so the
-- two formats can never agree: every change to a memory (or other source) that
-- has a derived skill revision descendant raised scope_source_changed and rolled
-- the source edit back. Skill revisions carry a trigger-maintained scope_version,
-- so they belong to the canonical read_scope_source() path.
-- Spec: docs/architecture/context-engine/scoped-context.md
BEGIN;

CREATE OR REPLACE FUNCTION read_scope_review_source(p_workspace uuid,p_kind text,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE live jsonb; row_json jsonb; source jsonb; resolved_workspace uuid;
  version_value text; held_value boolean=false;
BEGIN
  IF p_kind IN('memory','entity','entity_link','task','workspace_file','episode',
      'knowledge_entry','kb_chunk','workspace_skill_revision') THEN
    live=read_scope_source(p_workspace,p_kind,p_id);
    IF live IS NOT NULL THEN RETURN live; END IF;
  END IF;

  IF p_kind='crm_event' THEN
    SELECT to_jsonb(r) INTO row_json FROM crm_domain_event_outbox r
      WHERE r.workspace_id=p_workspace AND r.id=p_id FOR SHARE;
    source=row_json->'scope_source';
    version_value=(row_json->>'scope_version')||':'||
      ((extract(epoch FROM (row_json->>'created_at')::timestamptz)*1000000)::numeric::text);
  ELSIF p_kind='memory_verification' THEN
    SELECT to_jsonb(r) INTO row_json FROM memory_verifications r
      WHERE r.workspace_id=p_workspace AND r.id=p_id FOR SHARE;
    source=row_json->'source_scope';
    version_value=(row_json->>'scope_version')||':'||(row_json->>'created_at');
  ELSIF p_kind='brain_verification' THEN
    SELECT to_jsonb(r) INTO row_json FROM brain_verifications r
      WHERE r.workspace_id=p_workspace AND r.id=p_id FOR SHARE;
    source=row_json->'source_scope';
    version_value=(row_json->>'scope_version')||':'||(row_json->>'created_at');
  ELSIF p_kind='correction_audit' THEN
    SELECT to_jsonb(r) INTO row_json FROM correction_audit r
      WHERE r.workspace_id=p_workspace AND r.id=p_id FOR SHARE;
    source=row_json->'source_scope';
    version_value=(row_json->>'scope_version')||':'||(row_json->>'created_at');
  ELSIF p_kind='session_message' THEN
    SELECT to_jsonb(m),coalesce(m.workspace_id,s.workspace_id) INTO row_json,resolved_workspace
      FROM session_messages m JOIN sessions s ON s.id=m.session_id
      WHERE coalesce(m.workspace_id,s.workspace_id)=p_workspace AND m.id=p_id FOR SHARE OF m;
    version_value=coalesce(row_json->>'scope_version','legacy:'||md5(row_json::text));
  ELSIF p_kind='feedback_event' THEN
    SELECT to_jsonb(e),coalesce(e.workspace_id,a.workspace_id) INTO row_json,resolved_workspace
      FROM analytics_events e LEFT JOIN assistants a ON a.id=e.assistant_id
      WHERE coalesce(e.workspace_id,a.workspace_id)=p_workspace AND e.id=p_id
        AND e.event_name='feedback_negative' FOR SHARE OF e;
    version_value=coalesce(row_json->>'scope_version','legacy:'||md5(row_json::text));
  ELSE
    IF scope_review_source_table(p_kind) IS NULL THEN RETURN NULL; END IF;
    EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE r.workspace_id=$1 AND r.id=$2 FOR SHARE',
      scope_review_source_table(p_kind)) INTO row_json USING p_workspace,p_id;
    version_value=coalesce(row_json->>'scope_version',row_json->>'updated_at',
      row_json->>'last_edited_at',row_json->>'created_at','legacy')||':'||md5(row_json::text);
  END IF;
  IF row_json IS NULL THEN RETURN NULL; END IF;
  held_value=coalesce((row_json->>'scope_held')::boolean,false) OR EXISTS(
    SELECT 1 FROM scope_resource_states s WHERE s.workspace_id=p_workspace
      AND s.resource_kind=p_kind AND s.resource_id=p_id AND s.review_state='held');
  RETURN jsonb_build_object(
    'workspaceId',p_workspace,'userId',coalesce(source->'userId',row_json->'user_id'),
    'assistantId',coalesce(source->'assistantId',row_json->'assistant_id'),
    'sensitivity',coalesce(source->'sensitivity',row_json->'sensitivity'),
    'compartments',coalesce(source->'compartments',row_json->'compartments'),
    'projectIds',coalesce(source->'projectIds',row_json->'project_ids'),
    'resourceKind',p_kind,'resourceId',p_id,'version',version_value,
    'held',held_value,'validTo',row_json->'valid_to','retractedAt',row_json->'retracted_at');
END;
$$;
REVOKE ALL ON FUNCTION read_scope_review_source(uuid,text,uuid) FROM PUBLIC;

COMMIT;
