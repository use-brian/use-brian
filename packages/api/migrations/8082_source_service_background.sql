-- Spec: docs/architecture/features/application-platform.md, reviewed service-source background binding.
BEGIN;

CREATE TABLE source_service_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL REFERENCES connector_source_profiles(id) ON DELETE CASCADE,
 app_id uuid NOT NULL REFERENCES application_clients(id) ON DELETE CASCADE,
 credential_id uuid NOT NULL REFERENCES application_api_credentials(id) ON DELETE CASCADE,
 service_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 workflow_id uuid REFERENCES workflows(id) ON DELETE CASCADE,
 configured_by_user_id uuid NOT NULL REFERENCES users(id),
 authority_fingerprint text NOT NULL CHECK(authority_fingerprint ~ '^[a-f0-9]{64}$'),
 definition_fingerprint text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','active','revoked')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,workspace_id)
);
CREATE UNIQUE INDEX source_service_active_workflow ON source_service_bindings(workflow_id) WHERE status<>'revoked' AND workflow_id IS NOT NULL;
ALTER TABLE source_service_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON source_service_bindings FROM PUBLIC;
CREATE POLICY source_service_binding_native_read ON source_service_bindings FOR SELECT USING(application_governance_allows(workspace_id));
CREATE FUNCTION source_service_binding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['status','revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','revision']) OR OLD.status='revoked' THEN
   RAISE EXCEPTION 'source_service_binding_immutable' USING ERRCODE='22023';
  END IF;
  NEW.revision:=OLD.revision+1;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION source_service_binding_guard() FROM PUBLIC;
CREATE TRIGGER source_service_binding_guard BEFORE UPDATE ON source_service_bindings FOR EACH ROW EXECUTE FUNCTION source_service_binding_guard();

-- Canonical references/current ceilings only; no secret bytes or source business ACL.
CREATE FUNCTION source_service_authority_fingerprint(w uuid,p uuid,a uuid,c uuid,s uuid,assistant uuid) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'source',external_source_authority_fingerprint(w,p),
  'application',to_jsonb(app),
  'credential',jsonb_build_array(key.id,key.version,key.status,key.parent_grant_id,key.client_revision,key.expires_at,key.issued_by_user_id),
  'maxima',(SELECT jsonb_agg(g.maximum_grant ORDER BY g.grant_id) FROM application_credential_grants g WHERE g.credential_id=c),
  'paths',(SELECT jsonb_agg(application_snapshot_grant_path(g.grant_id,a,w,s) ORDER BY g.grant_id) FROM application_credential_grants g WHERE g.credential_id=c),
  'assistant',to_jsonb(agent),
  'issuer',to_jsonb(issuer)
 )::text,'UTF8')),'hex')
 FROM application_clients app JOIN application_api_credentials key ON key.app_id=app.id AND key.workspace_id=app.workspace_id
 JOIN users service ON service.id=key.subject_user_id AND service.auth_provider='channel' AND service.auth_provider_id LIKE 'app-service:'||app.id::text||':%'
 JOIN workspace_members issuer ON issuer.workspace_id=w AND issuer.user_id=key.issued_by_user_id AND issuer.role IN('owner','admin')
 JOIN assistants agent ON agent.id=assistant AND agent.workspace_id=w
 WHERE app.id=a AND app.workspace_id=w AND app.status='active' AND app.executing_assistant_id=assistant
  AND key.id=c AND key.credential_kind='service' AND key.subject_user_id=s AND key.status='active' AND key.audience='application_data'
  AND key.client_revision=app.grant_revision AND key.expires_at>clock_timestamp()
  AND external_source_authority_fingerprint(w,p) IS NOT NULL
  AND EXISTS(SELECT 1 FROM application_credential_grants g WHERE g.credential_id=c)
  AND NOT EXISTS(SELECT 1 FROM application_credential_grants g WHERE g.credential_id=c AND application_snapshot_grant_path(g.grant_id,a,w,s) IS NULL)
$$;
REVOKE ALL ON FUNCTION source_service_authority_fingerprint(uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION source_service_binding_current(binding uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce(b.status='active' AND b.expires_at>clock_timestamp()
  AND b.authority_fingerprint=source_service_authority_fingerprint(b.workspace_id,b.profile_id,b.app_id,b.credential_id,b.service_user_id,b.assistant_id)
  AND (b.workflow_id IS NULL OR b.definition_fingerprint=(SELECT encode(sha256(convert_to(w.definition::text,'UTF8')),'hex') FROM workflows w WHERE w.id=b.workflow_id AND w.workspace_id=b.workspace_id)),false)
 FROM source_service_bindings b WHERE b.id=binding
$$;
REVOKE ALL ON FUNCTION source_service_binding_current(uuid) FROM PUBLIC;
CREATE FUNCTION source_service_binding_admitted(binding uuid,w uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce(source_service_binding_current(b.id)
  AND b.workspace_id=w AND b.app_id=nullif(current_setting('app.application_id',true),'')::uuid
  AND b.credential_id=nullif(current_setting('app.application_credential_id',true),'')::uuid
  AND b.service_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
  AND b.assistant_id=nullif(current_setting('app.application_assistant_id',true),'')::uuid
  AND b.assistant_id=nullif(current_setting('app.v2_assistant_id',true),'')::uuid
  AND application_context_admitted(w),false)
 FROM source_service_bindings b WHERE b.id=binding
$$;
REVOKE ALL ON FUNCTION source_service_binding_admitted(uuid,uuid) FROM PUBLIC;

CREATE TABLE source_service_workflow_runs (
 run_id uuid PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
 binding_id uuid NOT NULL REFERENCES source_service_bindings(id) ON DELETE CASCADE,
 binding_revision bigint NOT NULL,
 authority_fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE source_service_workflow_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON source_service_workflow_runs FROM PUBLIC;
CREATE TRIGGER source_service_workflow_runs_immutable BEFORE UPDATE ON source_service_workflow_runs FOR EACH ROW EXECUTE FUNCTION application_receipt_immutable();

ALTER TABLE external_source_authorizations ADD COLUMN service_binding_id uuid REFERENCES source_service_bindings(id) ON DELETE CASCADE;
ALTER TABLE external_source_authorizations ADD COLUMN service_binding_revision bigint;
ALTER TABLE external_source_authorizations ADD COLUMN service_authority_fingerprint text;
ALTER TABLE external_source_authorizations ADD CONSTRAINT external_source_service_binding_complete CHECK(
 (actor_kind='human' AND service_binding_id IS NULL AND service_binding_revision IS NULL AND service_authority_fingerprint IS NULL)
 OR (actor_kind='service' AND recipient_kind='service' AND recipient_id=actor_id AND recipient_assistant_id=assistant_id
  AND service_binding_id IS NOT NULL AND service_binding_revision IS NOT NULL AND service_authority_fingerprint ~ '^[a-f0-9]{64}$')) NOT VALID;

ALTER FUNCTION external_source_snapshot(uuid,uuid) RENAME TO external_source_snapshot_before_service;
REVOKE ALL ON FUNCTION external_source_snapshot_before_service(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION external_source_snapshot(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;binding uuid:=nullif(current_setting('app.external_source_service_binding_id',true),'')::uuid;
BEGIN
 result:=external_source_snapshot_before_service(w,i);
 IF result IS NULL OR result->>'held' IS DISTINCT FROM 'false' THEN RETURN result; END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NULL THEN
  IF binding IS NOT NULL OR NOT EXISTS(SELECT 1 FROM external_source_authorizations a WHERE a.workspace_id=w AND a.observation_id=i
    AND a.transaction_id=pg_current_xact_id() AND a.backend_pid=pg_backend_pid()
    AND a.operation_id=nullif(current_setting('app.external_source_operation_id',true),'')::uuid
    AND a.actor_kind='human' AND a.recipient_kind='human' AND a.service_binding_id IS NULL
    AND a.actor_id=nullif(current_setting('app.external_source_actor_id',true),'')::uuid
    AND a.assistant_id=nullif(current_setting('app.external_source_assistant_id',true),'')::uuid
    AND a.recipient_id=nullif(current_setting('app.current_user_id',true),'')::uuid
    AND a.recipient_assistant_id=nullif(current_setting('app.v2_assistant_id',true),'')::uuid
    AND a.action=current_setting('app.external_source_action',true) AND a.expires_at>clock_timestamp()) THEN RETURN '{"held":true}'::jsonb; END IF;
 ELSE
  IF source_service_binding_admitted(binding,w) IS NOT TRUE OR NOT EXISTS(
   SELECT 1 FROM external_source_authorizations a JOIN source_service_bindings b ON b.id=a.service_binding_id
   WHERE a.workspace_id=w AND a.observation_id=i AND b.id=binding AND a.profile_id=b.profile_id
    AND a.service_binding_revision=b.revision AND a.service_authority_fingerprint=b.authority_fingerprint
    AND a.transaction_id=pg_current_xact_id() AND a.backend_pid=pg_backend_pid()
    AND a.operation_id=nullif(current_setting('app.external_source_operation_id',true),'')::uuid
    AND a.actor_kind='service' AND a.recipient_kind='service' AND a.actor_id=b.service_user_id AND a.recipient_id=b.service_user_id
    AND a.assistant_id=b.assistant_id AND a.recipient_assistant_id=b.assistant_id
    AND a.action=current_setting('app.external_source_action',true) AND a.expires_at>clock_timestamp()) THEN RETURN '{"held":true}'::jsonb; END IF;
 END IF;
 RETURN result;
EXCEPTION WHEN invalid_text_representation THEN RETURN '{"held":true}'::jsonb;
END $$;
REVOKE ALL ON FUNCTION external_source_snapshot(uuid,uuid) FROM PUBLIC;

ALTER FUNCTION external_source_retention_allowed(uuid,uuid,text) RENAME TO external_source_retention_allowed_before_service;
REVOKE ALL ON FUNCTION external_source_retention_allowed_before_service(uuid,uuid,text) FROM PUBLIC;
CREATE FUNCTION external_source_retention_allowed(w uuid,i uuid,v text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF nullif(current_setting('app.application_id',true),'') IS NULL THEN RETURN external_source_retention_allowed_before_service(w,i,v); END IF;
 IF current_setting('app.external_source_action',true) IS DISTINCT FROM 'retain'
  OR external_source_snapshot(w,i)->>'held' IS DISTINCT FROM 'false' OR external_source_snapshot(w,i)->>'version' IS DISTINCT FROM v THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM external_source_authorizations a JOIN external_source_observations o ON o.id=a.observation_id
  WHERE a.workspace_id=w AND a.observation_id=i AND a.transaction_id=pg_current_xact_id() AND a.backend_pid=pg_backend_pid()
   AND a.operation_id=nullif(current_setting('app.external_source_operation_id',true),'')::uuid
   AND a.service_binding_id=nullif(current_setting('app.external_source_service_binding_id',true),'')::uuid
   AND a.actor_kind='service' AND a.recipient_kind='service' AND a.actor_id=nullif(current_setting('app.current_user_id',true),'')::uuid
   AND a.recipient_id=a.actor_id AND a.assistant_id=nullif(current_setting('app.v2_assistant_id',true),'')::uuid AND a.recipient_assistant_id=a.assistant_id
   AND a.action='retain' AND a.derivation_receipt IS NOT NULL AND a.expires_at>clock_timestamp()
   AND o.observation->'actions' @> '["derive","retain"]'::jsonb AND o.observation->'retention'->>'mode'='governed');
END $$;
REVOKE ALL ON FUNCTION external_source_retention_allowed(uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION prepare_source_service_binding(w uuid,profile uuid,app uuid,credential uuid,workflow uuid,expiry timestamptz) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;service uuid;assistant uuid;fingerprint text;definition text;id uuid;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL OR application_governance_allows(w) IS NOT TRUE THEN
  RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501'; END IF;
 SELECT k.subject_user_id,a.executing_assistant_id INTO service,assistant FROM application_clients a JOIN application_api_credentials k ON k.app_id=a.id AND k.workspace_id=a.workspace_id
  WHERE a.id=app AND a.workspace_id=w AND k.id=credential AND expiry<=k.expires_at AND expiry>clock_timestamp() FOR SHARE OF a,k;
 IF service IS NULL THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501'; END IF;
 INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 fingerprint:=source_service_authority_fingerprint(w,profile,app,credential,service,assistant);
 IF fingerprint IS NULL THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501'; END IF;
 IF workflow IS NOT NULL THEN SELECT encode(sha256(convert_to(f.definition::text,'UTF8')),'hex') INTO definition FROM workflows f WHERE f.id=workflow AND f.workspace_id=w;
  IF definition IS NULL THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501'; END IF;
 END IF;
 INSERT INTO source_service_bindings(workspace_id,profile_id,app_id,credential_id,service_user_id,assistant_id,workflow_id,configured_by_user_id,authority_fingerprint,definition_fingerprint,expires_at)
 VALUES(w,profile,app,credential,service,assistant,workflow,actor,fingerprint,definition,expiry) RETURNING source_service_bindings.id INTO id;
 RETURN id;
END $$;
REVOKE ALL ON FUNCTION prepare_source_service_binding(uuid,uuid,uuid,uuid,uuid,timestamptz) FROM PUBLIC;
CREATE TABLE source_service_binding_approvals (
 id uuid PRIMARY KEY, binding_id uuid NOT NULL REFERENCES source_service_bindings(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES users(id),fingerprint text NOT NULL,expires_at timestamptz NOT NULL
);
ALTER TABLE source_service_binding_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON source_service_binding_approvals FROM PUBLIC;
CREATE FUNCTION activate_source_service_binding(review uuid,approval uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b source_service_bindings;a source_service_binding_approvals;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 SELECT * INTO b FROM source_service_bindings WHERE id=review FOR UPDATE;
 SELECT * INTO a FROM source_service_binding_approvals WHERE id=approval AND binding_id=b.id FOR UPDATE;
 IF b.id IS NULL OR b.status<>'pending' OR b.expires_at<=clock_timestamp() OR actor IS DISTINCT FROM b.configured_by_user_id
  OR a.id IS NULL OR a.actor_id IS DISTINCT FROM actor OR a.expires_at<=clock_timestamp() OR a.fingerprint IS DISTINCT FROM b.authority_fingerprint
  OR application_governance_allows(b.workspace_id) IS NOT TRUE OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR b.authority_fingerprint IS DISTINCT FROM source_service_authority_fingerprint(b.workspace_id,b.profile_id,b.app_id,b.credential_id,b.service_user_id,b.assistant_id)
  OR application_runtime_qualified(b.workspace_id,'application_data') IS NOT TRUE OR application_runtime_qualified(b.workspace_id,'connector_source') IS NOT TRUE THEN
  RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501'; END IF;
 UPDATE source_service_bindings SET status='active' WHERE id=b.id;
 DELETE FROM source_service_binding_approvals WHERE id=a.id;
 RETURN b.id;
END $$;
REVOKE ALL ON FUNCTION activate_source_service_binding(uuid,uuid) FROM PUBLIC;

CREATE TABLE source_service_release_reviews (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 app_id uuid NOT NULL REFERENCES application_clients(id) ON DELETE CASCADE,binding_id uuid NOT NULL REFERENCES source_service_bindings(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES users(id),proposal jsonb NOT NULL,snapshot jsonb NOT NULL,expires_at timestamptz NOT NULL
);
ALTER TABLE source_service_release_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON source_service_release_reviews FROM PUBLIC;
ALTER FUNCTION application_grant_release_snapshot(uuid,jsonb) RENAME TO application_grant_release_snapshot_before_source_service;
REVOKE ALL ON FUNCTION application_grant_release_snapshot_before_source_service(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION application_grant_release_snapshot(application_id uuid,proposal jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE proof source_service_release_reviews;b source_service_bindings;app application_clients;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;ancestor jsonb;
BEGIN
 IF proposal->'origin'->>'kind' IS DISTINCT FROM 'external' THEN RETURN application_grant_release_snapshot_before_source_service(application_id,proposal); END IF;
 SELECT * INTO app FROM application_clients WHERE id=application_id AND status='active';
 SELECT * INTO proof FROM source_service_release_reviews WHERE id=nullif(current_setting('app.source_service_release_review_id',true),'')::uuid
  AND app_id=application_id AND actor_id=actor AND source_service_release_reviews.proposal=application_grant_release_snapshot.proposal AND expires_at>clock_timestamp();
 SELECT * INTO b FROM source_service_bindings WHERE id=proof.binding_id;
 IF app.id IS NULL OR proof.id IS NULL OR b.id IS NULL OR b.status='revoked' OR b.expires_at<=clock_timestamp()
  OR proof.workspace_id IS DISTINCT FROM app.workspace_id OR b.app_id IS DISTINCT FROM app.id OR b.workspace_id IS DISTINCT FROM app.workspace_id
  OR proposal->'principal'->>'kind' IS DISTINCT FROM 'service' OR proposal->'principal'->>'userId' IS DISTINCT FROM b.service_user_id::text
  OR proposal->'selector'->>'kind' IS DISTINCT FROM 'ids'
  OR b.assistant_id IS DISTINCT FROM nullif(current_setting('app.application_assistant_id',true),'')::uuid
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL OR application_governance_allows(app.workspace_id) IS NOT TRUE
  OR b.authority_fingerprint IS DISTINCT FROM source_service_authority_fingerprint(b.workspace_id,b.profile_id,b.app_id,b.credential_id,b.service_user_id,b.assistant_id)
  OR proof.snapshot->>'authorityFingerprint' IS DISTINCT FROM b.authority_fingerprint OR proof.snapshot->>'bindingRevision' IS DISTINCT FROM b.revision::text
  OR NOT application_release_scope_allows(actor,app.workspace_id,proposal->>'clearance',ARRAY(SELECT jsonb_array_elements_text(proposal->'compartments')),ARRAY(SELECT jsonb_array_elements_text(proposal->'projectIds')::uuid),NULL)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(proposal->'actions') a WHERE a NOT IN('read','query','history','schema'))
   AND NOT member_operation_row_allows(member_principal_operation_grants(actor,true,app.workspace_id),app.workspace_id,proposal->>'clearance',ARRAY(SELECT jsonb_array_elements_text(proposal->'compartments')))
  OR proposal->>'expiresAt' IS NOT NULL AND (proposal->>'expiresAt')::timestamptz<=clock_timestamp() THEN RETURN NULL; END IF;
 IF proposal->>'parentGrantId' IS NOT NULL THEN
  parent:=application_snapshot_grant_path((proposal->>'parentGrantId')::uuid,app.id,app.workspace_id,(SELECT principal_user_id FROM application_access_grants WHERE id=(proposal->>'parentGrantId')::uuid));
  IF parent IS NULL THEN RETURN NULL; END IF;
  FOR ancestor IN SELECT jsonb_array_elements(parent->'grants') LOOP
   IF ancestor->'origin'<>proposal->'origin' OR ancestor->>'typeKey'<>proposal->>'typeKey' OR NOT ((proposal->'actions') <@ (ancestor->'actions'))
    OR NOT ((proposal->'readFields') <@ (ancestor->'readFields')) OR NOT ((proposal->'writeFields') <@ (ancestor->'writeFields'))
    OR sensitivity_rank(proposal->>'clearance')>sensitivity_rank(ancestor->>'clearance') OR NOT ((proposal->'compartments') <@ (ancestor->'compartments'))
    OR NOT ((proposal->'projectIds') <@ (ancestor->'projectIds')) OR ancestor->'selector'->>'kind'<>'ids' OR NOT ((proposal->'selector'->'ids') <@ (ancestor->'selector'->'ids')) THEN RETURN NULL; END IF;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('applicationRevision',app.grant_revision::text,'schema',proof.snapshot,'sources',proof.snapshot->'resources','parent',parent);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_grant_release_snapshot(uuid,jsonb) FROM PUBLIC;

-- Local exact caller persistence. Source approval was obtained outside this transaction.
CREATE FUNCTION persist_source_service_workflow_output(binding uuid,step uuid,payload jsonb,evidence jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b source_service_bindings;run uuid;w uuid;s jsonb;target jsonb;
BEGIN
 SELECT * INTO b FROM source_service_bindings WHERE id=binding;
 IF NOT FOUND OR source_service_binding_admitted(binding,b.workspace_id) IS NOT TRUE THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501'; END IF;
 SELECT r.id,r.workspace_id INTO run,w FROM workflow_step_runs sr JOIN workflow_runs r ON r.id=sr.run_id
  JOIN source_service_workflow_runs f ON f.run_id=r.id AND f.binding_id=b.id AND f.binding_revision=b.revision AND f.authority_fingerprint=b.authority_fingerprint
  WHERE sr.id=step AND r.workflow_id=b.workflow_id AND r.workspace_id=b.workspace_id AND r.status='running' AND sr.status='running' FOR UPDATE OF r,sr;
 IF run IS NULL OR jsonb_typeof(evidence->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(evidence->'sources') NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(evidence->'sources') LOOP
  IF s->>'workspaceId' IS DISTINCT FROM w::text OR s->>'resourceKind' IS DISTINCT FROM 'external_source'
   OR external_source_retention_allowed(w,(s->>'resourceId')::uuid,s->>'version') IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 END LOOP;
 UPDATE workflow_runs SET vars=jsonb_set(vars,'{__contextScopeEvidence}',evidence) WHERE id=run;
 UPDATE workflow_step_runs SET output=payload,status='completed',finished_at=clock_timestamp() WHERE id=step;
 target:=workflow_derivation_snapshot(w,run);
 -- The existing workflow evidence store is the retained target. Its canonical
 -- source reader/dependency walker owns lineage; workflow_run is not a target enum.
 IF target->>'held' IS DISTINCT FROM 'false' OR target->'requiredSources' IS DISTINCT FROM evidence->'sources'
  OR target->'sensitivity' IS DISTINCT FROM evidence->'sensitivity'
  OR target->'compartments' IS DISTINCT FROM evidence->'compartments'
  OR target->'projectIds' IS DISTINCT FROM evidence->'projectIds' THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION persist_source_service_workflow_output(uuid,uuid,jsonb,jsonb) FROM PUBLIC;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT SELECT ON source_service_bindings TO app_user;
  GRANT EXECUTE ON FUNCTION prepare_source_service_binding(uuid,uuid,uuid,uuid,uuid,timestamptz),activate_source_service_binding(uuid,uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION source_service_binding_admitted(uuid,uuid),external_source_snapshot(uuid,uuid),external_source_retention_allowed(uuid,uuid,text),persist_source_service_workflow_output(uuid,uuid,jsonb,jsonb) TO app_user;
 END IF;
END $$;
COMMIT;
