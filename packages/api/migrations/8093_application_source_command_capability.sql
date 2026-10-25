-- Spec: docs/architecture/features/application-platform.md
-- [COMP:api/source-service-binding] Immutable, explicitly reviewed command-bound source capability.
BEGIN;
ALTER TABLE connector_source_profiles ADD COLUMN source_effect_binding text CHECK(source_effect_binding IS NULL OR source_effect_binding='command_v1');
CREATE OR REPLACE FUNCTION guard_scoped_source_profile() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.scoped_app_id IS DISTINCT FROM OLD.scoped_app_id OR NEW.source_effect_binding IS DISTINCT FROM OLD.source_effect_binding) THEN
 RAISE EXCEPTION 'source_scope_immutable' USING ERRCODE='22023';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION application_apply_source_setup(r uuid,approval_id uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v application_source_setup_reviews;a application_source_setup_approvals;o jsonb;resource_id uuid;
BEGIN
 SELECT * INTO v FROM application_source_setup_reviews WHERE id=r AND actor_id=nullif(current_setting('app.current_user_id',true),'')::uuid FOR UPDATE;
 IF v.id IS NULL OR application_governance_allows(v.workspace_id) IS NOT TRUE THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501';END IF;
 IF v.consumed THEN
 IF NOT EXISTS(SELECT 1 FROM connector_source_profiles p WHERE p.id=v.profile_id AND p.scoped_app_id=v.app_id AND p.status='qualified') THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501';END IF;
 RETURN v.profile_id;END IF;
 SELECT * INTO a FROM application_source_setup_approvals WHERE id=approval_id AND review_id=r AND actor_id=v.actor_id FOR UPDATE;
 IF v.expires_at<=clock_timestamp() OR a.id IS NULL OR a.expires_at<=clock_timestamp() OR a.snapshot IS DISTINCT FROM v.snapshot
 OR v.snapshot IS DISTINCT FROM application_source_setup_snapshot(v.workspace_id,v.app_id,(v.proposal->>'instanceId')::uuid)
 OR jsonb_array_length(a.observations)<>1 THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501';END IF;
 INSERT INTO connector_source_profiles(id,workspace_id,connector_instance_id,tenant,issuer,audience,source_base_url,mcp_url,http_read_path,status,created_by_user_id,scoped_app_id,source_effect_binding)
 VALUES(v.profile_id,v.workspace_id,(v.proposal->>'instanceId')::uuid,v.proposal->>'tenant',v.proposal->>'issuer',v.proposal->>'audience',v.proposal->>'sourceBaseUrl',v.proposal->>'mcpUrl','/http/read','qualified',v.actor_id,v.app_id,v.proposal->>'effectBinding');
 FOR o IN SELECT value FROM jsonb_array_elements(a.observations) LOOP
 INSERT INTO external_source_resources(workspace_id,profile_id,resource_type,opaque_id)
 VALUES(v.workspace_id,v.profile_id,o#>>'{observation,resource,type}',o#>>'{observation,resource,id}') RETURNING id INTO resource_id;
 INSERT INTO external_source_observations(workspace_id,resource_id,version,content_version,policy_version,fields,observation,sensitivity,compartments,project_ids)
 VALUES(v.workspace_id,resource_id,o->>'version',o#>>'{observation,resource,contentVersion}',o#>>'{observation,resource,policyVersion}',ARRAY(SELECT jsonb_array_elements_text(o#>'{observation,fields}')),o->'observation',o->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(o->'compartments')),ARRAY(SELECT jsonb_array_elements_text(o->'projectIds')::uuid));
 END LOOP;
 UPDATE application_source_setup_reviews SET consumed=true WHERE id=r;DELETE FROM application_source_setup_approvals WHERE id=a.id;RETURN v.profile_id;
END $$;
CREATE OR REPLACE FUNCTION application_scoped_grant_allowed_before_records(a uuid,p jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF p->'origin'->>'kind' IS DISTINCT FROM 'external' THEN RETURN application_scoped_native_grant_allowed(a,p);END IF;
 RETURN p->'principal'->>'kind'='service' AND p->'selector'->>'kind'='ids'
 AND EXISTS(SELECT 1 FROM connector_source_profiles s WHERE s.scoped_app_id=a AND s.connector_instance_id=(p->'origin'->>'connectorInstanceId')::uuid
 AND s.tenant=(p->'origin'->>'sourceTenant') AND s.status='qualified' AND application_scoped_qualified(s.workspace_id,a)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'actions') action WHERE action NOT IN('read','command:source.derive','command:source.retain')
   AND NOT(action='command:source.mutate' AND s.source_effect_binding IS NOT DISTINCT FROM 'command_v1'))
 AND (p->'writeFields'='[]'::jsonb OR (s.source_effect_binding='command_v1' AND p->'actions' @> '["command:source.mutate"]'::jsonb)));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION guard_scoped_source_profile(),application_scoped_grant_allowed_before_records(uuid,jsonb) FROM PUBLIC;
COMMIT;
