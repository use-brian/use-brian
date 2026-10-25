-- Spec: docs/architecture/features/application-platform-management.md
-- [COMP:api/application-management] Deployed native service capability, not global qualification.
BEGIN;
CREATE TABLE application_scoped_activations (
 app_id uuid PRIMARY KEY REFERENCES application_clients(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 profile text NOT NULL CHECK(profile='canonical_service_v1'),
 app_revision bigint NOT NULL,assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 activated_by uuid NOT NULL REFERENCES users(id),version uuid NOT NULL DEFAULT gen_random_uuid(),status text NOT NULL CHECK(status IN('active','revoked')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE application_scoped_activations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON application_scoped_activations FROM PUBLIC;
CREATE POLICY application_scoped_activation_read ON application_scoped_activations FOR SELECT USING(application_governance_allows(workspace_id));
CREATE TABLE application_activation_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),app_id uuid NOT NULL REFERENCES application_clients(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,actor_id uuid NOT NULL REFERENCES users(id),
 snapshot jsonb NOT NULL,expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes',
 consumed boolean NOT NULL DEFAULT false
);
ALTER TABLE application_activation_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON application_activation_reviews FROM PUBLIC;
CREATE POLICY application_activation_review_read ON application_activation_reviews FOR SELECT USING(actor_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND application_governance_allows(workspace_id));
CREATE FUNCTION application_scoped_qualified(w uuid,a uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM application_scoped_activations s JOIN application_clients c ON c.id=s.app_id AND c.workspace_id=s.workspace_id
 JOIN assistants agent ON agent.id=s.assistant_id AND agent.workspace_id=s.workspace_id
 JOIN workspace_members issuer ON issuer.workspace_id=s.workspace_id AND issuer.user_id=s.activated_by AND issuer.role IN('owner','admin')
 WHERE s.app_id=a AND s.workspace_id=w AND s.status='active' AND s.profile='canonical_service_v1'
 AND c.status='active' AND c.client_mode='api_client' AND c.module_key='native'
 AND c.grant_revision=s.app_revision AND c.executing_assistant_id=s.assistant_id)
$$;
CREATE FUNCTION application_scoped_grant_allowed(a uuid,p jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE w uuid; fields text[]; actions text[];
BEGIN
 SELECT workspace_id INTO w FROM application_clients WHERE id=a;
 IF application_scoped_qualified(w,a) IS NOT TRUE OR p->'principal'->>'kind' IS DISTINCT FROM 'service'
 OR p->'origin' IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
 OR p->>'typeKey' NOT IN('company','deal') OR p->'selector'->>'kind' NOT IN('self','ids') THEN RETURN false; END IF;
 fields:=CASE p->>'typeKey' WHEN 'company' THEN ARRAY['name','domain'] ELSE ARRAY['name','companyId','stage','amount','currencyCode'] END;
 actions:=CASE p->>'typeKey' WHEN 'company' THEN ARRAY['read','query','schema','create','patch','command:create_company','command:patch_company','command:patch_records']
 ELSE ARRAY['read','query','schema','create','patch','command:create_deal','command:patch_deal','command:set_deal_stage','command:patch_records'] END;
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'actions') x WHERE NOT x=ANY(actions))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'readFields') x WHERE NOT x=ANY(fields))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'writeFields') x WHERE NOT x=ANY(fields));
EXCEPTION WHEN invalid_parameter_value THEN RETURN false;
END $$;
CREATE FUNCTION application_scoped_credential_allowed(a uuid,p jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT p->>'kind'='service' AND jsonb_array_length(p->'grantIds')>0
 AND EXISTS(SELECT 1 FROM application_clients c WHERE c.id=a AND application_scoped_qualified(c.workspace_id,c.id))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'grantIds') id LEFT JOIN application_access_grants g ON g.id=id::uuid AND g.app_id=a
 WHERE g.id IS NULL OR g.principal_kind<>'service' OR g.principal_user_id::text IS DISTINCT FROM p->>'serviceUserId'
 OR application_scoped_grant_allowed(a,jsonb_build_object('principal',jsonb_build_object('kind',g.principal_kind,'userId',g.principal_user_id),
 'origin',g.resource_origin,'typeKey',g.resource_type,'selector',g.selector,'actions',g.actions,'readFields',g.read_fields,'writeFields',g.write_fields)) IS NOT TRUE)
$$;
CREATE FUNCTION application_activation_snapshot(a uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c application_clients;agent assistants;
BEGIN
 SELECT * INTO c FROM application_clients WHERE id=a AND client_mode='api_client' AND module_key='native' AND status='active';
 IF c.id IS NULL OR application_governance_allows(c.workspace_id) IS NOT TRUE OR nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
 RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO agent FROM assistants WHERE id=c.executing_assistant_id AND workspace_id=c.workspace_id AND assistant_placement_visible(nullif(current_setting('app.current_user_id',true),'')::uuid,id);
 IF agent.id IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('profile','canonical_service_v1','application',to_jsonb(c),'assistant',to_jsonb(agent));
END $$;
CREATE FUNCTION application_prepare_activation(a uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s jsonb;r uuid;
BEGIN
 s:=application_activation_snapshot(a);
 INSERT INTO application_activation_reviews(app_id,workspace_id,actor_id,snapshot) VALUES(a,(s#>>'{application,workspace_id}')::uuid,nullif(current_setting('app.current_user_id',true),'')::uuid,s) RETURNING id INTO r;
 RETURN r;
END $$;
CREATE FUNCTION application_apply_activation(r uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v application_activation_reviews;s jsonb;
BEGIN
 SELECT * INTO v FROM application_activation_reviews WHERE id=r AND actor_id=nullif(current_setting('app.current_user_id',true),'')::uuid FOR UPDATE;
 IF v.id IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 PERFORM id FROM application_clients WHERE id=v.app_id FOR SHARE;
 s:=application_activation_snapshot(v.app_id);
 IF v.expires_at<=clock_timestamp() OR s IS DISTINCT FROM v.snapshot THEN RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001'; END IF;
 IF v.consumed THEN
 IF application_scoped_qualified(v.workspace_id,v.app_id) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 RETURN v.app_id; END IF;
 INSERT INTO application_scoped_activations(app_id,workspace_id,profile,app_revision,assistant_id,activated_by,status)
 VALUES(v.app_id,v.workspace_id,'canonical_service_v1',(s#>>'{application,grant_revision}')::bigint,(s#>>'{application,executing_assistant_id}')::uuid,v.actor_id,'active')
 ON CONFLICT(app_id) DO UPDATE SET app_revision=excluded.app_revision,assistant_id=excluded.assistant_id,activated_by=excluded.activated_by,status='active',version=gen_random_uuid();
 UPDATE application_activation_reviews SET consumed=true WHERE id=r;
 INSERT INTO application_authority_events(workspace_id,app_id,actor_user_id,action,resource_id) VALUES(v.workspace_id,v.app_id,v.actor_id,'client_status_changed',v.app_id);
 RETURN v.app_id;
END $$;
CREATE FUNCTION application_revoke_activation(a uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE w uuid;
BEGIN
 SELECT workspace_id INTO w FROM application_clients WHERE id=a;
 IF application_governance_allows(w) IS NOT TRUE OR nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 UPDATE application_scoped_activations SET status='revoked',version=gen_random_uuid() WHERE app_id=a AND status='active';
 RETURN FOUND;
END $$;
ALTER TABLE application_api_credentials ADD COLUMN activation_version uuid;
CREATE FUNCTION application_scoped_credential_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM application_scoped_activations WHERE app_id=NEW.app_id) THEN
  IF application_scoped_qualified(NEW.workspace_id,NEW.app_id) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  SELECT version INTO NEW.activation_version FROM application_scoped_activations WHERE app_id=NEW.app_id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_scoped_credential_version() FROM PUBLIC;
CREATE TRIGGER application_scoped_credential_version BEFORE INSERT ON application_api_credentials FOR EACH ROW EXECUTE FUNCTION application_scoped_credential_version();
CREATE FUNCTION application_scoped_credential_current(a uuid,c uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT (NOT EXISTS(SELECT 1 FROM application_scoped_activations WHERE app_id=a)
 AND (c IS NULL OR EXISTS(SELECT 1 FROM application_api_credentials k WHERE k.id=c AND k.app_id=a AND k.activation_version IS NULL)))
 OR EXISTS(SELECT 1 FROM application_scoped_activations s JOIN application_api_credentials k ON k.app_id=s.app_id AND k.activation_version=s.version
 WHERE s.app_id=a AND k.id=c AND k.credential_kind='service' AND application_scoped_qualified(s.workspace_id,a))
$$;
ALTER FUNCTION application_current_maxima() RENAME TO application_current_maxima_before_scoped;
REVOKE ALL ON FUNCTION application_current_maxima_before_scoped() FROM PUBLIC;
CREATE FUNCTION application_current_maxima() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a uuid:=nullif(current_setting('app.application_id',true),'')::uuid;c uuid:=nullif(current_setting('app.application_credential_id',true),'')::uuid;
BEGIN
 IF a IS NOT NULL AND application_scoped_credential_current(a,c) IS NOT TRUE THEN RETURN NULL; END IF;
 RETURN application_current_maxima_before_scoped();
END $$;
REVOKE ALL ON FUNCTION application_current_maxima(),application_scoped_credential_current(uuid,uuid) FROM PUBLIC;
-- Native release review uses the same deployed field vocabulary as reads and commands.
DO $vocabulary$ DECLARE definition text;original text;BEGIN
 definition:=pg_get_functiondef('application_grant_release_snapshot_before_source_service(uuid,jsonb)'::regprocedure);
 original:=$old$fields:=CASE proposal->>'typeKey' WHEN 'company' THEN ARRAY['name','domain'] WHEN 'person' THEN ARRAY['name','email','phone']
      WHEN 'deal' THEN ARRAY['name','stage','amount'] WHEN 'task' THEN ARRAY['title','status'] WHEN 'file' THEN ARRAY['name','mimeType','sizeBytes','storageRef'] WHEN 'workspace_member' THEN ARRAY['id'] ELSE NULL END;$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'native_release_vocabulary_changed'; END IF;
 EXECUTE replace(definition,original,'fields:=nullif(application_native_field_keys(proposal->>''typeKey''),''{}''::text[]);');
END $vocabulary$;
-- Amend only exact deployed guard definitions. Unknown prerequisites abort the migration.
DO $amend$ DECLARE signature text;definition text;original text;replacement text;BEGIN
 FOR signature,original,replacement IN SELECT * FROM (VALUES
 ('application_reviewed_grant_guard()','application_runtime_qualified(NEW.workspace_id,''application_data'')','(application_runtime_qualified(NEW.workspace_id,''application_data'') OR application_scoped_grant_allowed(NEW.app_id,review.proposed_grant))'),
 ('application_apply_grant_review(uuid)','application_runtime_qualified(review.workspace_id,''application_data'')','(application_runtime_qualified(review.workspace_id,''application_data'') OR application_scoped_grant_allowed(review.app_id,review.proposed_grant))'),
 ('application_reviewed_credential_guard()','application_runtime_qualified(NEW.workspace_id,''application_data'')','(application_runtime_qualified(NEW.workspace_id,''application_data'') OR application_scoped_credential_allowed(NEW.app_id,review.proposal))'),
 ('application_apply_credential_review(uuid,uuid,text)','application_runtime_qualified(review.workspace_id,''application_data'')','(application_runtime_qualified(review.workspace_id,''application_data'') OR application_scoped_credential_allowed(review.app_id,review.proposal))')
 ) changes(signature,original,replacement) LOOP
 definition:=pg_get_functiondef(('public.'||signature)::regprocedure);
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'scoped_activation_prerequisite_changed: %',signature; END IF;
 EXECUTE replace(definition,original,replacement);
 END LOOP;
END $amend$;
-- The public profile is immutable deployed code; owner review selects its app, never its rules.
REVOKE ALL ON FUNCTION application_scoped_qualified(uuid,uuid),application_scoped_grant_allowed(uuid,jsonb),application_scoped_credential_allowed(uuid,jsonb),application_activation_snapshot(uuid),application_prepare_activation(uuid),application_apply_activation(uuid),application_revoke_activation(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT SELECT ON application_scoped_activations,application_activation_reviews TO app_user;
 GRANT EXECUTE ON FUNCTION application_scoped_qualified(uuid,uuid),application_scoped_grant_allowed(uuid,jsonb),application_scoped_credential_allowed(uuid,jsonb),application_scoped_credential_current(uuid,uuid),application_prepare_activation(uuid),application_apply_activation(uuid),application_revoke_activation(uuid) TO app_user;
END IF;END $$;
COMMIT;
