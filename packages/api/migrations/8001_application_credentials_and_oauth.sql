BEGIN;

ALTER TABLE oauth_authorizations ADD COLUMN audience text NOT NULL DEFAULT 'brain' CHECK(audience IN('brain','application'));
ALTER TABLE oauth_authorizations ADD COLUMN application_client_id uuid REFERENCES application_clients(id) ON DELETE CASCADE;
ALTER TABLE oauth_authorizations ADD CONSTRAINT oauth_application_audience_binding
  CHECK((audience='brain' AND application_client_id IS NULL) OR (audience='application' AND application_client_id IS NOT NULL));

CREATE TABLE application_api_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issued_by_user_id uuid NOT NULL REFERENCES users(id),
  subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
  credential_kind text NOT NULL CHECK(credential_kind IN('service','delegated')),
  audience text NOT NULL DEFAULT 'application_data' CHECK(audience='application_data'),
  secret_hash text NOT NULL CHECK(secret_hash LIKE 'scrypt$%'),
  parent_grant_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN('active','revoked')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  client_revision bigint NOT NULL DEFAULT 1 CHECK(client_revision>0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  FOREIGN KEY(app_id,workspace_id) REFERENCES application_clients(id,workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(parent_grant_id,app_id,workspace_id) REFERENCES application_access_grants(id,app_id,workspace_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(id,app_id,workspace_id),
  CHECK(expires_at>created_at)
);
CREATE TABLE application_credential_grants (
  credential_id uuid NOT NULL,
  app_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  maximum_grant jsonb NOT NULL CHECK(jsonb_typeof(maximum_grant)='object'),
  PRIMARY KEY(credential_id,grant_id),
  FOREIGN KEY(credential_id,app_id,workspace_id) REFERENCES application_api_credentials(id,app_id,workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(grant_id,app_id,workspace_id) REFERENCES application_access_grants(id,app_id,workspace_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE application_oauth_bindings (
  authorization_id uuid PRIMARY KEY REFERENCES oauth_authorizations(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  principal_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_grant_id uuid NOT NULL,
  maximum_grants jsonb NOT NULL CHECK(jsonb_typeof(maximum_grants)='array'),
  maximum_hash text NOT NULL CHECK(maximum_hash ~ '^[0-9a-f]{64}$'),
  client_revision bigint NOT NULL DEFAULT 1 CHECK(client_revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(app_id,workspace_id) REFERENCES application_clients(id,workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(parent_grant_id,app_id,workspace_id) REFERENCES application_access_grants(id,app_id,workspace_id) DEFERRABLE INITIALLY DEFERRED
);

-- Capture the complete canonical chain in SQL. Request JSON cannot invent a
-- broader issuance maximum, omit an ancestor, or substitute another subject.
CREATE FUNCTION application_snapshot_grant_path(leaf_id uuid,application_id uuid,w uuid,subject_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g application_access_grants; path jsonb:='[]'; seen uuid[]:='{}'; next_id uuid:=leaf_id;
BEGIN
  WHILE next_id IS NOT NULL LOOP
    SELECT * INTO g FROM application_access_grants WHERE id=next_id AND app_id=application_id AND workspace_id=w;
    IF NOT FOUND OR g.id=ANY(seen) OR cardinality(seen)>=16 OR g.status<>'active' OR g.starts_at>statement_timestamp()
      OR g.expires_at<=statement_timestamp() OR cardinality(seen)=0 AND g.principal_user_id<>subject_id
      OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=g.issued_by_user_id AND m.role IN('owner','admin')) THEN
      RAISE EXCEPTION 'invalid_value: grant path unavailable' USING ERRCODE='22023';
    END IF;
    path:=path||jsonb_build_array(jsonb_build_object('id',g.id,'appId',g.app_id,'workspaceId',g.workspace_id,
      'principal',jsonb_build_object('kind',g.principal_kind,'userId',g.principal_user_id),'origin',g.resource_origin,'typeKey',g.resource_type,
      'actions',g.actions,'readFields',g.read_fields,'writeFields',g.write_fields,'selector',g.selector,'version',g.version,'status',g.status,
      'startsAt',g.starts_at,'expiresAt',g.expires_at,'parentGrantId',g.parent_grant_id,'compartments',g.compartments,'projectIds',g.project_ids,'clearance',g.clearance));
    seen:=array_append(seen,g.id);next_id:=g.parent_grant_id;
  END LOOP;
  IF jsonb_array_length(path)=0 THEN RAISE EXCEPTION 'invalid_value: grant path required' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('version',1,'grants',path);
END;
$$;
REVOKE ALL ON FUNCTION application_snapshot_grant_path(uuid,uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION application_oauth_consent_snapshot(application_id uuid,subject_id uuid,grant_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE app application_clients; g application_access_grants; maxima jsonb:='[]'; requested uuid; ids uuid[]:='{}';
BEGIN
  SELECT * INTO app FROM application_clients WHERE id=application_id AND status='active' AND client_mode='external_frontend' AND oauth_client_id IS NOT NULL;
  IF NOT FOUND OR cardinality(grant_ids) NOT BETWEEN 1 AND 128 OR NOT EXISTS(SELECT 1 FROM users u WHERE u.id=subject_id AND u.auth_provider<>'channel') THEN RETURN NULL; END IF;
  FOR requested IN SELECT DISTINCT x FROM unnest(grant_ids) x ORDER BY x LOOP
    SELECT * INTO g FROM application_access_grants WHERE id=requested AND app_id=app.id AND workspace_id=app.workspace_id
      AND principal_user_id=subject_id AND principal_kind IN('member','external_user');
    IF NOT FOUND OR g.principal_kind='member' AND NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=app.workspace_id AND m.user_id=subject_id) THEN RETURN NULL; END IF;
    maxima:=maxima||jsonb_build_array(application_snapshot_grant_path(g.id,app.id,app.workspace_id,subject_id));
    ids:=array_append(ids,g.id);
  END LOOP;
  IF cardinality(ids)<>cardinality(grant_ids) THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('appId',app.id,'workspaceId',app.workspace_id,'clientId',app.oauth_client_id,'revision',app.grant_revision::text,
    'grantIds',ids,'parentGrantId',ids[1],'maxima',maxima,'maximumHash',encode(sha256(convert_to(maxima::text,'UTF8')),'hex'));
EXCEPTION WHEN invalid_parameter_value THEN RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION application_oauth_consent_snapshot(uuid,uuid,uuid[]) FROM PUBLIC;

CREATE FUNCTION application_credential_maximum_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE subject_id uuid;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'invalid_value: immutable issuance maximum' USING ERRCODE='22023'; END IF;
  SELECT subject_user_id INTO subject_id FROM application_api_credentials WHERE id=NEW.credential_id AND app_id=NEW.app_id AND workspace_id=NEW.workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_value: credential unavailable' USING ERRCODE='22023'; END IF;
  NEW.maximum_grant:=application_snapshot_grant_path(NEW.grant_id,NEW.app_id,NEW.workspace_id,subject_id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION application_credential_maximum_guard() FROM PUBLIC;
CREATE TRIGGER application_credential_maximum_guard BEFORE INSERT OR UPDATE ON application_credential_grants FOR EACH ROW EXECUTE FUNCTION application_credential_maximum_guard();

CREATE FUNCTION application_credential_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE provider text; provider_id text;
BEGIN
  IF TG_OP='INSERT' AND nullif(current_setting('app.current_user_id',true),'') IS NOT NULL
    AND NEW.issued_by_user_id::text<>current_setting('app.current_user_id',true) THEN
    RAISE EXCEPTION 'invalid_value: credential issuer mismatch' USING ERRCODE='22023';
  END IF;
  IF TG_OP='INSERT' THEN SELECT grant_revision INTO NEW.client_revision FROM application_clients WHERE id=NEW.app_id AND workspace_id=NEW.workspace_id; END IF;
  SELECT auth_provider,auth_provider_id INTO provider,provider_id FROM users WHERE id=NEW.subject_user_id;
  IF provider IS DISTINCT FROM 'channel' OR NOT coalesce(provider_id LIKE 'app-service:'||NEW.app_id::text||':%',false) THEN
    RAISE EXCEPTION 'invalid_value: named service identity required' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM application_access_grants g WHERE g.id=NEW.parent_grant_id AND g.app_id=NEW.app_id
    AND g.workspace_id=NEW.workspace_id AND g.principal_kind='service' AND g.principal_user_id=NEW.subject_user_id) THEN
    RAISE EXCEPTION 'invalid_value: service parent grant unavailable' USING ERRCODE='22023';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['status','version','revoked_at','last_used_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','version','revoked_at','last_used_at']) THEN
      RAISE EXCEPTION 'invalid_value: immutable credential ceiling' USING ERRCODE='22023';
    END IF;
    NEW.version:=OLD.version+CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN 1 ELSE 0 END;
    IF NEW.status='revoked' THEN NEW.revoked_at:=coalesce(OLD.revoked_at,clock_timestamp()); END IF;
    IF OLD.status='revoked' AND NEW.status<>'revoked' THEN RAISE EXCEPTION 'grant_revoked' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION application_credential_guard() FROM PUBLIC;
CREATE TRIGGER application_credential_guard BEFORE INSERT OR UPDATE ON application_api_credentials FOR EACH ROW EXECUTE FUNCTION application_credential_guard();

CREATE FUNCTION application_oauth_binding_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE maximum jsonb; maxima jsonb:='[]'; ids uuid[]:='{}'; leaf_id uuid;
BEGIN
  IF TG_OP='INSERT' THEN SELECT grant_revision INTO NEW.client_revision FROM application_clients WHERE id=NEW.app_id AND workspace_id=NEW.workspace_id; END IF;
  IF NOT EXISTS(SELECT 1 FROM oauth_authorizations a WHERE a.id=NEW.authorization_id AND a.audience='application'
    AND a.application_client_id=NEW.app_id AND a.workspace_id=NEW.workspace_id AND a.user_id=NEW.principal_user_id) THEN
    RAISE EXCEPTION 'invalid_value: OAuth audience binding mismatch' USING ERRCODE='22023';
  END IF;
  IF TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'invalid_value: immutable OAuth ceiling' USING ERRCODE='22023'; END IF;
  IF TG_OP='INSERT' THEN
    IF jsonb_array_length(NEW.maximum_grants) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'invalid_value: consent maximum required' USING ERRCODE='22023'; END IF;
    FOR maximum IN SELECT value FROM jsonb_array_elements(NEW.maximum_grants) LOOP
      leaf_id:=(maximum->'grants'->0->>'id')::uuid;
      IF leaf_id IS NULL OR leaf_id=ANY(ids) THEN RAISE EXCEPTION 'invalid_value: duplicate consent grant' USING ERRCODE='22023'; END IF;
      maxima:=maxima||jsonb_build_array(application_snapshot_grant_path(leaf_id,NEW.app_id,NEW.workspace_id,NEW.principal_user_id));
      ids:=array_append(ids,leaf_id);
    END LOOP;
    IF NOT NEW.parent_grant_id=ANY(ids) THEN RAISE EXCEPTION 'invalid_value: parent consent required' USING ERRCODE='22023'; END IF;
    IF NEW.maximum_hash IS NOT NULL AND NEW.maximum_hash<>encode(sha256(convert_to(maxima::text,'UTF8')),'hex') THEN
      RAISE EXCEPTION 'invalid_value: reviewed consent changed' USING ERRCODE='22023';
    END IF;
    NEW.maximum_grants:=maxima;
    NEW.maximum_hash:=encode(sha256(convert_to(maxima::text,'UTF8')),'hex');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION application_oauth_binding_guard() FROM PUBLIC;
CREATE TRIGGER application_oauth_binding_guard BEFORE INSERT OR UPDATE ON application_oauth_bindings FOR EACH ROW EXECUTE FUNCTION application_oauth_binding_guard();
CREATE FUNCTION application_oauth_audience_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.audience<>OLD.audience OR NEW.application_client_id IS DISTINCT FROM OLD.application_client_id THEN
    RAISE EXCEPTION 'invalid_value: immutable OAuth audience' USING ERRCODE='22023';
  END IF;
  IF OLD.audience='application' AND (NEW.client_id<>OLD.client_id OR NEW.user_id<>OLD.user_id OR NEW.workspace_id<>OLD.workspace_id) THEN
    RAISE EXCEPTION 'invalid_value: immutable OAuth subject binding' USING ERRCODE='22023';
  END IF;
  IF OLD.audience='application' AND OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'grant_revoked' USING ERRCODE='22023';
  END IF;
  IF OLD.audience='application' AND nullif(current_setting('app.current_user_id',true),'') IS NOT NULL
    AND NOT application_governance_allows(OLD.workspace_id) THEN
    IF NEW.revoked_at IS NULL OR (to_jsonb(NEW)-ARRAY['revoked_at','code_hash','access_token_hash','refresh_token_hash'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','code_hash','access_token_hash','refresh_token_hash'])
      OR NEW.code_hash IS NOT NULL OR NEW.access_token_hash IS NOT NULL OR NEW.refresh_token_hash IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_value: only self-revocation is allowed' USING ERRCODE='22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER application_oauth_audience_guard BEFORE UPDATE ON oauth_authorizations FOR EACH ROW EXECUTE FUNCTION application_oauth_audience_guard();

-- Shared OAuth protocol operations recheck the same application/parent binding
-- at lookup and token CAS. This helper reads authentication metadata only.
CREATE FUNCTION application_oauth_binding_current(authorization_id uuid,application_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a oauth_authorizations; b application_oauth_bindings; g application_access_grants; next_id uuid; seen uuid[]:='{}';
BEGIN
  SELECT * INTO a FROM oauth_authorizations WHERE id=authorization_id AND audience='application' AND application_client_id=application_id AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT binding.* INTO b FROM application_oauth_bindings binding JOIN application_clients client ON client.id=binding.app_id AND client.workspace_id=binding.workspace_id
    AND client.status='active' AND client.grant_revision=binding.client_revision
    WHERE binding.authorization_id=a.id AND binding.app_id=application_id AND binding.workspace_id=a.workspace_id AND binding.principal_user_id=a.user_id;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM users u WHERE u.id=a.user_id AND u.auth_provider<>'channel') THEN RETURN false; END IF;
  next_id:=b.parent_grant_id;
  WHILE next_id IS NOT NULL LOOP
    SELECT * INTO g FROM application_access_grants WHERE id=next_id AND app_id=b.app_id AND workspace_id=b.workspace_id;
    IF NOT FOUND OR g.id=ANY(seen) OR cardinality(seen)>=16 OR g.status<>'active' OR g.starts_at>statement_timestamp() OR g.expires_at<=statement_timestamp()
      OR cardinality(seen)=0 AND (g.principal_user_id<>a.user_id OR g.principal_kind NOT IN('member','external_user')
        OR g.principal_kind='member' AND NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=a.workspace_id AND m.user_id=a.user_id))
      OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=g.workspace_id AND m.user_id=g.issued_by_user_id AND m.role IN('owner','admin')) THEN RETURN false; END IF;
    seen:=array_append(seen,g.id);next_id:=g.parent_grant_id;
  END LOOP;
  RETURN cardinality(seen)>0;
END;
$$;
REVOKE ALL ON FUNCTION application_oauth_binding_current(uuid,uuid) FROM PUBLIC;

ALTER TABLE application_api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_credential_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_oauth_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_credential_read ON application_api_credentials FOR SELECT
  USING(application_governance_allows(workspace_id));
CREATE POLICY application_credential_govern ON application_api_credentials FOR ALL USING(application_governance_allows(workspace_id))
  WITH CHECK(application_governance_allows(workspace_id) AND (status='revoked' OR application_runtime_qualified(workspace_id,'application_data')));
CREATE POLICY application_credential_grant_read ON application_credential_grants FOR SELECT
  USING(application_governance_allows(workspace_id));
CREATE POLICY application_credential_grant_create ON application_credential_grants FOR INSERT
  WITH CHECK(application_governance_allows(workspace_id) AND application_runtime_qualified(workspace_id,'application_data'));
CREATE POLICY application_oauth_binding_read ON application_oauth_bindings FOR SELECT
  USING(application_governance_allows(workspace_id) OR principal_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid);
CREATE POLICY application_oauth_binding_create ON application_oauth_bindings FOR INSERT
  WITH CHECK(principal_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND application_runtime_qualified(workspace_id,'application_data'));

CREATE POLICY application_oauth_subject_read ON oauth_authorizations FOR SELECT
  USING(audience='application' AND user_id=nullif(current_setting('app.current_user_id',true),'')::uuid);
CREATE POLICY application_oauth_subject_create ON oauth_authorizations FOR INSERT
  WITH CHECK(audience='application' AND user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
    AND application_runtime_qualified(workspace_id,'application_data')
    AND EXISTS(SELECT 1 FROM application_access_grants g WHERE g.app_id=application_client_id AND g.workspace_id=oauth_authorizations.workspace_id
      AND g.principal_user_id=oauth_authorizations.user_id AND g.status='active' AND g.starts_at<=now() AND (g.expires_at IS NULL OR g.expires_at>now())));
CREATE POLICY application_oauth_subject_revoke ON oauth_authorizations FOR UPDATE
  USING(audience='application' AND user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
  WITH CHECK(audience='application' AND user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
    AND (revoked_at IS NOT NULL OR application_runtime_qualified(workspace_id,'application_data')));

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='app_user') THEN
    GRANT SELECT,INSERT,UPDATE ON application_api_credentials TO app_user;
    GRANT SELECT,INSERT ON application_credential_grants,application_oauth_bindings TO app_user;
  END IF;
END $$;
COMMIT;
