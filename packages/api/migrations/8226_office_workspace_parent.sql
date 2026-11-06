-- [COMP:api/office-generation] Exact credential origins at Office publication.
BEGIN;
CREATE FUNCTION workspace_mcp_parent_current(p jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k jsonb; a uuid; w uuid; u uuid; fingerprint text; child jsonb; consent jsonb; context_ok boolean;
BEGIN
 IF jsonb_typeof(p)<>'object' OR p->>'kind' NOT IN ('brain_key','assistant_key','oauth_token') THEN RETURN false; END IF;
 IF p->>'kind'='oauth_token' THEN
  SELECT to_jsonb(o),o.user_id,o.workspace_id,(o.workspace_mcp_consent->>'assistantId')::uuid,
   jsonb_build_array(o.id,o.client_id,o.user_id,o.workspace_id,o.scope,o.audience,o.bound_assistant_id,o.workspace_mcp_consent)::text
  INTO k,u,w,a,fingerprint FROM oauth_authorizations o JOIN oauth_clients c ON c.client_id=o.client_id AND c.revoked_at IS NULL
  WHERE o.id=(p->>'credentialId')::uuid AND o.revoked_at IS NULL
   AND (o.audience='brain' OR o.audience='assistant' AND o.bound_assistant_id=(p->>'assistantId')::uuid);
 ELSIF p->>'kind'='brain_key' THEN
  SELECT to_jsonb(b),coalesce(b.issuer_user_id,b.created_by),b.workspace_id,(b.workspace_mcp_consent->>'assistantId')::uuid,
    (to_jsonb(b)-'last_used_at'-'created_at'-'key_prefix')::text
  INTO k,u,w,a,fingerprint FROM brain_keys b WHERE b.id=(p->>'credentialId')::uuid AND b.status='active';
 ELSE
  SELECT to_jsonb(b),coalesce(b.issuer_user_id,b.created_by),s.workspace_id,b.assistant_id,
    (to_jsonb(b)-'last_used_at'-'created_at'-'key_prefix')::text
  INTO k,u,w,a,fingerprint FROM api_keys b JOIN assistants s ON s.id=b.assistant_id
  WHERE b.id=(p->>'credentialId')::uuid AND b.status='active';
 END IF;
 consent:=k->'workspace_mcp_consent';
 IF k IS NULL OR consent IS NULL OR consent='null'::jsonb
  OR consent->>'version' IS DISTINCT FROM '1' OR (consent->>'expiresAt')::timestamptz<=clock_timestamp()
  OR p->>'revision' IS DISTINCT FROM encode(sha256(convert_to(fingerprint,'UTF8')),'hex')
  OR p->>'userId' IS DISTINCT FROM u::text OR p->>'workspaceId' IS DISTINCT FROM w::text OR p->>'assistantId' IS DISTINCT FROM a::text
  OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=u)
  OR NOT EXISTS(SELECT 1 FROM assistants WHERE id=a AND workspace_id=w) THEN RETURN false; END IF;
 SELECT EXISTS(SELECT 1 FROM workspace_mcp_contexts c JOIN sessions s ON s.id=(p->>'sessionId')::uuid
   AND s.user_id=u AND s.assistant_id=a
   AND s.channel_id='workspace-mcp:'||(p->>'kind')||':'||(p->>'credentialId')||CASE WHEN p->>'selectionId' IS NULL THEN '' ELSE ':'||(p->>'selectionId') END
   WHERE NOT c.invalidated AND c.workspace_id=w AND c.user_id=u AND c.assistant_id=a
   AND c.selection_id=coalesce((p->>'selectionId')::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
   AND CASE p->>'kind' WHEN 'brain_key' THEN c.brain_key_id WHEN 'assistant_key' THEN c.api_key_id ELSE c.oauth_authorization_id END=(p->>'credentialId')::uuid) INTO context_ok;
 IF NOT context_ok THEN RETURN false; END IF;
 IF p ? 'constraints' THEN
  IF jsonb_typeof(p->'constraints')<>'array' OR jsonb_array_length(p->'constraints')>8 THEN RETURN false; END IF;
  FOR child IN SELECT value FROM jsonb_array_elements(p->'constraints') LOOP
   IF child ? 'constraints' OR child->>'userId' IS DISTINCT FROM u::text OR child->>'workspaceId' IS DISTINCT FROM w::text
    OR NOT workspace_mcp_parent_current(child) THEN RETURN false; END IF;
  END LOOP;
 END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION guard_office_workspace_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND ((OLD.authority_projection->'workspaceDelegation') IS DISTINCT FROM (NEW.authority_projection->'workspaceDelegation')
  OR (OLD.authority_projection->'workspaceEvidence') IS DISTINCT FROM (NEW.authority_projection->'workspaceEvidence')) THEN
  RAISE EXCEPTION 'office_workspace_parent_immutable';
 END IF;
 IF TG_OP='INSERT' AND NEW.authority_projection ? 'workspaceDelegation' AND (
  NEW.authority_projection->'workspaceDelegation'->>'userId' IS DISTINCT FROM NEW.initiated_by_user_id::text
  OR NEW.authority_projection->'workspaceDelegation'->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
  OR NOT workspace_mcp_parent_current(NEW.authority_projection->'workspaceDelegation')) THEN
  RAISE EXCEPTION 'office_workspace_parent_unavailable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER office_workspace_parent_guard BEFORE INSERT OR UPDATE ON office_generation_jobs
FOR EACH ROW EXECUTE FUNCTION guard_office_workspace_parent();
DO $$
DECLARE body text; needle text;
BEGIN
 SELECT pg_get_functiondef('guard_office_generation_file_binding()'::regprocedure) INTO body;
 needle:='AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=j.workspace_id AND w.department_read_v2)';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'office_publication_guard_contract_changed'; END IF;
 body:=replace(body,needle,'AND (workspace_mcp_parent_current(j.authority_projection->''workspaceDelegation'') OR EXISTS(SELECT 1 FROM workspaces w WHERE w.id=j.workspace_id AND w.department_read_v2))');
 needle:=$old$OR NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id
     WHERE s.id::text=j.authority_projection->'creationBinding'->>'authSessionId'
       AND s.user_id=actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_version=u.auth_version)$old$;
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'office_publication_actor_contract_changed'; END IF;
 body:=replace(body,needle,'OR NOT (workspace_mcp_parent_current(j.authority_projection->''workspaceDelegation'') OR '||replace(needle,'OR NOT ','')||')');
 EXECUTE body;
END $$;

COMMIT;
