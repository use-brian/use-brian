BEGIN;
-- Carry the signed app consent request through the existing email token ledger.
ALTER TABLE magic_link_tokens DROP CONSTRAINT magic_link_tokens_next_path_check;
ALTER TABLE magic_link_tokens ADD CONSTRAINT magic_link_tokens_next_path_check CHECK(next_path IS NULL OR length(next_path)<=8192);

-- Native Home viewer capabilities reuse the signed bridge and app grant paths.
CREATE UNIQUE INDEX application_client_home_identity ON application_clients(home_app_id) WHERE home_app_id IS NOT NULL;
CREATE TABLE application_home_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,workspace_id uuid NOT NULL,
  home_app_id uuid NOT NULL REFERENCES workspace_home_apps(id) ON DELETE CASCADE,
  principal_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  maximum_grants jsonb NOT NULL CHECK(jsonb_typeof(maximum_grants)='array'),
  maximum_hash text NOT NULL,home_state_hash text NOT NULL,client_revision bigint NOT NULL DEFAULT 1,
  read_only boolean NOT NULL DEFAULT true,expires_at timestamptz NOT NULL,revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(app_id,workspace_id) REFERENCES application_clients(id,workspace_id) ON DELETE CASCADE
);
ALTER TABLE application_home_bindings ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION application_home_state_hash(home workspace_home_apps) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('id',home.id,'workspace',home.workspace_id,'scopes',home.granted_scopes,
    'manifest',home.manifest->'scopes','status',home.status,'cap',home.max_clearance,'updated',extract(epoch from home.updated_at))::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION application_home_state_hash(workspace_home_apps) FROM PUBLIC;

CREATE FUNCTION application_home_requirements(home workspace_home_apps) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE requested jsonb:=home.manifest->'scopes'->'application'; granted jsonb:=home.granted_scopes->'application'; item jsonb; prior jsonb; axis text;
BEGIN
  IF requested IS NULL OR granted IS NULL OR requested->>'moduleKey' IS DISTINCT FROM granted->>'moduleKey'
    OR jsonb_typeof(requested->'resources') IS DISTINCT FROM 'array' OR jsonb_typeof(granted->'resources') IS DISTINCT FROM 'array'
    OR jsonb_array_length(requested->'resources') NOT BETWEEN 1 AND 128 THEN RETURN NULL; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(requested->'resources') LOOP
    SELECT r INTO prior FROM jsonb_array_elements(granted->'resources') r WHERE r->>'typeKey'=item->>'typeKey';
    IF prior IS NULL OR item->>'typeKey' !~ '^[a-z][a-z0-9_.-]{0,127}$' THEN RETURN NULL; END IF;
    FOREACH axis IN ARRAY ARRAY['actions','readFields','writeFields'] LOOP
      IF jsonb_typeof(item->axis) IS DISTINCT FROM 'array' OR jsonb_typeof(prior->axis) IS DISTINCT FROM 'array'
        OR jsonb_array_length(item->axis)>128 OR NOT (item->axis)<@(prior->axis) THEN RETURN NULL; END IF;
    END LOOP;
  END LOOP;
  RETURN requested;
END;
$$;
REVOKE ALL ON FUNCTION application_home_requirements(workspace_home_apps) FROM PUBLIC;

CREATE FUNCTION application_home_binding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE app application_clients; home workspace_home_apps; requirements jsonb; maximum jsonb; captured jsonb:='[]'; request jsonb;
  leaf jsonb; keys jsonb; axis text; actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.revoked_at IS NULL OR to_jsonb(NEW)-'revoked_at'<>to_jsonb(OLD)-'revoked_at' THEN
      RAISE EXCEPTION 'invalid_value: immutable Home binding' USING ERRCODE='22023'; END IF;
    NEW.revoked_at:=coalesce(OLD.revoked_at,statement_timestamp());RETURN NEW;
  END IF;
  SELECT * INTO app FROM application_clients WHERE id=NEW.app_id AND workspace_id=NEW.workspace_id AND client_mode='home_app' AND status='active' FOR SHARE;
  IF NOT FOUND OR app.home_app_id<>NEW.home_app_id OR actor IS NOT NULL AND (actor<>NEW.principal_user_id OR NOT application_runtime_qualified(NEW.workspace_id,'application_data')) THEN
    RAISE EXCEPTION 'access_unavailable: Home application unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO home FROM workspace_home_apps WHERE id=NEW.home_app_id AND workspace_id=NEW.workspace_id AND status='active' AND granted_scopes IS NOT NULL FOR SHARE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=NEW.workspace_id AND m.user_id=NEW.principal_user_id) THEN
    RAISE EXCEPTION 'access_unavailable: Home viewer unavailable' USING ERRCODE='42501'; END IF;
  requirements:=application_home_requirements(home);
  IF requirements IS NULL OR requirements->>'moduleKey'<>app.module_key OR jsonb_array_length(NEW.maximum_grants) NOT BETWEEN 1 AND 128
    OR NEW.expires_at<=statement_timestamp() OR NEW.expires_at>statement_timestamp()+interval '10 minutes' THEN
    RAISE EXCEPTION 'invalid_value: Home binding unavailable' USING ERRCODE='22023'; END IF;
  FOR maximum IN SELECT value FROM jsonb_array_elements(NEW.maximum_grants) LOOP
    maximum:=application_snapshot_grant_path((maximum->'grants'->0->>'id')::uuid,app.id,app.workspace_id,NEW.principal_user_id);
    leaf:=maximum->'grants'->0;
    IF leaf->'principal'->>'kind'<>'member' THEN RAISE EXCEPTION 'invalid_value: Home viewer unavailable' USING ERRCODE='22023'; END IF;
    SELECT r INTO request FROM jsonb_array_elements(requirements->'resources') r WHERE r->>'typeKey'=leaf->>'typeKey';
    IF request IS NULL THEN CONTINUE; END IF;
    FOREACH axis IN ARRAY ARRAY['actions','readFields','writeFields'] LOOP
      SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO keys FROM
        (SELECT value FROM jsonb_array_elements(leaf->axis) INTERSECT SELECT value FROM jsonb_array_elements(request->axis)) permitted;
      leaf:=jsonb_set(leaf,ARRAY[axis],keys);
    END LOOP;
    IF jsonb_array_length(leaf->'actions')=0 THEN CONTINUE; END IF;
    captured:=captured||jsonb_build_array(jsonb_set(maximum,'{grants,0}',leaf));
  END LOOP;
  IF jsonb_array_length(captured)=0 THEN RAISE EXCEPTION 'access_unavailable: Home grant unavailable' USING ERRCODE='42501'; END IF;
  NEW.maximum_grants:=captured;NEW.maximum_hash:=encode(sha256(convert_to(captured::text,'UTF8')),'hex');
  NEW.home_state_hash:=application_home_state_hash(home);NEW.client_revision:=app.grant_revision;
  NEW.read_only:=NOT EXISTS(SELECT 1 FROM jsonb_array_elements(captured) m,LATERAL jsonb_array_elements_text(m->'grants'->0->'actions') a
    WHERE a NOT IN('read','query','history','schema'));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION application_home_binding_guard() FROM PUBLIC;
CREATE TRIGGER application_home_binding_guard BEFORE INSERT OR UPDATE ON application_home_bindings FOR EACH ROW EXECUTE FUNCTION application_home_binding_guard();

CREATE FUNCTION application_home_binding_current(binding_id uuid,application_id uuid,actor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM application_home_bindings b JOIN application_clients a ON a.id=b.app_id AND a.workspace_id=b.workspace_id
    JOIN workspace_home_apps h ON h.id=b.home_app_id AND h.workspace_id=b.workspace_id
    JOIN workspace_members m ON m.workspace_id=b.workspace_id AND m.user_id=b.principal_user_id
    WHERE b.id=binding_id AND b.app_id=application_id AND b.principal_user_id=actor AND b.expires_at>statement_timestamp() AND b.revoked_at IS NULL
      AND a.status='active' AND a.client_mode='home_app' AND a.home_app_id=h.id AND a.grant_revision=b.client_revision
      AND h.status='active' AND h.granted_scopes IS NOT NULL AND b.home_state_hash=application_home_state_hash(h)
      AND application_home_requirements(h) IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION application_home_binding_current(uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION application_capture_home_binding(home_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; app application_clients; maxima jsonb; binding_id uuid;
BEGIN
  IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO app FROM application_clients WHERE home_app_id=home_id AND client_mode='home_app' AND status='active';
  IF NOT FOUND OR NOT application_runtime_qualified(app.workspace_id,'application_data') THEN RETURN NULL; END IF;
  SELECT jsonb_agg(jsonb_build_object('grants',jsonb_build_array(jsonb_build_object('id',g.id))) ORDER BY g.id) INTO maxima
    FROM application_access_grants g WHERE g.app_id=app.id AND g.workspace_id=app.workspace_id AND g.principal_user_id=actor
      AND g.principal_kind='member' AND g.status='active' AND g.starts_at<=statement_timestamp() AND (g.expires_at IS NULL OR g.expires_at>statement_timestamp());
  IF maxima IS NULL THEN RETURN NULL; END IF;
  INSERT INTO application_home_bindings(app_id,workspace_id,home_app_id,principal_user_id,maximum_grants,maximum_hash,home_state_hash,expires_at)
    VALUES(app.id,app.workspace_id,home_id,actor,maxima,'','',statement_timestamp()+interval '10 minutes') RETURNING id INTO binding_id;
  RETURN binding_id;
END;
$$;
REVOKE ALL ON FUNCTION application_capture_home_binding(uuid) FROM PUBLIC;
CREATE POLICY application_home_binding_own_read ON application_home_bindings FOR SELECT
  USING(principal_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid OR application_governance_allows(workspace_id));
CREATE POLICY application_home_binding_revoke ON application_home_bindings FOR UPDATE
  USING(principal_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid OR application_governance_allows(workspace_id))
  WITH CHECK(principal_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid OR application_governance_allows(workspace_id));

-- Share the canonical principal grant loader; app release checks never replace
-- the authenticated subject or run a payload query under an issuer identity.
CREATE FUNCTION department_principal_grant_snapshot(p_actor uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH actor AS (
    SELECT p_actor AS u,
           nullif(current_setting('app.v2_assistant_id', true), '')::uuid AS a,
           nullif(current_setting('app.v2_context_department', true), '') AS c,
           nullif(current_setting('app.v2_binding', true), '')::jsonb AS k,
           CASE WHEN nullif(current_setting('app.v2_cap', true), '') IS NULL THEN 3
                ELSE coalesce(sensitivity_rank(current_setting('app.v2_cap', true)), 0) END AS cap
  )
  SELECT coalesce(jsonb_object_agg(m.workspace_id::text, jsonb_build_object(
      'b', least(
             sensitivity_rank(CASE WHEN m.role IN ('owner', 'admin') THEN 'confidential' ELSE m.clearance END),
             CASE WHEN actor.a IS NULL THEN 3
                  ELSE coalesce((SELECT sensitivity_rank(x.clearance) FROM assistants x
                                  WHERE x.id = actor.a AND x.workspace_id = m.workspace_id), 0) END,
             actor.cap),
      'd', coalesce((
             SELECT jsonb_object_agg(e.department_id::text, least(
                      sensitivity_rank(e.clearance),
                      CASE WHEN actor.a IS NULL THEN 3 ELSE coalesce(sensitivity_rank(ae.clearance), 0) END,
                      actor.cap))
               FROM department_edges e
               LEFT JOIN department_edges ae
                 ON ae.department_id = e.department_id AND ae.assistant_id = actor.a
                AND (ae.expires_at IS NULL OR ae.expires_at > clock_timestamp())
              WHERE e.workspace_id = m.workspace_id AND e.user_id = actor.u
                AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())), '{}'::jsonb),
      'c', actor.c,
      'k', actor.k,
      'u', actor.u,
      'p', coalesce((
             SELECT jsonb_agg(s.project_id::text ORDER BY s.project_id)
               FROM project_shared_scopes s
              WHERE s.workspace_id = m.workspace_id AND s.status = 'active' AND wk.project_shared_spaces
                AND project_member_live(s.project_id, 'user', actor.u)
                AND (actor.a IS NULL OR project_member_live(s.project_id, 'assistant', actor.a))), '[]'::jsonb),
      'o', coalesce((
             SELECT jsonb_agg(s.project_id::text ORDER BY s.project_id)
               FROM project_shared_scopes s
              WHERE s.workspace_id = m.workspace_id AND s.status = 'active' AND wk.project_shared_spaces
                AND m.role = 'owner'
                AND NOT project_member_live(s.project_id, 'user', actor.u)
                AND (actor.a IS NULL OR project_member_live(s.project_id, 'assistant', actor.a))), '[]'::jsonb))), '{}'::jsonb)
    FROM actor
    JOIN workspace_members m ON m.user_id = actor.u
    JOIN workspaces wk ON wk.id = m.workspace_id AND wk.department_read_v2
$$;
CREATE FUNCTION member_principal_operation_grants(p_actor uuid,mutation boolean,only_workspace uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH departments AS MATERIALIZED (SELECT department_principal_grant_snapshot(p_actor) AS grants)
  SELECT coalesce(jsonb_object_agg(m.workspace_id::text, jsonb_build_object(
      'r', sensitivity_rank(CASE WHEN m.role IN ('owner','admin') THEN 'confidential' ELSE m.clearance END),
      'c', to_jsonb(CASE WHEN mutation THEN effective_member_team_compartments(m.user_id, m.workspace_id)
                         ELSE effective_member_read_compartments(m.user_id, m.workspace_id) END),
      'v2', CASE WHEN mutation THEN (departments.grants -> m.workspace_id::text) - 'o'
                 ELSE departments.grants -> m.workspace_id::text END)), '{}'::jsonb)
    FROM workspace_members m CROSS JOIN departments
   WHERE m.user_id = p_actor
     AND (only_workspace IS NULL OR m.workspace_id = only_workspace)
$$;

REVOKE ALL ON FUNCTION department_principal_grant_snapshot(uuid),member_principal_operation_grants(uuid,boolean,uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION department_read_grants_for(p_actor uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN nullif(current_setting('app.current_user_id',true),'') IS NULL
    OR nullif(current_setting('app.current_user_id',true),'')::uuid=p_actor
    THEN department_principal_grant_snapshot(p_actor) ELSE '{}'::jsonb END
$$;
CREATE OR REPLACE FUNCTION member_operation_grants(mutation boolean,only_workspace uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT member_principal_operation_grants(nullif(current_setting('app.current_user_id',true),'')::uuid,mutation,only_workspace)
$$;

-- The added generic family uses the canonical once-per-statement member
-- snapshot, preserving the existing row predicate without per-row reach lookups.
ALTER POLICY application_generic_current_member_read ON entity_instances
  USING(member_operation_row_allows((SELECT member_operation_grants(false)),workspace_id,sensitivity,compartments));
ALTER POLICY application_generic_current_member_insert ON entity_instances
  WITH CHECK(member_operation_row_allows((SELECT member_operation_grants(true)),workspace_id,sensitivity,compartments));
ALTER POLICY application_generic_current_member_update ON entity_instances
  USING(member_operation_row_allows((SELECT member_operation_grants(true)),workspace_id,sensitivity,compartments))
  WITH CHECK(member_operation_row_allows((SELECT member_operation_grants(true)),workspace_id,sensitivity,compartments));
ALTER POLICY application_generic_current_member_delete ON entity_instances
  USING(member_operation_row_allows((SELECT member_operation_grants(true)),workspace_id,sensitivity,compartments));

-- App GUCs are trusted transport facts, like app.current_user_id. They contain
-- identifiers only, never request-authored roles, fields, maxima or bearer secrets.
-- All current rights and issuance ceilings are resolved here from canonical rows.
CREATE FUNCTION application_current_maxima() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE app application_clients; key application_api_credentials; oauth oauth_authorizations;
  binding application_oauth_bindings; home_binding application_home_bindings; home_cap text; actor uuid; key_id uuid; oauth_id uuid; home_id uuid; layers jsonb:='[]'; maxima jsonb;
BEGIN
  actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  key_id:=nullif(current_setting('app.application_credential_id',true),'')::uuid;
  oauth_id:=nullif(current_setting('app.application_oauth_id',true),'')::uuid;
  home_id:=nullif(current_setting('app.application_home_binding_id',true),'')::uuid;
  SELECT * INTO app FROM application_clients WHERE id=nullif(current_setting('app.application_id',true),'')::uuid AND status='active';
  IF NOT FOUND OR actor IS NULL OR key_id IS NULL AND oauth_id IS NULL AND home_id IS NULL
    OR home_id IS NOT NULL AND (key_id IS NOT NULL OR oauth_id IS NOT NULL) THEN RETURN NULL; END IF;
  IF app.executing_assistant_id IS NULL OR app.executing_assistant_id IS DISTINCT FROM nullif(current_setting('app.application_assistant_id',true),'')::uuid
    OR app.executing_assistant_id IS DISTINCT FROM nullif(current_setting('app.v2_assistant_id',true),'')::uuid THEN RETURN NULL; END IF;
  IF key_id IS NOT NULL THEN
    SELECT * INTO key FROM application_api_credentials WHERE id=key_id AND app_id=app.id AND workspace_id=app.workspace_id
      AND status='active' AND audience='application_data' AND expires_at>statement_timestamp() AND client_revision=app.grant_revision;
    IF NOT FOUND OR key.credential_kind='delegated' AND oauth_id IS NULL OR key.credential_kind='service' AND (oauth_id IS NOT NULL OR key.subject_user_id<>actor)
      OR NOT EXISTS(SELECT 1 FROM users u WHERE u.id=key.subject_user_id AND u.auth_provider='channel' AND u.auth_provider_id LIKE 'app-service:'||app.id::text||':%')
      OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=app.workspace_id AND m.user_id=key.issued_by_user_id AND m.role IN('owner','admin'))
      OR NOT EXISTS(SELECT 1 FROM application_access_grants g JOIN workspace_members m ON m.workspace_id=g.workspace_id AND m.user_id=g.issued_by_user_id AND m.role IN('owner','admin')
        WHERE g.id=key.parent_grant_id AND g.app_id=app.id AND g.workspace_id=app.workspace_id AND g.principal_kind='service'
          AND g.principal_user_id=key.subject_user_id AND g.status='active' AND g.starts_at<=statement_timestamp() AND (g.expires_at IS NULL OR g.expires_at>statement_timestamp())) THEN RETURN NULL; END IF;
    SELECT jsonb_agg(maximum_grant ORDER BY grant_id) INTO maxima FROM application_credential_grants
      WHERE credential_id=key.id AND app_id=app.id AND workspace_id=app.workspace_id;
    IF maxima IS NULL THEN RETURN NULL; END IF;
    layers:=layers||jsonb_build_array(jsonb_build_object('principal',jsonb_build_object('kind','service','userId',key.subject_user_id),'maxima',maxima));
  END IF;
  IF oauth_id IS NOT NULL THEN
    SELECT * INTO oauth FROM oauth_authorizations WHERE id=oauth_id AND audience='application' AND application_client_id=app.id
      AND workspace_id=app.workspace_id AND user_id=actor AND revoked_at IS NULL AND access_token_hash IS NOT NULL AND access_token_expires_at>statement_timestamp();
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT * INTO binding FROM application_oauth_bindings WHERE authorization_id=oauth.id AND app_id=app.id AND workspace_id=app.workspace_id
      AND principal_user_id=actor AND client_revision=app.grant_revision;
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM users u WHERE u.id=actor AND u.auth_provider<>'channel') THEN RETURN NULL; END IF;
    IF NOT EXISTS(SELECT 1 FROM application_access_grants g JOIN workspace_members m ON m.workspace_id=g.workspace_id AND m.user_id=g.issued_by_user_id AND m.role IN('owner','admin')
      WHERE g.id=binding.parent_grant_id AND g.app_id=app.id AND g.workspace_id=app.workspace_id AND g.principal_user_id=actor
        AND g.principal_kind IN('member','external_user') AND g.status='active' AND g.starts_at<=statement_timestamp()
        AND (g.expires_at IS NULL OR g.expires_at>statement_timestamp())
        AND (g.principal_kind='external_user' OR EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=app.workspace_id AND member.user_id=actor))) THEN RETURN NULL; END IF;
    IF jsonb_array_length(binding.maximum_grants)=0 THEN RETURN NULL; END IF;
    layers:=layers||jsonb_build_array(jsonb_build_object('principal',jsonb_build_object('userId',actor),'maxima',binding.maximum_grants));
  END IF;
  IF home_id IS NOT NULL THEN
    IF NOT application_home_binding_current(home_id,app.id,actor) THEN RETURN NULL; END IF;
    SELECT * INTO home_binding FROM application_home_bindings WHERE id=home_id;
    SELECT max_clearance INTO home_cap FROM workspace_home_apps WHERE id=home_binding.home_app_id;
    layers:=layers||jsonb_build_array(jsonb_build_object('principal',jsonb_build_object('kind','member','userId',actor),'maxima',home_binding.maximum_grants));
  END IF;
  RETURN jsonb_build_object('appId',app.id,'workspaceId',app.workspace_id,'layers',layers,'readOnly',coalesce(oauth.scope='read',home_binding.read_only,false),'maxClearance',home_cap);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION application_current_maxima() FROM PUBLIC;

CREATE FUNCTION application_context_admitted(w uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT coalesce(application_current_maxima()->>'workspaceId'=w::text,false)
$$;

-- Exact app metadata admission preserves the existing module registry and its
-- lock/admission rules for non-members. It releases no workspace payload row.
CREATE FUNCTION application_lock_workspace(w uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT application_context_admitted(w) THEN RETURN false; END IF;
  PERFORM id FROM workspaces WHERE id=w FOR SHARE;
  RETURN FOUND;
END;
$$;
CREATE FUNCTION application_module_read_allows(w uuid,module text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT application_context_admitted(w) AND EXISTS(SELECT 1 FROM application_clients a
    WHERE a.id=nullif(current_setting('app.application_id',true),'')::uuid AND a.workspace_id=w AND a.module_key=module)
$$;
CREATE FUNCTION application_lock_module(w uuid,p_module text) RETURNS SETOF workspace_modules
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT application_module_read_allows(w,p_module) OR NOT application_lock_workspace(w) THEN RETURN; END IF;
  RETURN QUERY SELECT m.workspace_id,m.module_key,m.state,m.version,m.enabled_at,m.disable_requested_at,m.disabled_at,m.updated_at,NULL::uuid
    FROM workspace_modules m WHERE m.workspace_id=w AND m.module_key=p_module FOR SHARE;
END;
$$;
REVOKE ALL ON FUNCTION application_lock_module(uuid,text) FROM PUBLIC;
CREATE POLICY workspace_modules_application_floor ON workspace_modules AS RESTRICTIVE FOR SELECT
  USING(nullif(current_setting('app.application_id',true),'') IS NULL OR application_module_read_allows(workspace_id,module_key));
-- App-data rights never confer native governance or a raw credential-ledger read.
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['application_home_bindings','application_clients','application_access_grants','application_api_credentials','application_credential_grants','application_oauth_bindings','oauth_authorizations'] LOOP
    EXECUTE format('CREATE POLICY application_native_auth_floor ON %I AS RESTRICTIVE FOR ALL USING(nullif(current_setting(''app.application_id'',true),'''') IS NULL) WITH CHECK(nullif(current_setting(''app.application_id'',true),'''') IS NULL)',tab);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION application_lock_workspace(uuid),application_module_read_allows(uuid,text) FROM PUBLIC;

-- Existing department/member and Project predicates remain release-authority
-- floors. A resource release cannot manufacture a private-owner or source grant.
CREATE FUNCTION application_issuer_scope_allows(issuer uuid,w uuid,tier text,teams text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT member_operation_row_allows(member_principal_operation_grants(issuer,false,w),w,tier,teams)
$$;
REVOKE ALL ON FUNCTION application_issuer_scope_allows(uuid,uuid,text,text[]) FROM PUBLIC;

CREATE FUNCTION application_release_scope_allows(issuer uuid,w uuid,tier text,teams text[],projects uuid[],row_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT coalesce((row_user IS NULL OR row_user=nullif(current_setting('app.current_user_id',true),'')::uuid AND row_user=issuer)
    AND agent_read_scope_allows(tier,teams,projects)
    AND EXISTS(SELECT 1 FROM assistants a JOIN workspaces wk ON wk.id=a.workspace_id
      WHERE a.id=nullif(current_setting('app.application_assistant_id',true),'')::uuid AND a.workspace_id=w
        AND sensitivity_rank(tier)<=sensitivity_rank(a.clearance)
        AND (wk.department_read_v2 OR legacy_assistant_team_compartments(a.id) IS NULL OR teams<@legacy_assistant_team_compartments(a.id)))
    AND application_issuer_scope_allows(issuer,w,tier,teams)
    AND NOT EXISTS(SELECT 1 FROM unnest(projects) p WHERE
      NOT EXISTS(SELECT 1 FROM project_shared_scopes s JOIN workspaces wk ON wk.id=s.workspace_id
        WHERE s.project_id=p AND s.workspace_id=w AND s.status='active' AND wk.project_shared_spaces)
      OR NOT project_member_live(p,'user',issuer) OR NOT project_member_live(p,'assistant',nullif(current_setting('app.application_assistant_id',true),'')::uuid)),false)
$$;
REVOKE ALL ON FUNCTION application_release_scope_allows(uuid,uuid,text,text[],uuid[],uuid) FROM PUBLIC;

CREATE FUNCTION application_path_fields(maximum jsonb,subject jsonb,w uuid,origin jsonb,type_key text,record_id text,owner_id uuid,
  tier text,teams text[],projects uuid[],row_user uuid,action text,prospective_data jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE issued jsonb; current_grant application_access_grants; permissions jsonb; read_keys text[]; write_keys text[]; seen uuid[]:='{}'; next_id uuid; i int:=0;
BEGIN
  IF maximum->>'version'<>'1' OR jsonb_typeof(maximum->'grants')<>'array' OR jsonb_array_length(maximum->'grants') NOT BETWEEN 1 AND 16 THEN RETURN NULL; END IF;
  FOR issued IN SELECT value FROM jsonb_array_elements(maximum->'grants') LOOP
    SELECT * INTO current_grant FROM application_access_grants WHERE id=(issued->>'id')::uuid AND app_id=(application_current_maxima()->>'appId')::uuid AND workspace_id=w;
    IF NOT FOUND OR current_grant.id=ANY(seen) OR i>0 AND current_grant.id IS DISTINCT FROM next_id
      OR i=0 AND (current_grant.principal_user_id::text<>subject->>'userId' OR subject ? 'kind' AND current_grant.principal_kind<>subject->>'kind')
      OR current_grant.parent_grant_id IS DISTINCT FROM (issued->>'parentGrantId')::uuid
      OR current_grant.resource_origin<>issued->'origin' OR current_grant.resource_type<>issued->>'typeKey'
      OR current_grant.principal_user_id::text<>issued->'principal'->>'userId' OR current_grant.principal_kind<>issued->'principal'->>'kind'
      OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=current_grant.issued_by_user_id AND m.role IN('owner','admin'))
      OR NOT application_release_scope_allows(current_grant.issued_by_user_id,w,tier,teams,projects,row_user) THEN RETURN NULL; END IF;
    IF action NOT IN('read','query','history','schema') AND (
      NOT member_operation_row_allows(member_principal_operation_grants(current_grant.issued_by_user_id,true,w),w,tier,teams)
      OR current_grant.principal_kind='member' AND NOT member_operation_row_allows(member_principal_operation_grants(current_grant.principal_user_id,true,w),w,tier,teams)) THEN RETURN NULL; END IF;
    IF current_grant.principal_kind='member' AND NOT application_release_scope_allows(current_grant.principal_user_id,w,tier,teams,projects,row_user) THEN RETURN NULL; END IF;
    FOR permissions IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
      jsonb_build_object('status',current_grant.status,'startsAt',current_grant.starts_at,'expiresAt',current_grant.expires_at,
        'origin',current_grant.resource_origin,'typeKey',current_grant.resource_type,'actions',current_grant.actions,
        'selector',current_grant.selector,'clearance',current_grant.clearance,'compartments',current_grant.compartments,'projectIds',current_grant.project_ids,
        'readFields',current_grant.read_fields,'writeFields',current_grant.write_fields),issued)) LOOP
      IF NOT coalesce(permissions->>'status'='active' AND (permissions->>'startsAt')::timestamptz<=statement_timestamp()
        AND ((permissions->>'expiresAt') IS NULL OR (permissions->>'expiresAt')::timestamptz>statement_timestamp())
        AND permissions->'origin'=origin AND permissions->>'typeKey'=type_key
        AND permissions->'actions' ? action AND sensitivity_rank(tier)<=sensitivity_rank(permissions->>'clearance')
        AND to_jsonb(teams)<@(permissions->'compartments') AND to_jsonb(projects)<@(permissions->'projectIds')
        AND jsonb_typeof(permissions->'readFields')='array' AND jsonb_typeof(permissions->'writeFields')='array'
        AND CASE permissions->'selector'->>'kind'
          WHEN 'ids' THEN permissions->'selector'->'ids' ? record_id
          WHEN 'self' THEN owner_id=current_grant.principal_user_id
          WHEN 'relationship' THEN application_relationship_matches(w,origin,record_id,permissions->'selector'->>'resolverKey',permissions->'selector'->>'anchorId',prospective_data)
          ELSE false END,false) THEN RETURN NULL; END IF;
      IF read_keys IS NULL THEN
        read_keys:=ARRAY(SELECT jsonb_array_elements_text(permissions->'readFields'));
        write_keys:=ARRAY(SELECT jsonb_array_elements_text(permissions->'writeFields'));
      ELSE
        read_keys:=ARRAY(SELECT unnest(read_keys) INTERSECT SELECT jsonb_array_elements_text(permissions->'readFields'));
        write_keys:=ARRAY(SELECT unnest(write_keys) INTERSECT SELECT jsonb_array_elements_text(permissions->'writeFields'));
      END IF;
    END LOOP;
    seen:=array_append(seen,current_grant.id); next_id:=current_grant.parent_grant_id; i:=i+1;
  END LOOP;
  IF next_id IS NOT NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('read',coalesce(read_keys,'{}'),'write',coalesce(write_keys,'{}'));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR datetime_field_overflow THEN RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION application_path_fields(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb) FROM PUBLIC;

CREATE FUNCTION application_resource_fields(w uuid,origin jsonb,type_key text,record_id text,owner_id uuid,
  tier text,teams text[],projects uuid[],row_user uuid,action text,prospective_data jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; layer jsonb; maximum jsonb; decision jsonb; layer_read text[]; layer_write text[]; read_keys text[]; write_keys text[]; admitted boolean;
BEGIN
  context:=application_current_maxima();
  IF context IS NULL OR context->>'workspaceId'<>w::text
    OR context->>'maxClearance' IS NOT NULL AND sensitivity_rank(tier)>sensitivity_rank(context->>'maxClearance') THEN RETURN NULL; END IF;
  IF context->>'readOnly'='true' AND action NOT IN('read','query','history') THEN RETURN NULL; END IF;
  FOR layer IN SELECT value FROM jsonb_array_elements(context->'layers') LOOP
    layer_read:='{}'; layer_write:='{}'; admitted:=false;
    FOR maximum IN SELECT value FROM jsonb_array_elements(layer->'maxima') LOOP
      decision:=application_path_fields(maximum,layer->'principal',w,origin,type_key,record_id,owner_id,tier,teams,projects,row_user,action,prospective_data);
      IF decision IS NOT NULL THEN
        admitted:=true;
        layer_read:=layer_read||ARRAY(SELECT jsonb_array_elements_text(decision->'read'));
        layer_write:=layer_write||ARRAY(SELECT jsonb_array_elements_text(decision->'write'));
      END IF;
    END LOOP;
    IF NOT admitted THEN RETURN NULL; END IF;
    IF read_keys IS NULL THEN read_keys:=layer_read; write_keys:=layer_write;
    ELSE
      read_keys:=ARRAY(SELECT unnest(read_keys) INTERSECT SELECT unnest(layer_read));
      write_keys:=ARRAY(SELECT unnest(write_keys) INTERSECT SELECT unnest(layer_write));
    END IF;
  END LOOP;
  IF read_keys IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('read',ARRAY(SELECT DISTINCT unnest(read_keys) ORDER BY 1),'write',ARRAY(SELECT DISTINCT unnest(write_keys) ORDER BY 1));
END;
$$;
REVOKE ALL ON FUNCTION application_resource_fields(uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb) FROM PUBLIC;

-- Registered canonical single-hop relations. Anchor authorization deliberately
-- uses only ID/self paths: relation cycles cannot manufacture an anchor release.
CREATE FUNCTION application_relationship_matches(w uuid,origin jsonb,record_id text,resolver_key text,anchor_id text,prospective_data jsonb DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE property jsonb; target_origin jsonb; target_row record; native_row record; source jsonb; target_kind text;
  context jsonb; layer jsonb; maximum jsonb; decision jsonb; admitted boolean;
BEGIN
  IF origin->>'kind'<>'generic' OR prospective_data IS NULL AND record_id !~ '^[0-9a-fA-F-]{36}$' OR anchor_id !~ '^[0-9a-fA-F-]{36}$' THEN RETURN false; END IF;
  SELECT p INTO property FROM entity_types t,LATERAL jsonb_array_elements(t.properties) p
    WHERE t.workspace_id=w AND t.id=(origin->>'entityTypeId')::uuid
      AND p->'config'->>'kind'='relation' AND 'relation.'||encode(sha256(convert_to(p->>'name','UTF8')),'hex')=resolver_key
      AND (prospective_data IS NOT NULL AND prospective_data->(p->>'name')->>'value'=anchor_id
        OR prospective_data IS NULL AND EXISTS(SELECT 1 FROM entity_instances r WHERE r.id=record_id::uuid AND r.workspace_id=w
          AND r.entity_type_id=t.id AND r.data->(p->>'name')->>'value'=anchor_id));
  IF property IS NULL THEN RETURN false; END IF;
  target_kind:=property->'config'->'targetEntityTypeRef'->>'kind';
  IF target_kind='user_defined' THEN
    target_origin:=jsonb_build_object('kind','generic','entityTypeId',property->'config'->'targetEntityTypeRef'->>'entityTypeId');
    SELECT r.workspace_id,r.created_by,r.sensitivity,r.compartments,r.project_ids,NULL::uuid AS row_user INTO target_row FROM entity_instances r
      WHERE r.workspace_id=w AND r.id=anchor_id::uuid AND r.entity_type_id=(target_origin->>'entityTypeId')::uuid;
    IF NOT FOUND OR scope_review_state_held('entity_instance',anchor_id::uuid) THEN RETURN false; END IF;
  ELSIF target_kind='builtin' THEN
    target_kind:=CASE property->'config'->'targetEntityTypeRef'->>'name' WHEN 'contact' THEN 'person' ELSE property->'config'->'targetEntityTypeRef'->>'name' END;
    IF target_kind NOT IN('company','person','deal','task') THEN RETURN false; END IF;
    target_origin:=jsonb_build_object('kind','native','moduleKey','native');
    IF target_kind='task' THEN
      SELECT t.workspace_id,t.created_by_user_id AS created_by INTO native_row FROM tasks t WHERE t.workspace_id=w AND t.id=anchor_id::uuid;
    ELSE
      SELECT e.workspace_id,e.created_by_user_id AS created_by INTO native_row FROM entities e WHERE e.workspace_id=w AND e.id=anchor_id::uuid AND e.kind=target_kind;
    END IF;
    IF NOT FOUND OR scope_review_state_held(CASE WHEN target_kind='task' THEN 'task' ELSE 'entity' END,anchor_id::uuid)
      OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind=CASE WHEN target_kind='task' THEN 'task' ELSE 'entity' END AND d.resource_id=anchor_id::uuid) THEN RETURN false; END IF;
    source:=read_scope_source(w,CASE WHEN target_kind='task' THEN 'task' ELSE 'entity' END,anchor_id::uuid);
    IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'validTo' IS NOT NULL OR source->>'retractedAt' IS NOT NULL
      OR NOT agent_visibility_allows(w,(source->>'userId')::uuid,(source->>'assistantId')::uuid) THEN RETURN false; END IF;
    SELECT w AS workspace_id,native_row.created_by AS created_by,source->>'sensitivity' AS sensitivity,
      ARRAY(SELECT jsonb_array_elements_text(source->'compartments')) AS compartments,
      ARRAY(SELECT jsonb_array_elements_text(source->'projectIds')::uuid) AS project_ids,(source->>'userId')::uuid AS row_user INTO target_row;
  ELSE RETURN false; END IF;
  context:=application_current_maxima();
  IF context IS NULL THEN RETURN false; END IF;
  FOR layer IN SELECT value FROM jsonb_array_elements(context->'layers') LOOP
    admitted:=false;
    FOR maximum IN SELECT value FROM jsonb_array_elements(layer->'maxima') LOOP
      IF maximum->'grants'->0->'origin'<>target_origin
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(maximum->'grants') g LEFT JOIN application_access_grants current_grant ON current_grant.id=(g->>'id')::uuid
          WHERE g->'selector'->>'kind'='relationship' OR current_grant.selector->>'kind'='relationship')
        OR target_kind IN('company','person','deal','task') AND maximum->'grants'->0->>'typeKey'<>target_kind THEN CONTINUE; END IF;
      decision:=application_path_fields(maximum,layer->'principal',w,target_origin,maximum->'grants'->0->>'typeKey',anchor_id,target_row.created_by,
        target_row.sensitivity,target_row.compartments,target_row.project_ids,target_row.row_user,'read');
      IF decision IS NOT NULL THEN admitted:=true;EXIT; END IF;
    END LOOP;
    IF NOT admitted THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION application_relationship_matches(uuid,jsonb,text,text,text,jsonb) FROM PUBLIC;

-- Content-free canonical reference scope. Never resolves an external source as a
-- native tombstone and never emits a payload or an ungranted target identifier.
CREATE FUNCTION application_reference_scope(w uuid,origin jsonb,type_key text,p_resource_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE generic_row entity_instances; payload jsonb; source jsonb; kind text;
BEGIN
  IF origin->>'kind'='generic' THEN
    SELECT * INTO generic_row FROM entity_instances r WHERE r.workspace_id=w AND r.entity_type_id=(origin->>'entityTypeId')::uuid AND r.id=p_resource_id;
    IF NOT FOUND OR scope_review_state_held('entity_instance',p_resource_id) THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('ownerId',generic_row.created_by,'sensitivity',generic_row.sensitivity,'compartments',generic_row.compartments,
      'projectIds',generic_row.project_ids,'userId',NULL,'assistantId',NULL);
  END IF;
  IF origin<>jsonb_build_object('kind','native','moduleKey','native') OR type_key NOT IN('company','person','deal','task','file','workspace_member') THEN RETURN NULL; END IF;
  IF type_key='workspace_member' THEN
    IF NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=p_resource_id) THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('ownerId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb,'userId',NULL,'assistantId',NULL);
  END IF;
  kind:=CASE type_key WHEN 'task' THEN 'task' WHEN 'file' THEN 'workspace_file' ELSE 'entity' END;
  IF type_key='file' THEN SELECT to_jsonb(f) INTO payload FROM workspace_files f WHERE f.workspace_id=w AND f.id=p_resource_id;
  ELSIF type_key='task' THEN SELECT to_jsonb(t) INTO payload FROM tasks t WHERE t.workspace_id=w AND t.id=p_resource_id;
  ELSE SELECT to_jsonb(e) INTO payload FROM entities e WHERE e.workspace_id=w AND e.id=p_resource_id AND e.kind=type_key; END IF;
  IF payload IS NULL OR scope_review_state_held(kind,p_resource_id)
    OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind=kind AND d.resource_id=p_resource_id) THEN RETURN NULL; END IF;
  source:=read_scope_source(w,kind,p_resource_id);
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'validTo' IS NOT NULL OR source->>'retractedAt' IS NOT NULL
    OR NOT agent_visibility_allows(w,(source->>'userId')::uuid,(source->>'assistantId')::uuid) THEN RETURN NULL; END IF;
  RETURN source||jsonb_build_object('ownerId',payload->'created_by_user_id');
END;
$$;
REVOKE ALL ON FUNCTION application_reference_scope(uuid,jsonb,text,uuid) FROM PUBLIC;

CREATE FUNCTION application_reference_allows(w uuid,target_origin jsonb,target_type text,target_id uuid,required_fields text[] DEFAULT '{}') RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; candidate record; scope jsonb; decision jsonb;
BEGIN
  context:=application_current_maxima();
  IF context IS NULL OR context->>'workspaceId'<>w::text THEN RETURN false; END IF;
  FOR candidate IN SELECT DISTINCT m->'grants'->0->>'typeKey' AS type_key FROM jsonb_array_elements(context->'layers') layer,
    LATERAL jsonb_array_elements(layer->'maxima') m WHERE m->'grants'->0->'origin'=target_origin
      AND (target_origin->>'kind'='generic' OR m->'grants'->0->>'typeKey'=target_type) LOOP
    scope:=application_reference_scope(w,target_origin,candidate.type_key,target_id);
    IF scope IS NULL THEN CONTINUE; END IF;
    decision:=application_resource_fields(w,target_origin,candidate.type_key,target_id::text,(scope->>'ownerId')::uuid,scope->>'sensitivity',
      ARRAY(SELECT jsonb_array_elements_text(scope->'compartments')),ARRAY(SELECT jsonb_array_elements_text(scope->'projectIds')::uuid),(scope->>'userId')::uuid,'read');
    IF decision IS NOT NULL AND to_jsonb(required_fields)<@(decision->'read') THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION application_reference_allows(uuid,jsonb,text,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION application_relation_cell_allows(w uuid,property jsonb,cell jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target_kind text; target_type text; origin jsonb; target_id uuid; file_ref jsonb; file_row workspace_files;
BEGIN
  IF cell->'value' IS NULL OR cell->'value'='null'::jsonb THEN RETURN true; END IF;
  IF property->'config'->>'kind'='person' THEN
    RETURN application_reference_allows(w,jsonb_build_object('kind','native','moduleKey','native'),'workspace_member',(cell->>'value')::uuid);
  END IF;
  IF property->'config'->>'kind'='files' THEN
    IF jsonb_typeof(cell->'value')<>'array' THEN RETURN false; END IF;
    FOR file_ref IN SELECT jsonb_array_elements(cell->'value') LOOP
      SELECT * INTO file_row FROM workspace_files f WHERE f.workspace_id=w AND f.storage_uri='gs://'||(file_ref->>'bucket')||'/'||(file_ref->>'path');
      IF NOT FOUND OR file_ref->>'name' IS DISTINCT FROM file_row.name OR file_ref->>'mimeType' IS DISTINCT FROM file_row.mime
        OR (file_ref->>'sizeBytes')::numeric IS DISTINCT FROM file_row.size_bytes
        OR NOT application_reference_allows(w,jsonb_build_object('kind','native','moduleKey','native'),'file',file_row.id,ARRAY['name','mimeType','sizeBytes','storageRef']) THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  END IF;
  IF property->'config'->>'kind'<>'relation' THEN RETURN true; END IF;
  target_kind:=property->'config'->'targetEntityTypeRef'->>'kind';
  target_type:=property->'config'->'targetEntityTypeRef'->>'name';target_id:=(cell->>'value')::uuid;
  IF target_kind='user_defined' THEN origin:=jsonb_build_object('kind','generic','entityTypeId',property->'config'->'targetEntityTypeRef'->>'entityTypeId');
  ELSIF target_kind='builtin' AND target_type IN('company','contact','deal','task') THEN
    origin:=jsonb_build_object('kind','native','moduleKey','native');target_type:=CASE WHEN target_type='contact' THEN 'person' ELSE target_type END;
  ELSE RETURN false; END IF;
  RETURN application_reference_allows(w,origin,target_type,target_id);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION application_relation_cell_allows(uuid,jsonb,jsonb) FROM PUBLIC;

-- Membership rows themselves remain private. Known same-workspace person
-- references need a boolean reader rather than widening that ledger's policy.
CREATE FUNCTION application_member_reference_exists(w uuid,target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=target)
    AND CASE WHEN nullif(current_setting('app.application_id',true),'') IS NOT NULL
      THEN application_reference_allows(w,'{"kind":"native","moduleKey":"native"}','workspace_member',target)
      ELSE EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid) END
$$;
REVOKE ALL ON FUNCTION application_member_reference_exists(uuid,uuid) FROM PUBLIC;
DO $$ DECLARE definition text; original text := 'SELECT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=p_row.workspace_id AND m.user_id::text=value#>>''{}'') INTO admitted;'; BEGIN
  SELECT pg_get_functiondef('application_check_generic_values(entity_instances,jsonb)'::regprocedure) INTO definition;
  IF position(original IN definition)=0 THEN RAISE EXCEPTION 'Canonical person validation clause changed'; END IF;
  EXECUTE replace(definition,original,'SELECT application_member_reference_exists(p_row.workspace_id,(value#>>''{}'')::uuid) INTO admitted;');
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION application_member_reference_exists(uuid,uuid) TO app_user; END IF;
END $$;

-- Project canonical cells inside the database, before caller predicates or JSON
-- serialization can observe them. The result is not a second record store.
CREATE FUNCTION application_generic_projection(type_id uuid,type_key text,action text DEFAULT 'read',record_id uuid DEFAULT NULL,required_fields text[] DEFAULT '{}')
RETURNS TABLE(id uuid,workspace_id uuid,entity_type_id uuid,data jsonb,record_version bigint,created_at timestamptz,last_edited_at timestamptz,created_by uuid,last_edited_by uuid,source jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE record_row entity_instances; decision jsonb; property jsonb; system_value jsonb; withheld text[];
BEGIN
  IF action NOT IN('read','query','history') THEN RETURN; END IF;
  FOR record_row IN SELECT r.* FROM entity_instances r WHERE r.entity_type_id=type_id AND (record_id IS NULL OR r.id=record_id) LOOP
    IF scope_review_state_held('entity_instance',record_row.id) THEN CONTINUE; END IF;
    decision:=application_resource_fields(record_row.workspace_id,jsonb_build_object('kind','generic','entityTypeId',type_id),
      type_key,record_row.id::text,record_row.created_by,record_row.sensitivity,record_row.compartments,record_row.project_ids,NULL,action);
    IF decision IS NULL THEN CONTINUE; END IF;
    IF NOT to_jsonb(required_fields)<@(decision->'read') THEN RAISE EXCEPTION 'access_unavailable: query unavailable' USING ERRCODE='42501'; END IF;
    id:=record_row.id;workspace_id:=record_row.workspace_id;entity_type_id:=record_row.entity_type_id;record_version:=record_row.record_version;
    created_at:=NULL;last_edited_at:=NULL;created_by:=NULL;last_edited_by:=NULL;
    source:=jsonb_build_object('workspaceId',record_row.workspace_id,'userId',NULL,'assistantId',NULL,
      'sensitivity',record_row.sensitivity,'compartments',record_row.compartments,'projectIds',record_row.project_ids,
      'version',record_row.record_version::text);
    SELECT coalesce(jsonb_object_agg(cell.key,cell.value),'{}') INTO data FROM jsonb_each(record_row.data) cell WHERE decision->'read' ? cell.key;
    withheld:='{}';
    FOR property IN SELECT p.value FROM entity_types t,LATERAL jsonb_array_elements(t.properties) p
      WHERE t.id=type_id AND decision->'read' ? (p.value->>'name') LOOP
      IF NOT application_relation_cell_allows(record_row.workspace_id,property,data->(property->>'name')) THEN
        data:=data-(property->>'name');withheld:=array_append(withheld,property->>'name');CONTINUE;
      END IF;
      system_value:=NULL;
      CASE property->'config'->>'kind'
        WHEN 'created_time' THEN created_at:=record_row.created_at;system_value:=to_jsonb(record_row.created_at);
        WHEN 'last_edited_time' THEN last_edited_at:=record_row.last_edited_at;system_value:=to_jsonb(record_row.last_edited_at);
        WHEN 'created_by' THEN created_by:=record_row.created_by;system_value:=coalesce(to_jsonb(record_row.created_by),'null');
        WHEN 'last_edited_by' THEN last_edited_by:=record_row.last_edited_by;system_value:=coalesce(to_jsonb(record_row.last_edited_by),'null');
        ELSE NULL;
      END CASE;
      IF system_value IS NOT NULL THEN data:=data||jsonb_build_object(property->>'name',jsonb_build_object('kind',property->'config'->>'kind','value',system_value)); END IF;
    END LOOP;
    IF required_fields && withheld THEN RAISE EXCEPTION 'access_unavailable: query unavailable' USING ERRCODE='42501'; END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE TABLE application_record_tombstones (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type_id uuid NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE,
  id uuid PRIMARY KEY, record_version bigint NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  sensitivity text NOT NULL, compartments text[] NOT NULL, project_ids uuid[] NOT NULL
);
ALTER TABLE application_record_tombstones ENABLE ROW LEVEL SECURITY;

-- Only explicit schema origins in this binding are candidates. Schema labels,
-- authors and unrelated properties are not part of this app metadata projection.
CREATE FUNCTION application_generic_catalog(p_type_key text DEFAULT NULL) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; candidate record; schema_row entity_types; row_scope record; selected_id text; action text; decision jsonb;
  visible text[]; fields jsonb; actor uuid; admitted boolean; prospective_data jsonb;
BEGIN
  context:=application_current_maxima();
  IF context IS NULL THEN RETURN; END IF;
  actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  FOR candidate IN SELECT DISTINCT m.value->'grants'->0->'origin' AS origin,m.value->'grants'->0->>'typeKey' AS type_key
    FROM jsonb_array_elements(context->'layers') layer,
      LATERAL jsonb_array_elements(layer->'maxima') m
    WHERE m.value->'grants'->0->'origin'->>'kind'='generic'
      AND (p_type_key IS NULL OR m.value->'grants'->0->>'typeKey'=p_type_key) LOOP
    SELECT * INTO schema_row FROM entity_types WHERE id=(candidate.origin->>'entityTypeId')::uuid AND workspace_id=(context->>'workspaceId')::uuid;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT coalesce(jsonb_object_agg(p->>'name',jsonb_build_object('kind','relation','value',g->'selector'->>'anchorId') ORDER BY g->>'id'),'{}')
      INTO prospective_data FROM jsonb_array_elements(context->'layers') layer,
      LATERAL jsonb_array_elements(layer->'maxima') m,LATERAL jsonb_array_elements(m->'grants') g,
      LATERAL jsonb_array_elements(schema_row.properties) p
      WHERE g->'origin'=candidate.origin AND g->>'typeKey'=candidate.type_key AND g->'selector'->>'kind'='relationship'
        AND p->'config'->>'kind'='relation' AND 'relation.'||encode(sha256(convert_to(p->>'name','UTF8')),'hex')=g->'selector'->>'resolverKey';
    visible:='{}';admitted:=false;
    FOR row_scope IN SELECT r.id,r.created_by,r.sensitivity,r.compartments,r.project_ids,false AS deleted
      FROM entity_instances r WHERE r.entity_type_id=schema_row.id AND r.workspace_id=schema_row.workspace_id
        AND NOT scope_review_state_held('entity_instance',r.id)
      UNION ALL SELECT t.id,t.created_by,t.sensitivity,t.compartments,t.project_ids,true
        FROM application_record_tombstones t WHERE t.entity_type_id=schema_row.id AND t.workspace_id=schema_row.workspace_id LOOP
      FOREACH action IN ARRAY CASE WHEN row_scope.deleted THEN ARRAY['delete'] ELSE ARRAY['read','query','history','schema','patch','delete','create'] END LOOP
        decision:=application_resource_fields(schema_row.workspace_id,candidate.origin,candidate.type_key,row_scope.id::text,row_scope.created_by,
          row_scope.sensitivity,row_scope.compartments,row_scope.project_ids,NULL,action);
        IF decision IS NOT NULL THEN
          admitted:=true;visible:=visible||ARRAY(SELECT jsonb_array_elements_text(decision->'read'));
          IF context->>'readOnly'='false' THEN visible:=visible||ARRAY(SELECT jsonb_array_elements_text(decision->'write')); END IF;
        END IF;
      END LOOP;
    END LOOP;
    -- Creation/schema metadata needs an explicit operation grant; an absent read
    -- target alone cannot advertise a protected schema after its native floor falls.
    FOR selected_id IN SELECT DISTINCT id FROM jsonb_array_elements(context->'layers') layer,
      LATERAL jsonb_array_elements(layer->'maxima') m,
      LATERAL jsonb_array_elements_text(CASE WHEN m.value->'grants'->0->'selector'->>'kind'='ids'
        THEN m.value->'grants'->0->'selector'->'ids' ELSE '["schema"]'::jsonb END) id
      WHERE m.value->'grants'->0->'origin'=candidate.origin AND m.value->'grants'->0->>'typeKey'=candidate.type_key LOOP
      IF EXISTS(SELECT 1 FROM entity_instances r WHERE r.id::text=selected_id)
        OR EXISTS(SELECT 1 FROM application_record_tombstones t WHERE t.id::text=selected_id) THEN CONTINUE; END IF;
      FOREACH action IN ARRAY ARRAY['create','schema'] LOOP
        decision:=application_resource_fields(schema_row.workspace_id,candidate.origin,candidate.type_key,selected_id,actor,'internal','{}','{}',NULL,action,CASE WHEN action='create' THEN prospective_data ELSE NULL END);
        IF decision IS NOT NULL THEN
          admitted:=true;visible:=visible||ARRAY(SELECT jsonb_array_elements_text(decision->'read'));
          IF context->>'readOnly'='false' THEN visible:=visible||ARRAY(SELECT jsonb_array_elements_text(decision->'write')); END IF;
        END IF;
      END LOOP;
    END LOOP;
    IF NOT admitted THEN CONTINUE; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('key',property->>'name','label',property->>'name','kind','cell','property',property)||CASE WHEN property->'config'->>'kind'='relation'
        THEN jsonb_build_object('relationshipResolverKey','relation.'||encode(sha256(convert_to(property->>'name','UTF8')),'hex')) ELSE '{}'::jsonb END
      ORDER BY position),'[]') INTO fields FROM jsonb_array_elements(schema_row.properties) WITH ORDINALITY p(property,position)
      WHERE property->>'name'=ANY(visible);
    RETURN NEXT jsonb_build_object('typeKey',candidate.type_key,'origin',candidate.origin,'schemaVersion',schema_row.schema_version::text,'fields',fields);
  END LOOP;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN;
END;
$$;
REVOKE ALL ON FUNCTION application_generic_catalog(text) FROM PUBLIC;

-- Historical values remain subject to the live record and the revision's scope.
-- Field names removed from the canonical current schema can never reappear.
CREATE FUNCTION application_generic_history(type_id uuid,type_key text,record_id uuid,before_version bigint DEFAULT NULL,page_limit int DEFAULT 50)
RETURNS TABLE(record_version bigint,schema_version int,data jsonb,source jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_row entity_instances; revision application_record_revisions; decision jsonb; current_decision jsonb; fields text[]; property jsonb;
BEGIN
  IF page_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023'; END IF;
  SELECT * INTO current_row FROM entity_instances r WHERE r.entity_type_id=type_id AND r.id=record_id;
  IF NOT FOUND OR scope_review_state_held('entity_instance',record_id) THEN RETURN; END IF;
  current_decision:=application_resource_fields(current_row.workspace_id,jsonb_build_object('kind','generic','entityTypeId',type_id),
    type_key,record_id::text,current_row.created_by,current_row.sensitivity,current_row.compartments,current_row.project_ids,NULL,'history');
  IF current_decision IS NULL OR NOT EXISTS(SELECT 1 FROM application_generic_projection(type_id,type_key,'read',record_id)) THEN RETURN; END IF;
  FOR revision IN SELECT h.* FROM application_record_revisions h WHERE h.entity_instance_id=record_id
    AND (before_version IS NULL OR h.record_version<before_version) ORDER BY h.record_version DESC LIMIT page_limit LOOP
    decision:=application_resource_fields(current_row.workspace_id,jsonb_build_object('kind','generic','entityTypeId',type_id),
      type_key,record_id::text,current_row.created_by,revision.sensitivity,revision.compartments,revision.project_ids,NULL,'history');
    IF decision IS NULL THEN CONTINUE; END IF;
    SELECT ARRAY(SELECT p->>'name' FROM entity_types t,LATERAL jsonb_array_elements(t.properties) p
      WHERE t.id=type_id AND current_decision->'read' ? (p->>'name') AND decision->'read' ? (p->>'name')) INTO fields;
    record_version:=revision.record_version;schema_version:=revision.schema_version;
    SELECT coalesce(jsonb_object_agg(cell.key,cell.value),'{}') INTO data FROM jsonb_each(revision.data) cell WHERE cell.key=ANY(fields);
    FOR property IN SELECT p FROM entity_types t,LATERAL jsonb_array_elements(t.properties) p WHERE t.id=type_id AND p->>'name'=ANY(fields) LOOP
      IF NOT application_relation_cell_allows(current_row.workspace_id,property,data->(property->>'name')) THEN data:=data-(property->>'name'); END IF;
    END LOOP;
    source:=jsonb_build_object('workspaceId',current_row.workspace_id,'userId',NULL,'assistantId',NULL,
      'sensitivity',revision.sensitivity,'compartments',revision.compartments,'projectIds',revision.project_ids,'version',current_row.record_version::text);
    RETURN NEXT;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION application_generic_history(uuid,text,uuid,bigint,int) FROM PUBLIC;

-- Native app reads project the canonical entity/task row. Historical derived
-- records stay withheld here until P4's ancestor/field revalidation is installed.
CREATE FUNCTION application_native_projection(type_key text,record_id uuid,action text DEFAULT 'read',required_fields text[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; w uuid; kind text; payload jsonb; source jsonb; decision jsonb; values_json jsonb; projected jsonb; custom_field record; target_kind text;
BEGIN
  context:=application_current_maxima();
  IF context IS NULL OR type_key NOT IN('company','person','deal','task','file','workspace_member') OR action NOT IN('read','query','history') THEN RETURN NULL; END IF;
  w:=(context->>'workspaceId')::uuid;kind:=CASE type_key WHEN 'task' THEN 'task' WHEN 'file' THEN 'workspace_file' WHEN 'workspace_member' THEN 'workspace_member' ELSE 'entity' END;
  IF scope_review_state_held(kind,record_id) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind=kind AND d.resource_id=record_id) THEN RETURN NULL; END IF;
  IF type_key='workspace_member' THEN
    SELECT jsonb_build_object('id',m.user_id,'version',md5(to_jsonb(m)::text)) INTO payload FROM workspace_members m WHERE m.user_id=record_id AND m.workspace_id=w;
  ELSIF type_key='file' THEN
    SELECT to_jsonb(f) INTO payload FROM workspace_files f WHERE f.id=record_id AND f.workspace_id=w;
  ELSIF type_key='task' THEN
    SELECT to_jsonb(t) INTO payload FROM tasks t WHERE t.id=record_id AND t.workspace_id=w;
  ELSE
    SELECT to_jsonb(e) INTO payload FROM entities e WHERE e.id=record_id AND e.workspace_id=w AND e.kind=type_key;
  END IF;
  IF payload IS NULL THEN RETURN NULL; END IF;
  source:=CASE WHEN type_key='workspace_member' THEN application_reference_scope(w,jsonb_build_object('kind','native','moduleKey','native'),type_key,record_id)
    ||jsonb_build_object('workspaceId',w,'version',payload->>'version','held',false,'validTo',NULL,'retractedAt',NULL)
    ELSE read_scope_source(w,kind,record_id) END;
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'validTo' IS NOT NULL OR source->>'retractedAt' IS NOT NULL
    OR NOT agent_visibility_allows(w,(source->>'userId')::uuid,(source->>'assistantId')::uuid) THEN RETURN NULL; END IF;
  decision:=application_resource_fields(w,jsonb_build_object('kind','native','moduleKey','native'),type_key,record_id::text,
    (payload->>'created_by_user_id')::uuid,source->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(source->'compartments')),
    ARRAY(SELECT jsonb_array_elements_text(source->'projectIds')::uuid),(source->>'userId')::uuid,action);
  IF decision IS NULL THEN RETURN NULL; END IF;
  IF NOT to_jsonb(required_fields)<@(decision->'read') THEN RAISE EXCEPTION 'access_unavailable: query unavailable' USING ERRCODE='42501'; END IF;
  values_json:=CASE type_key
    WHEN 'company' THEN jsonb_build_object('name',payload->'display_name','domain',payload->'attributes'->'domain')
    WHEN 'person' THEN jsonb_build_object('name',payload->'display_name','email',payload->'attributes'->'email','phone',payload->'attributes'->'phone')
    WHEN 'deal' THEN jsonb_build_object('name',payload->'display_name','stage',payload->'attributes'->'stage','amount',payload->'attributes'->'amount')
    WHEN 'file' THEN jsonb_build_object('name',payload->'name','mimeType',payload->'mime','sizeBytes',payload->'size_bytes','storageRef',payload->'storage_uri')
    WHEN 'workspace_member' THEN jsonb_build_object('id',payload->'id')
    ELSE jsonb_build_object('title',payload->'title','status',payload->'status') END;
  IF type_key IN('company','person','deal') THEN
    FOR custom_field IN SELECT f.* FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=type_key AND f.archived_at IS NULL
      AND decision->'read' ? ('custom.'||f.field_key) LOOP
      IF custom_field.field_type='entity_reference' AND payload->'attributes'->'custom_fields'->custom_field.field_key IS NOT NULL
        AND payload->'attributes'->'custom_fields'->custom_field.field_key<>'null'::jsonb THEN
        BEGIN
          SELECT e.kind INTO target_kind FROM entities e WHERE e.workspace_id=w AND e.id=(payload->'attributes'->'custom_fields'->>custom_field.field_key)::uuid;
          IF target_kind IS NULL OR NOT custom_field.options ? target_kind
            OR NOT application_reference_allows(w,jsonb_build_object('kind','native','moduleKey','native'),target_kind,(payload->'attributes'->'custom_fields'->>custom_field.field_key)::uuid) THEN
            IF 'custom.'||custom_field.field_key=ANY(required_fields) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
            CONTINUE;
          END IF;
        EXCEPTION WHEN invalid_text_representation THEN CONTINUE;
        END;
      END IF;
      values_json:=values_json||jsonb_build_object('custom.'||custom_field.field_key,coalesce(payload->'attributes'->'custom_fields'->custom_field.field_key,'null'));
    END LOOP;
  END IF;
  SELECT coalesce(jsonb_object_agg(cell.key,cell.value),'{}') INTO projected FROM jsonb_each(values_json) cell WHERE decision->'read' ? cell.key;
  RETURN jsonb_build_object('values',projected,'source',source);
END;
$$;
REVOKE ALL ON FUNCTION application_native_projection(text,uuid,text,text[]) FROM PUBLIC;

-- Native schema metadata is derived only from currently released canonical
-- rows. A hidden department's fields are not advertised after its floor falls.
CREATE FUNCTION application_native_catalog() RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; candidate record; record_id uuid; projected jsonb; fields text[]; custom_fields jsonb; admitted boolean;
BEGIN
  context:=application_current_maxima();
  IF context IS NULL THEN RETURN; END IF;
  FOR candidate IN SELECT DISTINCT m->'grants'->0->>'typeKey' AS type_key
    FROM jsonb_array_elements(context->'layers') layer,LATERAL jsonb_array_elements(layer->'maxima') m
    WHERE m->'grants'->0->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb
      AND m->'grants'->0->>'typeKey' IN('company','person','deal','task','file','workspace_member') LOOP
    fields:='{}';admitted:=false;
    FOR record_id IN SELECT e.id FROM entities e WHERE e.workspace_id=(context->>'workspaceId')::uuid AND e.kind=candidate.type_key
      UNION ALL SELECT t.id FROM tasks t WHERE t.workspace_id=(context->>'workspaceId')::uuid AND candidate.type_key='task'
      UNION ALL SELECT f.id FROM workspace_files f WHERE f.workspace_id=(context->>'workspaceId')::uuid AND candidate.type_key='file'
      UNION ALL SELECT m.user_id FROM workspace_members m WHERE m.workspace_id=(context->>'workspaceId')::uuid AND candidate.type_key='workspace_member' LOOP
      projected:=application_native_projection(candidate.type_key,record_id);
      IF projected IS NOT NULL THEN admitted:=true;fields:=fields||ARRAY(SELECT jsonb_object_keys(projected->'values')); END IF;
    END LOOP;
    IF NOT admitted THEN CONTINUE; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'entityKind',f.entity_kind,'fieldKey',f.field_key,'label',f.label,
      'fieldType',f.field_type,'options',f.options,'isRequired',f.is_required,'position',f.position) ORDER BY f.position,f.id),'[]') INTO custom_fields
      FROM crm_field_definitions f WHERE f.workspace_id=(context->>'workspaceId')::uuid AND f.entity_kind=candidate.type_key
        AND f.archived_at IS NULL AND 'custom.'||f.field_key=ANY(fields);
    RETURN NEXT jsonb_build_object('typeKey',candidate.type_key,'fields',ARRAY(SELECT DISTINCT unnest(fields) ORDER BY 1),'customFields',custom_fields);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION application_native_catalog() FROM PUBLIC;

-- Canonical app writes are fixed operations over entity_instances. They cannot
-- select arbitrary SQL or return an unprojected row. Existing record triggers
-- enforce schema validation, versions, uniqueness and history for every writer.
CREATE FUNCTION application_generic_tombstone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM entity_types t WHERE t.id=OLD.entity_type_id)
    AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=OLD.workspace_id) THEN
    INSERT INTO application_record_tombstones(workspace_id,entity_type_id,id,record_version,created_by,sensitivity,compartments,project_ids)
      VALUES(OLD.workspace_id,OLD.entity_type_id,OLD.id,OLD.record_version+1,OLD.created_by,OLD.sensitivity,OLD.compartments,OLD.project_ids);
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION application_generic_tombstone() FROM PUBLIC;
CREATE TRIGGER application_generic_tombstone AFTER DELETE ON entity_instances FOR EACH ROW EXECUTE FUNCTION application_generic_tombstone();
CREATE FUNCTION application_generic_identity_unused() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM application_record_tombstones t WHERE t.id=NEW.id) THEN
    RAISE EXCEPTION 'record_version_conflict: identity retired' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION application_generic_identity_unused() FROM PUBLIC;
CREATE TRIGGER application_generic_identity_unused BEFORE INSERT ON entity_instances FOR EACH ROW EXECUTE FUNCTION application_generic_identity_unused();

CREATE FUNCTION application_generic_reference_allows(w uuid,target_kind text,target_type text,target_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF target_kind='user_defined' THEN
    RETURN application_reference_allows(w,jsonb_build_object('kind','generic','entityTypeId',target_type),NULL,target_id);
  ELSIF target_kind='builtin' AND target_type IN('contact','company','deal','task') THEN
    RETURN application_reference_allows(w,jsonb_build_object('kind','native','moduleKey','native'),CASE WHEN target_type='contact' THEN 'person' ELSE target_type END,target_id);
  END IF;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION application_generic_reference_allows(uuid,text,text,uuid) FROM PUBLIC;

CREATE FUNCTION application_generic_write(type_id uuid,type_key text,operation text,record_id uuid,expected_version bigint,
  changes jsonb,tier text DEFAULT 'internal',teams text[] DEFAULT '{}',projects uuid[] DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; w uuid; actor uuid; current_row entity_instances; decision jsonb; command_decision jsonb;
  field text; property jsonb; cell jsonb; target_id uuid; next_version bigint; command_key text;
BEGIN
  context:=application_current_maxima(); command_key:=nullif(current_setting('app.application_command_key',true),'');
  IF context IS NULL OR context->>'readOnly'='true' OR operation NOT IN('create','patch','delete')
    OR NOT coalesce(command_key IN('record_'||operation,'record_batch'),false)
    OR record_id IS NULL OR jsonb_typeof(changes) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(changes))>128 THEN
    RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';
  END IF;
  w:=(context->>'workspaceId')::uuid;actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  PERFORM 1 FROM entity_types t WHERE t.id=type_id AND t.workspace_id=w FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  IF operation='create' THEN
    current_row.workspace_id:=w;current_row.entity_type_id:=type_id;current_row.id:=record_id;current_row.created_by:=actor;
    current_row.sensitivity:=tier;current_row.compartments:=teams;current_row.project_ids:=projects;
  ELSE
    SELECT * INTO current_row FROM entity_instances r WHERE r.id=record_id AND r.workspace_id=w AND r.entity_type_id=type_id FOR UPDATE;
    IF NOT FOUND OR scope_review_state_held('entity_instance',record_id) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  decision:=application_resource_fields(w,jsonb_build_object('kind','generic','entityTypeId',type_id),type_key,record_id::text,
    current_row.created_by,current_row.sensitivity,current_row.compartments,current_row.project_ids,NULL,operation,CASE WHEN operation='create' THEN changes ELSE NULL END);
  command_decision:=application_resource_fields(w,jsonb_build_object('kind','generic','entityTypeId',type_id),type_key,record_id::text,
    current_row.created_by,current_row.sensitivity,current_row.compartments,current_row.project_ids,NULL,'command:'||command_key,CASE WHEN operation='create' THEN changes ELSE NULL END);
  IF decision IS NULL OR command_decision IS NULL
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(changes) k WHERE NOT decision->'write' ? k OR NOT command_decision->'write' ? k) THEN
    RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';
  END IF;
  IF operation<>'create' AND (expected_version IS NULL OR expected_version<>current_row.record_version) THEN
    RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001';
  END IF;
  FOR field,cell IN SELECT key,value FROM jsonb_each(changes) LOOP
    SELECT p INTO property FROM entity_types t,LATERAL jsonb_array_elements(t.properties) p WHERE t.id=type_id AND p->>'name'=field;
    IF property IS NULL THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023'; END IF;
    IF cell->'value' IS NULL OR cell->'value'='null'::jsonb THEN CONTINUE; END IF;
    IF property->'config'->>'kind'='relation' THEN
      BEGIN target_id:=(cell->>'value')::uuid;
      EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023'; END;
      IF NOT application_generic_reference_allows(w,property->'config'->'targetEntityTypeRef'->>'kind',
        coalesce(property->'config'->'targetEntityTypeRef'->>'entityTypeId',property->'config'->'targetEntityTypeRef'->>'name'),target_id) THEN
        RAISE EXCEPTION 'invalid_value: reference unavailable' USING ERRCODE='22023';
      END IF;
    ELSIF property->'config'->>'kind' IN('person','files') AND NOT application_relation_cell_allows(w,property,cell) THEN
      RAISE EXCEPTION 'access_unavailable: reference unavailable' USING ERRCODE='42501';
    END IF;
  END LOOP;
  IF operation='create' THEN
    INSERT INTO entity_instances(id,workspace_id,entity_type_id,data,source_app,created_by,last_edited_by,sensitivity,compartments,project_ids)
      VALUES(record_id,w,type_id,changes,'api',actor,actor,tier,teams,projects) RETURNING record_version INTO next_version;
  ELSIF operation='patch' THEN
    UPDATE entity_instances SET data=data||changes,last_edited_by=actor,last_edited_at=now()
      WHERE id=record_id RETURNING record_version INTO next_version;
  ELSE
    IF changes<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023'; END IF;
    next_version:=current_row.record_version+1;
    DELETE FROM entity_instances WHERE id=record_id;
  END IF;
  RETURN jsonb_build_object('workspaceId',w,'origin',jsonb_build_object('kind','generic','entityTypeId',type_id),
    'typeKey',type_key,'id',record_id,'version',next_version::text);
END;
$$;
REVOKE ALL ON FUNCTION application_generic_write(uuid,text,text,uuid,bigint,jsonb,text,text[],uuid[]) FROM PUBLIC;

CREATE FUNCTION application_generic_receipt_allows(type_id uuid,type_key text,record_id uuid,action text,required_fields text[] DEFAULT '{}') RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; record_row record; decision jsonb; command_decision jsonb;
BEGIN
  IF action NOT IN('create','patch','delete') THEN RETURN false; END IF;
  SELECT workspace_id,created_by,sensitivity,compartments,project_ids INTO record_row FROM entity_instances WHERE id=record_id AND entity_type_id=type_id;
  IF NOT FOUND AND action='delete' THEN
    SELECT workspace_id,created_by,sensitivity,compartments,project_ids INTO record_row FROM application_record_tombstones WHERE id=record_id AND entity_type_id=type_id;
  END IF;
  IF NOT FOUND THEN RETURN false; END IF;
  context:=application_current_maxima();
  IF context IS NULL THEN
    RETURN nullif(current_setting('app.application_id',true),'') IS NULL
      AND context_scope_allows_current_principal(record_row.workspace_id,record_row.sensitivity,record_row.compartments,record_row.project_ids)
      AND member_operation_scope_allows(record_row.workspace_id,record_row.sensitivity,record_row.compartments,true);
  END IF;
  decision:=application_resource_fields(record_row.workspace_id,jsonb_build_object('kind','generic','entityTypeId',type_id),type_key,record_id::text,
    record_row.created_by,record_row.sensitivity,record_row.compartments,record_row.project_ids,NULL,action);
  command_decision:=application_resource_fields(record_row.workspace_id,jsonb_build_object('kind','generic','entityTypeId',type_id),type_key,record_id::text,
    record_row.created_by,record_row.sensitivity,record_row.compartments,record_row.project_ids,NULL,'command:'||current_setting('app.application_command_key',true));
  RETURN decision IS NOT NULL AND command_decision IS NOT NULL
    AND to_jsonb(required_fields)<@(decision->'write') AND to_jsonb(required_fields)<@(command_decision->'write');
END;
$$;
REVOKE ALL ON FUNCTION application_generic_receipt_allows(uuid,text,uuid,text,text[]) FROM PUBLIC;

ALTER TABLE application_operation_receipts ADD COLUMN application_client_id uuid REFERENCES application_clients(id) ON DELETE CASCADE;
ALTER POLICY application_receipt_actor ON application_operation_receipts
  USING(actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND
    CASE WHEN nullif(current_setting('app.application_id',true),'') IS NULL THEN
      application_client_id IS NULL AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=application_operation_receipts.workspace_id AND m.user_id=actor_user_id)
    ELSE application_client_id=nullif(current_setting('app.application_id',true),'')::uuid AND application_context_admitted(workspace_id)
      AND application_module_read_allows(workspace_id,module_key) END)
  WITH CHECK(actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND
    CASE WHEN nullif(current_setting('app.application_id',true),'') IS NULL THEN
      application_client_id IS NULL AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=application_operation_receipts.workspace_id AND m.user_id=actor_user_id)
    ELSE application_client_id=nullif(current_setting('app.application_id',true),'')::uuid AND application_context_admitted(workspace_id)
      AND application_module_read_allows(workspace_id,module_key) END);

-- Existing direct readers cannot serialize hidden cells merely because they
-- possess a member connection. Non-members still have no raw-table policy.
CREATE FUNCTION application_raw_generic_read_allows(record_row entity_instances) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  RETURN nullif(current_setting('app.application_id',true),'') IS NULL;
END;
$$;
CREATE POLICY application_raw_generic_projection_floor ON entity_instances AS RESTRICTIVE FOR SELECT USING(application_raw_generic_read_allows(entity_instances));
CREATE POLICY application_raw_schema_projection_floor ON entity_types AS RESTRICTIVE FOR SELECT
  USING(nullif(current_setting('app.application_id',true),'') IS NULL);
CREATE POLICY application_raw_revision_projection_floor ON application_record_revisions AS RESTRICTIVE FOR SELECT
  USING(nullif(current_setting('app.application_id',true),'') IS NULL);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['crm_field_definitions','entities','entity_links','tasks','memories','memories_shadow','knowledge_entries','kb_chunks','workspace_files','episodes'] LOOP
    EXECUTE format('CREATE POLICY application_raw_payload_floor ON %I AS RESTRICTIVE FOR SELECT USING(nullif(current_setting(''app.application_id'',true),'''') IS NULL)',tab);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='app_user') THEN
    GRANT SELECT,UPDATE ON application_home_bindings TO app_user;
    GRANT EXECUTE ON FUNCTION application_capture_home_binding(uuid) TO app_user;
    GRANT EXECUTE ON FUNCTION application_native_catalog(),application_generic_write(uuid,text,text,uuid,bigint,jsonb,text,text[],uuid[]),application_generic_receipt_allows(uuid,text,uuid,text,text[]),application_generic_history(uuid,text,uuid,bigint,int),application_generic_catalog(text),application_lock_module(uuid,text),application_lock_workspace(uuid),application_module_read_allows(uuid,text),application_native_projection(text,uuid,text,text[]),application_context_admitted(uuid),application_generic_projection(uuid,text,text,uuid,text[]),application_raw_generic_read_allows(entity_instances) TO app_user;
  END IF;
END $$;

REVOKE ALL ON FUNCTION application_context_admitted(uuid),application_generic_projection(uuid,text,text,uuid,text[]),application_raw_generic_read_allows(entity_instances) FROM PUBLIC;

CREATE TABLE application_grant_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  proposed_grant jsonb NOT NULL CHECK(jsonb_typeof(proposed_grant)='object'),
  authority_hash text NOT NULL CHECK(authority_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
  consumed_grant_id uuid REFERENCES application_access_grants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(app_id,workspace_id) REFERENCES application_clients(id,workspace_id) ON DELETE CASCADE,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes')
);
ALTER TABLE application_grant_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_grant_review_native ON application_grant_reviews FOR SELECT
  USING(actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND application_governance_allows(workspace_id)
    AND nullif(current_setting('app.application_id',true),'') IS NULL);

-- The review contains only canonical identity/scope/version/schema metadata.
-- It never reads business payload into a management API or an owner's connection.
CREATE FUNCTION application_grant_release_snapshot(application_id uuid,proposal jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE app application_clients; actor uuid; subject uuid; origin jsonb; schema_row entity_types; row_id uuid;
  fields text[]; writable text[]; schema_metadata jsonb; sources jsonb:='[]'; scope jsonb; version text; candidate record;
  teams text[]; projects uuid[]; resolver_property jsonb; parent_snapshot jsonb; provider text; provider_id text; parent_subject uuid; ancestor jsonb;
BEGIN
  actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  IF jsonb_typeof(proposal) IS DISTINCT FROM 'object' OR proposal-ARRAY['principal','origin','typeKey','actions','readFields','writeFields','selector','compartments','projectIds','clearance','parentGrantId','expiresAt']<>'{}'::jsonb
    OR NOT proposal ?& ARRAY['principal','origin','typeKey','actions','readFields','writeFields','selector','compartments','projectIds','clearance','parentGrantId','expiresAt']
    OR jsonb_typeof(proposal->'principal') IS DISTINCT FROM 'object' OR (proposal->'principal')-ARRAY['kind','userId']<>'{}'::jsonb
    OR NOT coalesce(proposal->'principal'->>'kind' IN('member','external_user','service'),false)
    OR NOT coalesce(proposal->>'typeKey' ~ '^[a-z][a-z0-9_.-]{0,127}$',false)
    OR NOT coalesce(proposal->>'clearance' IN('public','internal','confidential'),false)
    OR jsonb_typeof(proposal->'actions') IS DISTINCT FROM 'array' OR jsonb_array_length(proposal->'actions') NOT BETWEEN 1 AND 128
    OR jsonb_typeof(proposal->'readFields') IS DISTINCT FROM 'array' OR jsonb_array_length(proposal->'readFields')>128
    OR jsonb_typeof(proposal->'writeFields') IS DISTINCT FROM 'array' OR jsonb_array_length(proposal->'writeFields')>128
    OR jsonb_typeof(proposal->'compartments') IS DISTINCT FROM 'array' OR jsonb_array_length(proposal->'compartments')>128
    OR jsonb_typeof(proposal->'projectIds') IS DISTINCT FROM 'array' OR jsonb_array_length(proposal->'projectIds')>128
    OR jsonb_typeof(proposal->'selector') IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(proposal->'actions') a WHERE jsonb_typeof(a)<>'string' OR (a#>>'{}') !~ '^(read|query|create|patch|delete|history|schema|command:[a-z][a-z0-9_.-]{0,127})$')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements((proposal->'readFields')||(proposal->'writeFields')||(proposal->'compartments')||(proposal->'projectIds')) a WHERE jsonb_typeof(a)<>'string' OR length(a#>>'{}') NOT BETWEEN 1 AND 128)
    OR NOT coalesce(CASE proposal->'selector'->>'kind'
      WHEN 'ids' THEN (proposal->'selector')-ARRAY['kind','ids']='{}'::jsonb AND jsonb_typeof(proposal->'selector'->'ids')='array'
        AND jsonb_array_length(proposal->'selector'->'ids') BETWEEN 1 AND 100
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(proposal->'selector'->'ids') a WHERE jsonb_typeof(a)<>'string')
      WHEN 'self' THEN proposal->'selector'='{"kind":"self"}'::jsonb
      WHEN 'relationship' THEN (proposal->'selector')-ARRAY['kind','resolverKey','anchorId']='{}'::jsonb AND proposal->'selector' ?& ARRAY['resolverKey','anchorId']
      ELSE false END,false) THEN RETURN NULL; END IF;
  SELECT * INTO app FROM application_clients WHERE id=application_id AND status='active';
  IF NOT FOUND OR actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
    OR NOT application_governance_allows(app.workspace_id) OR app.executing_assistant_id IS DISTINCT FROM nullif(current_setting('app.application_assistant_id',true),'')::uuid THEN RETURN NULL; END IF;
  subject:=(proposal->'principal'->>'userId')::uuid;origin:=proposal->'origin';
  SELECT auth_provider,auth_provider_id INTO provider,provider_id FROM users WHERE id=subject;
  IF provider IS NULL OR proposal->'principal'->>'kind'='member' AND NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=app.workspace_id AND m.user_id=subject)
    OR proposal->'principal'->>'kind'='external_user' AND provider='channel'
    OR proposal->'principal'->>'kind'='service' AND (provider<>'channel' OR provider_id NOT LIKE 'app-service:'||app.id::text||':%') THEN RETURN NULL; END IF;
  teams:=ARRAY(SELECT jsonb_array_elements_text(proposal->'compartments'));projects:=ARRAY(SELECT jsonb_array_elements_text(proposal->'projectIds')::uuid);
  IF NOT application_release_scope_allows(actor,app.workspace_id,proposal->>'clearance',teams,projects,NULL)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(proposal->'actions') a WHERE a NOT IN('read','query','history','schema'))
      AND NOT member_operation_row_allows(member_principal_operation_grants(actor,true,app.workspace_id),app.workspace_id,proposal->>'clearance',teams)
    OR proposal->>'expiresAt' IS NOT NULL AND (proposal->>'expiresAt')::timestamptz<=statement_timestamp() THEN RETURN NULL; END IF;
  IF origin->>'kind'='generic' AND app.module_key='records' THEN
    SELECT * INTO schema_row FROM entity_types t WHERE t.workspace_id=app.workspace_id AND t.id=(origin->>'entityTypeId')::uuid;
    IF NOT FOUND THEN RETURN NULL; END IF;
    fields:=ARRAY(SELECT p->>'name' FROM jsonb_array_elements(schema_row.properties) p);
    writable:=ARRAY(SELECT p->>'name' FROM jsonb_array_elements(schema_row.properties) p WHERE p->'config'->>'kind' NOT IN('created_time','created_by','last_edited_time','last_edited_by'));
    schema_metadata:=jsonb_build_object('id',schema_row.id,'version',schema_row.schema_version,'properties',schema_row.properties);
    IF proposal->'selector'->>'kind'='relationship' THEN
      SELECT p INTO resolver_property FROM jsonb_array_elements(schema_row.properties) p WHERE p->'config'->>'kind'='relation'
        AND 'relation.'||encode(sha256(convert_to(p->>'name','UTF8')),'hex')=proposal->'selector'->>'resolverKey';
      IF resolver_property IS NULL THEN RETURN NULL; END IF;
      scope:=application_reference_scope(app.workspace_id,
        CASE resolver_property->'config'->'targetEntityTypeRef'->>'kind' WHEN 'user_defined' THEN jsonb_build_object('kind','generic','entityTypeId',resolver_property->'config'->'targetEntityTypeRef'->>'entityTypeId') ELSE '{"kind":"native","moduleKey":"native"}' END,
        CASE resolver_property->'config'->'targetEntityTypeRef'->>'name' WHEN 'contact' THEN 'person' ELSE resolver_property->'config'->'targetEntityTypeRef'->>'name' END,
        (proposal->'selector'->>'anchorId')::uuid);
      IF scope IS NULL OR NOT application_release_scope_allows(actor,app.workspace_id,scope->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(scope->'compartments')),
        ARRAY(SELECT jsonb_array_elements_text(scope->'projectIds')::uuid),(scope->>'userId')::uuid) THEN RETURN NULL; END IF;
    END IF;
    FOR candidate IN SELECT r.id,r.record_version::text AS version,r.created_by AS owner,r.sensitivity,r.compartments,r.project_ids,NULL::uuid AS user_id
      FROM entity_instances r WHERE r.workspace_id=app.workspace_id AND r.entity_type_id=schema_row.id
        AND CASE proposal->'selector'->>'kind' WHEN 'ids' THEN proposal->'selector'->'ids' ? r.id::text
          WHEN 'self' THEN r.created_by=subject WHEN 'relationship' THEN r.data->(resolver_property->>'name')->>'value'=proposal->'selector'->>'anchorId' ELSE false END
        AND sensitivity_rank(r.sensitivity)<=sensitivity_rank(proposal->>'clearance') AND r.compartments<@teams AND r.project_ids<@projects ORDER BY r.id LOOP
      IF scope_review_state_held('entity_instance',candidate.id) OR NOT application_release_scope_allows(actor,app.workspace_id,candidate.sensitivity,candidate.compartments,candidate.project_ids,NULL) THEN RETURN NULL; END IF;
      sources:=sources||jsonb_build_array(jsonb_build_object('id',candidate.id,'version',candidate.version,'owner',candidate.owner,
        'sensitivity',candidate.sensitivity,'compartments',candidate.compartments,'projectIds',candidate.project_ids));
    END LOOP;
  ELSIF origin='{"kind":"native","moduleKey":"native"}'::jsonb AND app.module_key='native' AND proposal->'selector'->>'kind'='ids' THEN
    fields:=CASE proposal->>'typeKey' WHEN 'company' THEN ARRAY['name','domain'] WHEN 'person' THEN ARRAY['name','email','phone']
      WHEN 'deal' THEN ARRAY['name','stage','amount'] WHEN 'task' THEN ARRAY['title','status'] WHEN 'file' THEN ARRAY['name','mimeType','sizeBytes','storageRef'] WHEN 'workspace_member' THEN ARRAY['id'] ELSE NULL END;
    IF fields IS NULL THEN RETURN NULL; END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.id),'[]') INTO schema_metadata FROM crm_field_definitions f
      WHERE f.workspace_id=app.workspace_id AND f.entity_kind=proposal->>'typeKey' AND f.archived_at IS NULL;
    fields:=fields||ARRAY(SELECT 'custom.'||(f->>'field_key') FROM jsonb_array_elements(schema_metadata) f);
    writable:=CASE WHEN proposal->>'typeKey' IN('file','workspace_member') THEN '{}'::text[] ELSE fields END;
    FOR row_id IN SELECT jsonb_array_elements_text(proposal->'selector'->'ids')::uuid LOOP
      scope:=application_reference_scope(app.workspace_id,origin,proposal->>'typeKey',row_id);
      IF scope IS NULL OR NOT application_release_scope_allows(actor,app.workspace_id,scope->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(scope->'compartments')),
        ARRAY(SELECT jsonb_array_elements_text(scope->'projectIds')::uuid),(scope->>'userId')::uuid)
        OR scope->>'userId' IS NOT NULL AND scope->>'userId'<>subject::text THEN RETURN NULL; END IF;
      sources:=sources||jsonb_build_array(jsonb_build_object('id',row_id,'scope',scope));
    END LOOP;
  ELSE RETURN NULL; END IF;
  IF NOT proposal->'readFields'<@to_jsonb(fields) OR NOT proposal->'writeFields'<@to_jsonb(writable) THEN RETURN NULL; END IF;
  IF proposal->>'parentGrantId' IS NOT NULL THEN
    SELECT principal_user_id INTO parent_subject FROM application_access_grants WHERE id=(proposal->>'parentGrantId')::uuid AND app_id=app.id AND workspace_id=app.workspace_id;
    parent_snapshot:=application_snapshot_grant_path((proposal->>'parentGrantId')::uuid,app.id,app.workspace_id,parent_subject);
    IF parent_snapshot IS NULL THEN RETURN NULL; END IF;
    FOR ancestor IN SELECT jsonb_array_elements(parent_snapshot->'grants') LOOP
      IF ancestor->'origin'<>origin OR ancestor->>'typeKey'<>proposal->>'typeKey' OR NOT (proposal->'actions')<@(ancestor->'actions')
        OR NOT (proposal->'readFields')<@(ancestor->'readFields') OR NOT (proposal->'writeFields')<@(ancestor->'writeFields')
        OR sensitivity_rank(proposal->>'clearance')>sensitivity_rank(ancestor->>'clearance')
        OR NOT (proposal->'compartments')<@(ancestor->'compartments') OR NOT (proposal->'projectIds')<@(ancestor->'projectIds')
        OR (CASE WHEN ancestor->'selector'->>'kind'='ids' THEN proposal->'selector'->>'kind'<>'ids' OR NOT (proposal->'selector'->'ids')<@(ancestor->'selector'->'ids')
          ELSE proposal->'selector'<>ancestor->'selector' OR ancestor->'selector'->>'kind'='self' AND ancestor->'principal'->>'userId'<>subject::text END) THEN RETURN NULL; END IF;
    END LOOP;
  END IF;
  IF proposal->'selector'->>'kind'='ids' AND NOT proposal->'actions' ? 'create'
    AND jsonb_array_length(sources)<>jsonb_array_length(proposal->'selector'->'ids') THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('applicationRevision',app.grant_revision::text,'schema',schema_metadata,'sources',sources,'parent',parent_snapshot);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION application_grant_release_snapshot(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION application_prepare_grant_review(application_id uuid,proposal jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE snapshot jsonb; review_id uuid; w uuid;
BEGIN
  snapshot:=application_grant_release_snapshot(application_id,proposal);
  IF snapshot IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  SELECT workspace_id INTO w FROM application_clients WHERE id=application_id;
  INSERT INTO application_grant_reviews(workspace_id,app_id,actor_user_id,proposed_grant,authority_hash)
    VALUES(w,application_id,nullif(current_setting('app.current_user_id',true),'')::uuid,proposal,encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')) RETURNING id INTO review_id;
  RETURN review_id;
END;
$$;
REVOKE ALL ON FUNCTION application_prepare_grant_review(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION application_reviewed_grant_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE review application_grant_reviews; proposal jsonb;
BEGIN
  IF nullif(current_setting('app.current_user_id',true),'') IS NULL OR NEW.status<>'active' THEN RETURN NEW; END IF;
  SELECT * INTO review FROM application_grant_reviews WHERE id=nullif(current_setting('app.application_grant_review_id',true),'')::uuid FOR UPDATE;
  proposal:=jsonb_build_object('principal',jsonb_build_object('kind',NEW.principal_kind,'userId',NEW.principal_user_id),'origin',NEW.resource_origin,'typeKey',NEW.resource_type,
    'actions',NEW.actions,'readFields',NEW.read_fields,'writeFields',NEW.write_fields,'selector',NEW.selector,'compartments',NEW.compartments,'projectIds',NEW.project_ids,
    'clearance',NEW.clearance,'parentGrantId',NEW.parent_grant_id,'expiresAt',CASE WHEN NEW.expires_at IS NULL THEN NULL ELSE to_char(NEW.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END);
  IF review.id IS NULL OR review.actor_user_id IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
    OR review.app_id<>NEW.app_id OR review.workspace_id<>NEW.workspace_id OR review.expires_at<=statement_timestamp()
    OR review.consumed_grant_id IS NOT NULL OR review.proposed_grant<>proposal
    OR review.authority_hash IS DISTINCT FROM encode(sha256(convert_to(application_grant_release_snapshot(NEW.app_id,proposal)::text,'UTF8')),'hex')
    OR NOT application_runtime_qualified(NEW.workspace_id,'application_data') THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION application_reviewed_grant_guard() FROM PUBLIC;
CREATE TRIGGER application_reviewed_grant_guard BEFORE INSERT OR UPDATE ON application_access_grants FOR EACH ROW EXECUTE FUNCTION application_reviewed_grant_guard();

CREATE TABLE application_authority_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK(action IN('grant_issued','grant_revoked','credential_issued','credential_revoked','client_status_changed')),
  resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(app_id,workspace_id) REFERENCES application_clients(id,workspace_id) ON DELETE CASCADE
);
ALTER TABLE application_authority_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_authority_event_native ON application_authority_events FOR SELECT
  USING(application_governance_allows(workspace_id) AND nullif(current_setting('app.application_id',true),'') IS NULL);
CREATE POLICY application_authority_event_write ON application_authority_events FOR INSERT
  WITH CHECK(application_governance_allows(workspace_id) AND actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
    AND nullif(current_setting('app.application_id',true),'') IS NULL);

CREATE FUNCTION application_apply_grant_review(review_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE review application_grant_reviews; proposal jsonb; snapshot jsonb; grant_id uuid;
BEGIN
  SELECT * INTO review FROM application_grant_reviews WHERE id=review_id AND actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid FOR UPDATE;
  IF NOT FOUND OR NOT application_governance_allows(review.workspace_id) OR nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  IF review.consumed_grant_id IS NOT NULL THEN RETURN review.consumed_grant_id; END IF;
  proposal:=review.proposed_grant;snapshot:=application_grant_release_snapshot(review.app_id,proposal);
  IF review.expires_at<=statement_timestamp() OR review.authority_hash IS DISTINCT FROM encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001'; END IF;
  IF NOT application_runtime_qualified(review.workspace_id,'application_data') THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  PERFORM set_config('app.application_grant_review_id',review.id::text,true);
  INSERT INTO application_access_grants(app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,resource_origin,resource_type,actions,
    read_fields,write_fields,selector,compartments,project_ids,clearance,parent_grant_id,expires_at)
    VALUES(review.app_id,review.workspace_id,proposal->'principal'->>'kind',(proposal->'principal'->>'userId')::uuid,review.actor_user_id,proposal->'origin',proposal->>'typeKey',
      ARRAY(SELECT jsonb_array_elements_text(proposal->'actions')),ARRAY(SELECT jsonb_array_elements_text(proposal->'readFields')),ARRAY(SELECT jsonb_array_elements_text(proposal->'writeFields')),
      proposal->'selector',ARRAY(SELECT jsonb_array_elements_text(proposal->'compartments')),ARRAY(SELECT jsonb_array_elements_text(proposal->'projectIds')::uuid),proposal->>'clearance',
      (proposal->>'parentGrantId')::uuid,(proposal->>'expiresAt')::timestamptz) RETURNING id INTO grant_id;
  UPDATE application_grant_reviews SET consumed_grant_id=grant_id WHERE id=review.id;
  INSERT INTO application_authority_events(workspace_id,app_id,actor_user_id,action,resource_id) VALUES(review.workspace_id,review.app_id,review.actor_user_id,'grant_issued',grant_id);
  RETURN grant_id;
END;
$$;
REVOKE ALL ON FUNCTION application_apply_grant_review(uuid) FROM PUBLIC;

CREATE TABLE application_credential_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  proposal jsonb NOT NULL CHECK(jsonb_typeof(proposal)='object'),
  authority_hash text NOT NULL CHECK(authority_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
  consumed_credential_id uuid REFERENCES application_api_credentials(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(app_id,workspace_id) REFERENCES application_clients(id,workspace_id) ON DELETE CASCADE,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes')
);
ALTER TABLE application_credential_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_credential_review_native ON application_credential_reviews FOR SELECT
  USING(actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND application_governance_allows(workspace_id)
    AND nullif(current_setting('app.application_id',true),'') IS NULL);

CREATE FUNCTION application_credential_release_snapshot(application_id uuid,proposal jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE app application_clients; grant_row application_access_grants; grant_id uuid; maximum jsonb; release_snapshot jsonb; grants jsonb:='[]'; grant_proposal jsonb;
BEGIN
  IF jsonb_typeof(proposal) IS DISTINCT FROM 'object' OR proposal-ARRAY['name','kind','serviceUserId','grantIds','expiresAt']<>'{}'::jsonb
    OR NOT proposal ?& ARRAY['name','kind','serviceUserId','grantIds','expiresAt'] OR NOT coalesce(proposal->>'kind' IN('service','delegated'),false)
    OR jsonb_typeof(proposal->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(proposal->'serviceUserId') IS DISTINCT FROM 'string' OR jsonb_typeof(proposal->'expiresAt') IS DISTINCT FROM 'string'
    OR length(proposal->>'name') NOT BETWEEN 1 AND 128 OR jsonb_typeof(proposal->'grantIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(proposal->'grantIds') NOT BETWEEN 1 AND 128 OR (proposal->>'expiresAt')::timestamptz<=statement_timestamp() THEN RETURN NULL; END IF;
  SELECT * INTO app FROM application_clients WHERE id=application_id AND status='active' AND client_mode<>'home_app';
  IF NOT FOUND OR NOT application_governance_allows(app.workspace_id) OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
    OR jsonb_array_length(proposal->'grantIds')<>(SELECT count(DISTINCT x) FROM jsonb_array_elements_text(proposal->'grantIds') x) THEN RETURN NULL; END IF;
  FOR grant_id IN SELECT jsonb_array_elements_text(proposal->'grantIds')::uuid LOOP
    SELECT * INTO grant_row FROM application_access_grants g WHERE g.id=grant_id AND g.app_id=app.id AND g.workspace_id=app.workspace_id
      AND g.principal_kind='service' AND g.principal_user_id=(proposal->>'serviceUserId')::uuid;
    IF NOT FOUND THEN RETURN NULL; END IF;
    maximum:=application_snapshot_grant_path(grant_row.id,app.id,app.workspace_id,grant_row.principal_user_id);
    grant_proposal:=(maximum->'grants'->0)-ARRAY['id','appId','workspaceId','version','status','startsAt'];
    release_snapshot:=application_grant_release_snapshot(app.id,grant_proposal);
    IF release_snapshot IS NULL THEN RETURN NULL; END IF;
    grants:=grants||jsonb_build_array(jsonb_build_object('maximum',maximum,'release',release_snapshot));
  END LOOP;
  RETURN jsonb_build_object('applicationRevision',app.grant_revision::text,'grants',grants);
EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation OR invalid_datetime_format THEN RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION application_credential_release_snapshot(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION application_prepare_credential_review(application_id uuid,proposal jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE snapshot jsonb; review_id uuid; w uuid;
BEGIN
  snapshot:=application_credential_release_snapshot(application_id,proposal);
  IF snapshot IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  SELECT workspace_id INTO w FROM application_clients WHERE id=application_id;
  INSERT INTO application_credential_reviews(workspace_id,app_id,actor_user_id,proposal,authority_hash)
    VALUES(w,application_id,nullif(current_setting('app.current_user_id',true),'')::uuid,proposal,encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')) RETURNING id INTO review_id;
  RETURN review_id;
END;
$$;
REVOKE ALL ON FUNCTION application_prepare_credential_review(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION application_reviewed_credential_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE review application_credential_reviews;
BEGIN
  IF nullif(current_setting('app.current_user_id',true),'') IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO review FROM application_credential_reviews WHERE id=nullif(current_setting('app.application_credential_review_id',true),'')::uuid FOR UPDATE;
  IF review.id IS NULL OR review.actor_user_id IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
    OR review.app_id<>NEW.app_id OR review.workspace_id<>NEW.workspace_id OR review.expires_at<=statement_timestamp() OR review.consumed_credential_id IS NOT NULL
    OR review.proposal->>'serviceUserId'<>NEW.subject_user_id::text OR review.proposal->>'kind'<>NEW.credential_kind OR review.proposal->>'name'<>NEW.name
    OR (review.proposal->>'expiresAt')::timestamptz<>NEW.expires_at OR review.proposal->'grantIds'->>0<>NEW.parent_grant_id::text
    OR review.authority_hash IS DISTINCT FROM encode(sha256(convert_to(application_credential_release_snapshot(NEW.app_id,review.proposal)::text,'UTF8')),'hex')
    OR NOT application_runtime_qualified(NEW.workspace_id,'application_data') THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION application_reviewed_credential_guard() FROM PUBLIC;
CREATE TRIGGER application_reviewed_credential_guard BEFORE INSERT ON application_api_credentials FOR EACH ROW EXECUTE FUNCTION application_reviewed_credential_guard();

CREATE FUNCTION application_apply_credential_review(review_id uuid,credential_id uuid,secret_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE review application_credential_reviews; snapshot jsonb; grant_id uuid;
BEGIN
  SELECT * INTO review FROM application_credential_reviews WHERE id=review_id AND actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid FOR UPDATE;
  IF NOT FOUND OR NOT application_governance_allows(review.workspace_id) OR nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  IF review.consumed_credential_id IS NOT NULL THEN RETURN jsonb_build_object('id',review.consumed_credential_id,'created',false); END IF;
  snapshot:=application_credential_release_snapshot(review.app_id,review.proposal);
  IF review.expires_at<=statement_timestamp() OR review.authority_hash IS DISTINCT FROM encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001'; END IF;
  IF NOT application_runtime_qualified(review.workspace_id,'application_data') THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  IF credential_id IS NULL OR secret_hash IS NULL OR secret_hash NOT LIKE 'scrypt$%' THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023'; END IF;
  PERFORM set_config('app.application_credential_review_id',review.id::text,true);
  INSERT INTO application_api_credentials(id,app_id,workspace_id,issued_by_user_id,subject_user_id,name,credential_kind,secret_hash,parent_grant_id,expires_at)
    VALUES(credential_id,review.app_id,review.workspace_id,review.actor_user_id,(review.proposal->>'serviceUserId')::uuid,
      review.proposal->>'name',review.proposal->>'kind',secret_hash,(review.proposal->'grantIds'->>0)::uuid,(review.proposal->>'expiresAt')::timestamptz);
  FOR grant_id IN SELECT jsonb_array_elements_text(review.proposal->'grantIds')::uuid LOOP
    INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant)
      VALUES(credential_id,review.app_id,review.workspace_id,grant_id,'{}');
  END LOOP;
  UPDATE application_credential_reviews SET consumed_credential_id=credential_id WHERE id=review.id;
  INSERT INTO application_authority_events(workspace_id,app_id,actor_user_id,action,resource_id) VALUES(review.workspace_id,review.app_id,review.actor_user_id,'credential_issued',credential_id);
  RETURN jsonb_build_object('id',credential_id,'created',true);
END;
$$;
REVOKE ALL ON FUNCTION application_apply_credential_review(uuid,uuid,text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
    GRANT SELECT ON application_grant_reviews,application_credential_reviews,application_authority_events TO app_user;
    GRANT INSERT ON application_authority_events TO app_user;
    GRANT EXECUTE ON FUNCTION application_prepare_grant_review(uuid,jsonb),application_apply_grant_review(uuid) TO app_user;
    GRANT EXECUTE ON FUNCTION application_prepare_credential_review(uuid,jsonb),application_apply_credential_review(uuid,uuid,text) TO app_user;
  END IF;
END $$;
COMMIT;
