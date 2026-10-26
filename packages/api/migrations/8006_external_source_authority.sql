BEGIN;

CREATE TABLE connector_source_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 connector_instance_id uuid NOT NULL REFERENCES connector_instance(id) ON DELETE CASCADE,
 tenant text NOT NULL CHECK(length(tenant) BETWEEN 1 AND 256),
 issuer text NOT NULL CHECK(issuer LIKE 'https://%' AND length(issuer)<=2048),
 audience text NOT NULL CHECK(audience LIKE 'https://%' AND length(audience)<=2048),
 source_base_url text NOT NULL CHECK(length(source_base_url) BETWEEN 1 AND 2048),
 mcp_url text NOT NULL CHECK(length(mcp_url) BETWEEN 1 AND 2048),
 http_read_path text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','qualified','revoked')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by_user_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,workspace_id)
);
CREATE UNIQUE INDEX connector_source_live_profile ON connector_source_profiles(workspace_id,connector_instance_id,tenant) WHERE status<>'revoked';
CREATE TABLE external_source_resources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL,
 resource_type text NOT NULL CHECK(length(resource_type) BETWEEN 1 AND 128),
 opaque_id text NOT NULL CHECK(length(opaque_id) BETWEEN 1 AND 1024),
 state text NOT NULL DEFAULT 'active' CHECK(state IN('active','withdrawn','held')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(profile_id,workspace_id) REFERENCES connector_source_profiles(id,workspace_id) ON DELETE CASCADE,
 UNIQUE(profile_id,resource_type,opaque_id),UNIQUE(id,workspace_id)
);
CREATE TABLE external_source_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 resource_id uuid NOT NULL,
 version text NOT NULL CHECK(version ~ '^[a-f0-9]{64}$'),
 content_version text NOT NULL CHECK(length(content_version) BETWEEN 1 AND 256),
 policy_version text NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 256),
 fields text[] NOT NULL CHECK(cardinality(fields) BETWEEN 1 AND 256),
 observation jsonb NOT NULL CHECK(jsonb_typeof(observation)='object'
   AND observation ?& ARRAY['resource','fields','labels','subjects','actions','retention','export']
   AND observation-ARRAY['resource','fields','labels','subjects','actions','retention','export']='{}'::jsonb
   AND observation->'fields'=to_jsonb(fields)
   AND observation->'resource'->>'contentVersion'=content_version AND observation->'resource'->>'policyVersion'=policy_version
   AND jsonb_typeof(observation->'subjects')='array' AND jsonb_array_length(observation->'subjects') BETWEEN 1 AND 100),
 sensitivity text NOT NULL CHECK(sensitivity IN('public','internal','confidential')),
 compartments text[] NOT NULL,
 project_ids uuid[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(resource_id,workspace_id) REFERENCES external_source_resources(id,workspace_id) ON DELETE CASCADE,
 UNIQUE(resource_id,version),UNIQUE(id,workspace_id)
);
CREATE TABLE external_source_authorizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 observation_id uuid NOT NULL,
 profile_id uuid NOT NULL,
 profile_revision bigint NOT NULL,
 resource_revision bigint NOT NULL,
 operation_id uuid NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[A-Za-z0-9_-]{43}$'),
 transaction_id xid8 NOT NULL,
 backend_pid integer NOT NULL,
 actor_kind text NOT NULL CHECK(actor_kind IN('human','service')),
 actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 recipient_kind text NOT NULL CHECK(recipient_kind IN('human','service')),
 recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipient_assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 action text NOT NULL CHECK(action IN('read','context','derive','retain','deliver','export','mutate')),
 source_receipt text NOT NULL CHECK(length(source_receipt) BETWEEN 1 AND 1024),
 authority_fingerprint text NOT NULL CHECK(authority_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 FOREIGN KEY(observation_id,workspace_id) REFERENCES external_source_observations(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(profile_id,workspace_id) REFERENCES connector_source_profiles(id,workspace_id) ON DELETE CASCADE,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 seconds')
);
CREATE INDEX external_source_authorization_operation ON external_source_authorizations(transaction_id,backend_pid,operation_id,observation_id);
CREATE INDEX external_source_authorization_expiry ON external_source_authorizations(expires_at);

CREATE FUNCTION guard_external_source_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.created_by_user_id IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
    AND nullif(current_setting('app.current_user_id',true),'') IS NOT NULL THEN
   RAISE EXCEPTION 'external_source_actor_mismatch' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME='external_source_authorizations' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'external_source_evidence_immutable' USING ERRCODE='22023';
 END IF;
 IF TG_TABLE_NAME='connector_source_profiles' THEN
  IF (NEW.id,NEW.workspace_id,NEW.connector_instance_id,NEW.tenant,NEW.issuer,NEW.audience,NEW.source_base_url,NEW.mcp_url,NEW.http_read_path,NEW.created_by_user_id,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.connector_instance_id,OLD.tenant,OLD.issuer,OLD.audience,OLD.source_base_url,OLD.mcp_url,OLD.http_read_path,OLD.created_by_user_id,OLD.created_at)
    OR OLD.status='revoked' THEN RAISE EXCEPTION 'external_source_binding_immutable' USING ERRCODE='22023'; END IF;
  NEW.revision:=OLD.revision+1;NEW.updated_at:=clock_timestamp();RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='external_source_resources' AND (to_jsonb(NEW)-ARRAY['state','revision'])=(to_jsonb(OLD)-ARRAY['state','revision']) THEN
  NEW.revision:=OLD.revision+1;RETURN NEW;
 END IF;
 RAISE EXCEPTION 'external_source_evidence_immutable' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION guard_external_source_metadata() FROM PUBLIC;
CREATE TRIGGER connector_source_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON connector_source_profiles FOR EACH ROW EXECUTE FUNCTION guard_external_source_metadata();
CREATE TRIGGER external_source_resource_guard BEFORE UPDATE OR DELETE ON external_source_resources FOR EACH ROW EXECUTE FUNCTION guard_external_source_metadata();
CREATE TRIGGER external_source_observation_guard BEFORE UPDATE OR DELETE ON external_source_observations FOR EACH ROW EXECUTE FUNCTION guard_external_source_metadata();
CREATE TRIGGER external_source_authorization_guard BEFORE UPDATE OR DELETE ON external_source_authorizations FOR EACH ROW EXECUTE FUNCTION guard_external_source_metadata();

CREATE TABLE connector_source_profile_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL REFERENCES connector_source_profiles(id) ON DELETE CASCADE,
 revision bigint NOT NULL,status text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION audit_connector_source_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO connector_source_profile_events(workspace_id,profile_id,revision,status) VALUES(NEW.workspace_id,NEW.id,NEW.revision,NEW.status);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION audit_connector_source_profile() FROM PUBLIC;
CREATE TRIGGER connector_source_profile_audit AFTER INSERT OR UPDATE ON connector_source_profiles FOR EACH ROW EXECUTE FUNCTION audit_connector_source_profile();
CREATE TRIGGER connector_source_profile_events_immutable BEFORE UPDATE ON connector_source_profile_events FOR EACH ROW EXECUTE FUNCTION application_receipt_immutable();

-- Compare canonical facts; this is a short lease revision, not a second ACL engine.
CREATE FUNCTION external_source_authority_fingerprint(w uuid,p uuid) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'workspace',to_jsonb(wk),'policy',(SELECT to_jsonb(v) FROM workspace_access_policies v WHERE v.workspace_id=w),
  'profile',to_jsonb(sp),'instance',to_jsonb(ci),
  'exposures',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM connector_grant g WHERE g.connector_instance_id=ci.id AND g.target_type='workspace' AND g.target_id=w),
  'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.user_id) FROM workspace_members m WHERE m.workspace_id=w),
  'assistants',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM assistants a WHERE a.workspace_id=w),
  'departments',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM department_edges e WHERE e.workspace_id=w AND (e.expires_at IS NULL OR e.expires_at>clock_timestamp())),
  'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM workspace_groups g WHERE g.workspace_id=w),
  'projects',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM project_shared_members e WHERE e.workspace_id=w AND (e.expires_at IS NULL OR e.expires_at>clock_timestamp())),
  'keys',(SELECT jsonb_agg(jsonb_build_array(k.kid,k.status) ORDER BY k.kid) FROM connector_actor_signing_keys k WHERE k.issuer=sp.issuer)
 )::text,'UTF8')),'hex')
 FROM connector_source_profiles sp JOIN workspaces wk ON wk.id=sp.workspace_id JOIN connector_instance ci ON ci.id=sp.connector_instance_id
 WHERE sp.id=p AND sp.workspace_id=w AND sp.status='qualified' AND ci.connected AND ci.health_status<>'auth_failed'
   AND (ci.scope='workspace' AND ci.workspace_id=w OR ci.scope='user' AND EXISTS(SELECT 1 FROM connector_grant g WHERE g.connector_instance_id=ci.id AND g.target_type='workspace' AND g.target_id=w))
$$;
REVOKE ALL ON FUNCTION external_source_authority_fingerprint(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION external_source_snapshot(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o external_source_observations;r external_source_resources;sp connector_source_profiles;allowed boolean;result jsonb;
BEGIN
 SELECT * INTO o FROM external_source_observations WHERE workspace_id=w AND id=i;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO r FROM external_source_resources WHERE workspace_id=w AND id=o.resource_id;
 SELECT * INTO sp FROM connector_source_profiles WHERE workspace_id=w AND id=r.profile_id;
 SELECT EXISTS(SELECT 1 FROM external_source_authorizations a WHERE a.workspace_id=w AND a.observation_id=i
  AND a.profile_id=sp.id AND a.profile_revision=sp.revision AND a.resource_revision=r.revision
  AND a.transaction_id=pg_current_xact_id() AND a.backend_pid=pg_backend_pid()
  AND a.operation_id=nullif(current_setting('app.external_source_operation_id',true),'')::uuid
  AND a.actor_id=nullif(current_setting('app.external_source_actor_id',true),'')::uuid
  AND a.assistant_id=nullif(current_setting('app.external_source_assistant_id',true),'')::uuid
  AND a.recipient_id=nullif(current_setting('app.current_user_id',true),'')::uuid
  AND a.recipient_assistant_id=nullif(current_setting('app.v2_assistant_id',true),'')::uuid
  AND a.action=nullif(current_setting('app.external_source_action',true),'')
  AND a.expires_at>clock_timestamp() AND a.authority_fingerprint=external_source_authority_fingerprint(w,sp.id)) INTO allowed;
 IF r.state IS DISTINCT FROM 'active' OR sp.status IS DISTINCT FROM 'qualified' OR allowed IS NOT TRUE THEN
  RETURN jsonb_build_object('held',true);
 END IF;
 result:=jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'resourceKind','external_source','resourceId',i,
  'version',o.version,'sensitivity',o.sensitivity,'compartments',to_jsonb(o.compartments),'projectIds',to_jsonb(o.project_ids),
  'held',r.state IS DISTINCT FROM 'active' OR sp.status IS DISTINCT FROM 'qualified' OR allowed IS NOT TRUE,'retractedAt',NULL,'validTo',NULL);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION external_source_snapshot(uuid,uuid) FROM PUBLIC;
ALTER FUNCTION read_scope_source(uuid,text,uuid) RENAME TO read_scope_source_before_external;
REVOKE ALL ON FUNCTION read_scope_source_before_external(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_scope_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF k='external_source' THEN RETURN external_source_snapshot(w,i); END IF;
 RETURN read_scope_source_before_external(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_scope_source(uuid,text,uuid) FROM PUBLIC;
ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check CHECK(source_kind IN
 ('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','crm_event','memory_verification','brain_verification','correction_audit','session_message','feedback_event','workspace_skill_revision','knowledge_source','recording','file_segment','transcript_segment','blueprint_record','browser_profile','browser_session','workflow_run',
 'page_event_changed','page_event_destination','page_live_changed','page_live_destination','external_source'));

ALTER TABLE connector_source_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_source_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_source_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_source_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_source_profile_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_source_profiles,external_source_resources,external_source_observations,external_source_authorizations,connector_source_profile_events FROM PUBLIC;
CREATE POLICY connector_source_profile_read ON connector_source_profiles FOR SELECT USING(application_governance_allows(workspace_id));
CREATE POLICY connector_source_profile_govern ON connector_source_profiles FOR ALL USING(application_governance_allows(workspace_id))
 WITH CHECK(application_governance_allows(workspace_id) AND (status<>'qualified' OR application_runtime_qualified(workspace_id,'connector_source')));
CREATE POLICY connector_source_profile_events_read ON connector_source_profile_events FOR SELECT USING(application_governance_allows(workspace_id));
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON external_source_resources,external_source_observations,external_source_authorizations FROM app_user;
  GRANT SELECT,INSERT,UPDATE ON connector_source_profiles TO app_user;
  GRANT SELECT ON connector_source_profile_events TO app_user;
  GRANT EXECUTE ON FUNCTION external_source_snapshot(uuid,uuid) TO app_user;
 END IF;
END $$;

COMMIT;
