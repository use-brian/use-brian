BEGIN;

-- Preserve immutable historical identity while ordinary connector deletion
-- removes credentials/current liveness and terminally revokes source trust.
ALTER TABLE connector_source_profiles ADD COLUMN original_connector_instance_id uuid;
UPDATE connector_source_profiles SET original_connector_instance_id=connector_instance_id;
ALTER TABLE connector_source_profiles ALTER COLUMN original_connector_instance_id SET NOT NULL;
ALTER TABLE connector_source_profiles ALTER COLUMN connector_instance_id DROP NOT NULL;
ALTER TABLE connector_source_profiles DROP CONSTRAINT connector_source_profiles_connector_instance_id_fkey;
ALTER TABLE connector_source_profiles ADD CONSTRAINT connector_source_profiles_connector_instance_id_fkey
 FOREIGN KEY(connector_instance_id) REFERENCES connector_instance(id) ON DELETE SET NULL;
ALTER TABLE connector_source_profiles ADD CONSTRAINT connector_source_original_binding
 CHECK(connector_instance_id IS NULL OR connector_instance_id=original_connector_instance_id);
CREATE INDEX connector_source_original_instance ON connector_source_profiles(workspace_id,original_connector_instance_id);

CREATE OR REPLACE FUNCTION guard_external_source_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE deleted_instance boolean;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.created_by_user_id IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
    AND nullif(current_setting('app.current_user_id',true),'') IS NOT NULL THEN
   RAISE EXCEPTION 'external_source_actor_mismatch' USING ERRCODE='22023';
  END IF;
  IF NEW.connector_instance_id IS NULL OR (NEW.original_connector_instance_id IS NOT NULL
    AND NEW.original_connector_instance_id<>NEW.connector_instance_id) THEN
   RAISE EXCEPTION 'external_source_binding_immutable' USING ERRCODE='22023';
  END IF;
  NEW.original_connector_instance_id:=NEW.connector_instance_id;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME='external_source_authorizations' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'external_source_evidence_immutable' USING ERRCODE='22023';
 END IF;
 IF TG_TABLE_NAME='connector_source_profiles' THEN
  deleted_instance:=OLD.connector_instance_id IS NOT NULL AND NEW.connector_instance_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM connector_instance WHERE id=OLD.connector_instance_id);
  IF (NEW.id,NEW.workspace_id,NEW.original_connector_instance_id,NEW.tenant,NEW.issuer,NEW.audience,NEW.source_base_url,NEW.mcp_url,NEW.http_read_path,NEW.created_by_user_id,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.original_connector_instance_id,OLD.tenant,OLD.issuer,OLD.audience,OLD.source_base_url,OLD.mcp_url,OLD.http_read_path,OLD.created_by_user_id,OLD.created_at)
    OR NOT deleted_instance AND (NEW.connector_instance_id IS DISTINCT FROM OLD.connector_instance_id OR OLD.status='revoked') THEN
   RAISE EXCEPTION 'external_source_binding_immutable' USING ERRCODE='22023';
  END IF;
  IF deleted_instance THEN NEW.status:='revoked'; END IF;
  NEW.revision:=OLD.revision+1;NEW.updated_at:=clock_timestamp();RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='external_source_resources' AND (to_jsonb(NEW)-ARRAY['state','revision'])=(to_jsonb(OLD)-ARRAY['state','revision']) THEN
  NEW.revision:=OLD.revision+1;RETURN NEW;
 END IF;
 RAISE EXCEPTION 'external_source_evidence_immutable' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION guard_external_source_metadata() FROM PUBLIC;

-- Shared scope quarantine changes authority even without changing roster rows.
CREATE OR REPLACE FUNCTION external_source_authority_fingerprint(w uuid,p uuid) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'workspace',to_jsonb(wk),'policy',(SELECT to_jsonb(v) FROM workspace_access_policies v WHERE v.workspace_id=w),
  'profile',to_jsonb(sp),'instance',to_jsonb(ci),
  'exposures',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM connector_grant g WHERE g.connector_instance_id=ci.id AND g.target_type='workspace' AND g.target_id=w),
  'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.user_id) FROM workspace_members m WHERE m.workspace_id=w),
  'assistants',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM assistants a WHERE a.workspace_id=w),
  'departments',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM department_edges e WHERE e.workspace_id=w AND (e.expires_at IS NULL OR e.expires_at>clock_timestamp())),
  'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM workspace_groups g WHERE g.workspace_id=w),
  'project_scopes',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.project_id) FROM project_shared_scopes s WHERE s.workspace_id=w),
  'projects',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM project_shared_members e WHERE e.workspace_id=w AND (e.expires_at IS NULL OR e.expires_at>clock_timestamp())),
  'keys',(SELECT jsonb_agg(jsonb_build_array(k.kid,k.status) ORDER BY k.kid) FROM connector_actor_signing_keys k WHERE k.issuer=sp.issuer)
 )::text,'UTF8')),'hex')
 FROM connector_source_profiles sp JOIN workspaces wk ON wk.id=sp.workspace_id JOIN connector_instance ci ON ci.id=sp.connector_instance_id
 WHERE sp.id=p AND sp.workspace_id=w AND sp.status='qualified' AND ci.connected AND ci.health_status<>'auth_failed'
   AND (ci.scope='workspace' AND ci.workspace_id=w OR ci.scope='user' AND EXISTS(SELECT 1 FROM connector_grant g WHERE g.connector_instance_id=ci.id AND g.target_type='workspace' AND g.target_id=w))
$$;
REVOKE ALL ON FUNCTION external_source_authority_fingerprint(uuid,uuid) FROM PUBLIC;

COMMIT;
