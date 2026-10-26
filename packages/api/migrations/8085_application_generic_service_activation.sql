-- Spec: docs/architecture/features/application-platform-management.md
-- [COMP:api/application-management] General canonical generic schemas, same canonical authority.
BEGIN;
ALTER TABLE application_scoped_activations DROP CONSTRAINT application_scoped_activations_profile_check;
ALTER TABLE application_scoped_activations ADD CONSTRAINT application_scoped_activations_profile_check
 CHECK(profile IN('canonical_service_v1','canonical_records_service_v1'));
ALTER FUNCTION application_scoped_qualified(uuid,uuid) RENAME TO application_scoped_qualified_before_records;
REVOKE ALL ON FUNCTION application_scoped_qualified_before_records(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION application_scoped_qualified(w uuid,a uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT application_scoped_qualified_before_records(w,a) OR EXISTS(
 SELECT 1 FROM application_scoped_activations s JOIN application_clients c ON c.id=s.app_id AND c.workspace_id=s.workspace_id
 JOIN assistants agent ON agent.id=s.assistant_id AND agent.workspace_id=s.workspace_id
 JOIN workspace_members issuer ON issuer.workspace_id=s.workspace_id AND issuer.user_id=s.activated_by AND issuer.role IN('owner','admin')
 WHERE s.app_id=a AND s.workspace_id=w AND s.status='active' AND s.profile='canonical_records_service_v1'
 AND c.status='active' AND c.client_mode='api_client' AND c.module_key='records'
 AND c.grant_revision=s.app_revision AND c.executing_assistant_id=s.assistant_id)
$$;
ALTER FUNCTION application_scoped_grant_allowed(uuid,jsonb) RENAME TO application_scoped_grant_allowed_before_records;
REVOKE ALL ON FUNCTION application_scoped_grant_allowed_before_records(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION application_scoped_grant_allowed(a uuid,p jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE app application_clients;schema_row entity_types;fields text[];writable text[];
BEGIN
 SELECT * INTO app FROM application_clients WHERE id=a;
 IF app.module_key IS DISTINCT FROM 'records' THEN RETURN application_scoped_grant_allowed_before_records(a,p);END IF;
 IF application_scoped_qualified(app.workspace_id,a) IS NOT TRUE
 OR p->'principal'->>'kind' IS DISTINCT FROM 'service' OR p->'origin'->>'kind' IS DISTINCT FROM 'generic'
 OR p->'selector'->>'kind' NOT IN('self','ids') THEN RETURN false;END IF;
 SELECT * INTO schema_row FROM entity_types WHERE id=(p->'origin'->>'entityTypeId')::uuid AND workspace_id=app.workspace_id;
 IF schema_row.id IS NULL OR p->'origin' IS DISTINCT FROM jsonb_build_object('kind','generic','entityTypeId',schema_row.id)
 OR p->>'typeKey' IS DISTINCT FROM 'record.'||schema_row.id::text THEN RETURN false;END IF;
 fields:=ARRAY(SELECT property->>'name' FROM jsonb_array_elements(schema_row.properties) property);
 writable:=ARRAY(SELECT property->>'name' FROM jsonb_array_elements(schema_row.properties) property
 WHERE property->'config'->>'kind' NOT IN('created_time','created_by','last_edited_time','last_edited_by'));
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'actions') action
 WHERE action NOT IN('read','query','history','schema','create','patch','delete','command:record_create','command:record_patch','command:record_delete','command:record_batch'))
 AND p->'readFields'<@to_jsonb(fields) AND p->'writeFields'<@to_jsonb(writable);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;
ALTER FUNCTION application_activation_snapshot(uuid) RENAME TO application_activation_snapshot_before_records;
REVOKE ALL ON FUNCTION application_activation_snapshot_before_records(uuid) FROM PUBLIC;
CREATE FUNCTION application_activation_snapshot(a uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c application_clients;agent assistants;
BEGIN
 SELECT * INTO c FROM application_clients WHERE id=a;
 IF c.module_key IS DISTINCT FROM 'records' THEN RETURN application_activation_snapshot_before_records(a);END IF;
 IF c.status<>'active' OR c.client_mode<>'api_client' OR application_governance_allows(c.workspace_id) IS NOT TRUE
 OR nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO agent FROM assistants WHERE id=c.executing_assistant_id AND workspace_id=c.workspace_id
 AND assistant_placement_visible(nullif(current_setting('app.current_user_id',true),'')::uuid,id);
 IF agent.id IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('profile','canonical_records_service_v1','application',to_jsonb(c),'assistant',to_jsonb(agent));
END $$;
CREATE OR REPLACE FUNCTION application_apply_activation(r uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v application_activation_reviews;s jsonb;
BEGIN
 SELECT * INTO v FROM application_activation_reviews WHERE id=r AND actor_id=nullif(current_setting('app.current_user_id',true),'')::uuid FOR UPDATE;
 IF v.id IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 PERFORM id FROM application_clients WHERE id=v.app_id FOR SHARE;
 s:=application_activation_snapshot(v.app_id);
 IF v.expires_at<=clock_timestamp() OR s IS DISTINCT FROM v.snapshot THEN RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001';END IF;
 IF v.consumed THEN
 IF application_scoped_qualified(v.workspace_id,v.app_id) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 RETURN v.app_id;END IF;
 IF s->>'profile' NOT IN('canonical_service_v1','canonical_records_service_v1') THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO application_scoped_activations(app_id,workspace_id,profile,app_revision,assistant_id,activated_by,status)
 VALUES(v.app_id,v.workspace_id,s->>'profile',(s#>>'{application,grant_revision}')::bigint,(s#>>'{application,executing_assistant_id}')::uuid,v.actor_id,'active')
 ON CONFLICT(app_id) DO UPDATE SET profile=excluded.profile,app_revision=excluded.app_revision,assistant_id=excluded.assistant_id,activated_by=excluded.activated_by,status='active',version=gen_random_uuid();
 UPDATE application_activation_reviews SET consumed=true WHERE id=r;
 INSERT INTO application_authority_events(workspace_id,app_id,actor_user_id,action,resource_id) VALUES(v.workspace_id,v.app_id,v.actor_id,'client_status_changed',v.app_id);
 RETURN v.app_id;
END $$;
-- This profile does not confer the separately reviewed native source setup capability.
ALTER FUNCTION application_source_setup_snapshot(uuid,uuid,uuid) RENAME TO application_source_setup_snapshot_before_records;
REVOKE ALL ON FUNCTION application_source_setup_snapshot_before_records(uuid,uuid,uuid) FROM PUBLIC;
CREATE FUNCTION application_source_setup_snapshot(w uuid,a uuid,i uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT application_source_setup_snapshot_before_records(w,a,i)
 WHERE EXISTS(SELECT 1 FROM application_scoped_activations s WHERE s.app_id=a AND s.workspace_id=w AND s.profile='canonical_service_v1')
$$;
REVOKE ALL ON FUNCTION application_scoped_qualified(uuid,uuid),application_scoped_grant_allowed(uuid,jsonb),application_activation_snapshot(uuid),application_apply_activation(uuid),application_source_setup_snapshot(uuid,uuid,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON FUNCTION application_scoped_qualified_before_records(uuid,uuid),application_scoped_grant_allowed_before_records(uuid,jsonb),application_activation_snapshot_before_records(uuid),application_source_setup_snapshot_before_records(uuid,uuid,uuid) FROM app_user;
 GRANT EXECUTE ON FUNCTION application_scoped_qualified(uuid,uuid),application_scoped_grant_allowed(uuid,jsonb),application_apply_activation(uuid),application_source_setup_snapshot(uuid,uuid,uuid) TO app_user;
END IF;END $$;
COMMIT;
