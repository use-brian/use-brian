-- Spec: docs/architecture/features/application-platform-management.md
-- [COMP:api/attended-source-setup] Scoped human connector admission, not global application qualification.
BEGIN;

ALTER TABLE connector_source_profiles ADD COLUMN attended_profile text
 CHECK(attended_profile IS NULL OR attended_profile IN('attended_governed_read_v1','attended_governed_actions_v1'));
ALTER TABLE connector_source_profiles ADD COLUMN attended_actions jsonb
 CHECK(attended_actions IS NULL OR jsonb_typeof(attended_actions)='object');
CREATE FUNCTION guard_attended_source_profile() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.attended_profile IS DISTINCT FROM OLD.attended_profile OR NEW.attended_actions IS DISTINCT FROM OLD.attended_actions THEN
  RAISE EXCEPTION 'source_profile_immutable' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attended_source_profile_immutable BEFORE UPDATE ON connector_source_profiles
 FOR EACH ROW EXECUTE FUNCTION guard_attended_source_profile();
REVOKE ALL ON FUNCTION guard_attended_source_profile() FROM PUBLIC;

CREATE TABLE connector_attended_setup_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES users(id),
 assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL REFERENCES connector_source_profiles(id) ON DELETE CASCADE,
 proposal jsonb NOT NULL,
 snapshot text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
 consumed boolean NOT NULL DEFAULT false
);
CREATE TABLE connector_attended_setup_approvals (
 id uuid PRIMARY KEY,
 review_id uuid NOT NULL REFERENCES connector_attended_setup_reviews(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES users(id),
 snapshot text NOT NULL,
 proof_digest text NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE connector_attended_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL REFERENCES connector_source_profiles(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL,
 assistant_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 tool text NOT NULL,
 input_digest text NOT NULL,
 state text NOT NULL DEFAULT 'uncertain' CHECK(state IN('uncertain','applied')),
 receipt text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,actor_id,assistant_id,operation_id)
);
ALTER TABLE connector_attended_setup_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_attended_setup_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_attended_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_attended_setup_reviews,connector_attended_setup_approvals,connector_attended_commands FROM PUBLIC;
CREATE POLICY connector_attended_setup_read ON connector_attended_setup_reviews FOR SELECT
 USING(actor_id=nullif(current_setting('app.current_user_id',true),'')::uuid
  AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.owner_user_id=actor_id));

CREATE FUNCTION connector_attended_setup_snapshot(w uuid,i uuid,a uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(to_jsonb(ci),to_jsonb(agent),to_jsonb(m))::text,'UTF8')),'hex')
 FROM workspaces ws JOIN workspace_members m ON m.workspace_id=ws.id AND m.user_id=ws.owner_user_id
 JOIN connector_instance ci ON ci.id=i AND ci.scope='workspace' AND ci.workspace_id=ws.id
 JOIN assistants agent ON agent.id=a AND agent.workspace_id=ws.id
 WHERE ws.id=w AND ws.owner_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
 AND m.role='owner' AND ci.connected AND ci.health_status<>'auth_failed'
 AND nullif(current_setting('app.application_id',true),'') IS NULL
$$;

CREATE FUNCTION connector_prepare_attended_source(w uuid,i uuid,a uuid,p jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s text; profile uuid; review uuid;
BEGIN
 PERFORM 1 FROM connector_instance WHERE id=i FOR UPDATE;
 s:=connector_attended_setup_snapshot(w,i,a);
 IF s IS NULL OR jsonb_typeof(p)<>'object'
  OR NOT p ?& ARRAY['tenant','issuer','audience','sourceBaseUrl','mcpUrl','probeTool','probeInput']
  OR p-ARRAY['tenant','issuer','audience','sourceBaseUrl','mcpUrl','probeTool','probeInput','httpReadPath','actions']<>'{}'::jsonb
  OR p->>'mcpUrl' IS DISTINCT FROM (SELECT url FROM connector_instance WHERE id=i)
  OR EXISTS(SELECT 1 FROM connector_source_profiles WHERE workspace_id=w AND original_connector_instance_id=i AND status<>'revoked') THEN
  RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501';
 END IF;
 INSERT INTO connector_source_profiles(workspace_id,connector_instance_id,tenant,issuer,audience,source_base_url,mcp_url,http_read_path,status,created_by_user_id,attended_profile,attended_actions)
 VALUES(w,i,p->>'tenant',p->>'issuer',p->>'audience',p->>'sourceBaseUrl',p->>'mcpUrl',p->>'httpReadPath','pending',nullif(current_setting('app.current_user_id',true),'')::uuid,
  CASE WHEN p ? 'actions' THEN 'attended_governed_actions_v1' ELSE 'attended_governed_read_v1' END,p->'actions')
 RETURNING id INTO profile;
 INSERT INTO connector_attended_setup_reviews(workspace_id,actor_id,assistant_id,profile_id,proposal,snapshot)
 VALUES(w,nullif(current_setting('app.current_user_id',true),'')::uuid,a,profile,p,s) RETURNING id INTO review;
 RETURN review;
END $$;

CREATE FUNCTION connector_apply_attended_source(r uuid,approval uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v connector_attended_setup_reviews; p connector_source_profiles; s text;
BEGIN
 SELECT * INTO v FROM connector_attended_setup_reviews WHERE id=r FOR UPDATE;
 IF NOT FOUND OR v.actor_id IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid THEN
  RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501';
 END IF;
 SELECT * INTO p FROM connector_source_profiles WHERE id=v.profile_id FOR UPDATE;
 s:=connector_attended_setup_snapshot(v.workspace_id,p.connector_instance_id,v.assistant_id);
 IF s IS NULL OR s<>v.snapshot OR p.attended_profile NOT IN('attended_governed_read_v1','attended_governed_actions_v1') OR p.scoped_app_id IS NOT NULL
  OR p.status='revoked' THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501'; END IF;
 IF v.consumed THEN
  IF p.status<>'qualified' THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501'; END IF;
  RETURN p.id;
 END IF;
 IF v.expires_at<=clock_timestamp() OR p.status<>'pending' OR p.revision<>1
  OR NOT EXISTS(SELECT 1 FROM connector_attended_setup_approvals x WHERE x.id=approval AND x.review_id=v.id
   AND x.actor_id=v.actor_id AND x.snapshot=s AND x.expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501';
 END IF;
 UPDATE connector_source_profiles SET status='qualified' WHERE id=p.id;
 UPDATE connector_attended_setup_reviews SET consumed=true WHERE id=v.id;
 RETURN p.id;
END $$;

CREATE FUNCTION connector_revoke_attended_source(w uuid,p uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM workspaces ws JOIN workspace_members m ON m.workspace_id=ws.id AND m.user_id=ws.owner_user_id
  WHERE ws.id=w AND ws.owner_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND m.role='owner')
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501';
 END IF;
 UPDATE connector_source_profiles SET status='revoked' WHERE id=p AND workspace_id=w
  AND attended_profile IN('attended_governed_read_v1','attended_governed_actions_v1') AND status<>'revoked';
 RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION connector_attended_setup_snapshot(uuid,uuid,uuid),connector_prepare_attended_source(uuid,uuid,uuid,jsonb),
 connector_apply_attended_source(uuid,uuid),connector_revoke_attended_source(uuid,uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON connector_attended_setup_reviews,connector_attended_setup_approvals,connector_attended_commands FROM app_user;
  GRANT SELECT ON connector_attended_setup_reviews TO app_user;
  GRANT EXECUTE ON FUNCTION connector_attended_setup_snapshot(uuid,uuid,uuid),connector_prepare_attended_source(uuid,uuid,uuid,jsonb),
   connector_apply_attended_source(uuid,uuid),connector_revoke_attended_source(uuid,uuid) TO app_user;
 END IF;
END $$;
COMMIT;
