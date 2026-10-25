-- Spec: docs/architecture/features/application-platform-management.md
-- [COMP:api/application-management] Deployed code metadata, not uploaded modules or a second ACL.
BEGIN;
CREATE TABLE application_deployed_module_capabilities (
 module_key text PRIMARY KEY REFERENCES application_native_field_contracts(module_key),
 contract_version text NOT NULL CHECK(length(contract_version) BETWEEN 1 AND 128),
 default_state text NOT NULL DEFAULT 'enabled' CHECK(default_state IN('enabled','disabled')),
 commands text[] NOT NULL CHECK(cardinality(commands) BETWEEN 1 AND 128 AND array_position(commands,NULL) IS NULL),
 dependencies text[] NOT NULL DEFAULT '{}' CHECK(cardinality(dependencies)<=32 AND array_position(dependencies,NULL) IS NULL),
 queries text[] NOT NULL CHECK(cardinality(queries)<=128 AND array_position(queries,NULL) IS NULL),
 CHECK(NOT('record_create'=ANY(commands) OR 'record_patch'=ANY(commands) OR 'record_delete'=ANY(commands) OR 'record_batch'=ANY(commands)))
);
ALTER TABLE application_deployed_module_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_native_resource_owners ADD COLUMN semantic_writes_required boolean NOT NULL DEFAULT false;
CREATE FUNCTION application_deployed_module_owner_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.semantic_writes_required THEN NEW.semantic_writes_required:=true;END IF;
 IF EXISTS(SELECT 1 FROM application_deployed_module_capabilities c WHERE c.module_key=NEW.module_key) THEN NEW.semantic_writes_required:=true;END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_deployed_module_owner_guard() FROM PUBLIC;
CREATE TRIGGER application_deployed_module_owner_guard BEFORE INSERT OR UPDATE ON application_native_resource_owners
 FOR EACH ROW EXECUTE FUNCTION application_deployed_module_owner_guard();
CREATE FUNCTION application_guard_deployed_module_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE row_metadata jsonb;ownership application_native_resource_owners;context jsonb;command_key text:=nullif(current_setting('app.application_command_key',true),'');
BEGIN
 row_metadata:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=(row_metadata->>'workspace_id')::uuid) THEN
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 SELECT * INTO ownership FROM application_native_resource_owners o WHERE o.workspace_id=(row_metadata->>'workspace_id')::uuid
 AND o.origin=jsonb_build_object('kind','generic','entityTypeId',row_metadata->>'entity_type_id') AND o.semantic_writes_required;
 IF ownership.module_key IS NOT NULL THEN
 context:=application_current_maxima();
 IF context IS NOT NULL THEN
 IF context->>'workspaceId' IS DISTINCT FROM ownership.workspace_id::text
 OR NOT EXISTS(SELECT 1 FROM application_clients c JOIN application_deployed_module_capabilities d ON d.module_key=c.module_key
 WHERE c.id=(context->>'appId')::uuid AND c.workspace_id=ownership.workspace_id AND c.module_key=ownership.module_key AND command_key=ANY(d.commands))
 THEN RAISE EXCEPTION 'access_unavailable: semantic module command required' USING ERRCODE='42501';END IF;
 ELSE
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL
 OR current_setting('app.deployed_application_module',true) IS DISTINCT FROM ownership.module_key
 OR NOT EXISTS(SELECT 1 FROM application_deployed_module_capabilities d WHERE d.module_key=ownership.module_key AND command_key=ANY(d.commands))
 OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=ownership.workspace_id AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
 OR assistant_placement_visible(nullif(current_setting('app.current_user_id',true),'')::uuid,nullif(current_setting('app.v2_assistant_id',true),'')::uuid) IS NOT TRUE
 THEN RAISE EXCEPTION 'access_unavailable: native semantic module command required' USING ERRCODE='42501';END IF;
 END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION application_guard_deployed_module_record() FROM PUBLIC;
CREATE TRIGGER application_deployed_module_record BEFORE INSERT OR UPDATE OR DELETE ON entity_instances
 FOR EACH ROW EXECUTE FUNCTION application_guard_deployed_module_record();

REVOKE ALL ON application_deployed_module_capabilities FROM PUBLIC;
CREATE FUNCTION application_deployed_module_epoch_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP<>'DELETE' AND (EXISTS(SELECT 1 FROM unnest(NEW.commands||NEW.queries) key WHERE key !~ '^[a-z][a-z0-9_.-]{0,127}$')
 OR cardinality(NEW.commands)<>(SELECT count(DISTINCT key) FROM unnest(NEW.commands) key)
 OR cardinality(NEW.queries)<>(SELECT count(DISTINCT key) FROM unnest(NEW.queries) key)) THEN RAISE EXCEPTION 'invalid_module_capabilities' USING ERRCODE='22023';END IF;
 IF TG_OP<>'DELETE' THEN UPDATE application_native_resource_owners SET semantic_writes_required=true WHERE module_key=NEW.module_key AND NOT semantic_writes_required;END IF;
 UPDATE application_policy_contract_epoch SET revision=nextval('application_policy_revision_seq');RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_deployed_module_epoch_changed() FROM PUBLIC;
CREATE TRIGGER application_deployed_module_epoch_changed AFTER INSERT OR UPDATE OR DELETE ON application_deployed_module_capabilities
 FOR EACH ROW EXECUTE FUNCTION application_deployed_module_epoch_changed();
CREATE FUNCTION application_deployed_module_matches(module text,version text,commands text[],queries text[],dependencies text[],default_state text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT c.contract_version=version AND f.contract_version=c.contract_version AND c.default_state=application_deployed_module_matches.default_state
 AND ARRAY(SELECT key FROM unnest(c.commands) key ORDER BY key)=ARRAY(SELECT key FROM unnest(application_deployed_module_matches.commands) key ORDER BY key)
 AND ARRAY(SELECT key FROM unnest(c.queries) key ORDER BY key)=ARRAY(SELECT key FROM unnest(application_deployed_module_matches.queries) key ORDER BY key)
 AND ARRAY(SELECT key FROM unnest(c.dependencies) key ORDER BY key)=ARRAY(SELECT key FROM unnest(application_deployed_module_matches.dependencies) key ORDER BY key)
 FROM application_deployed_module_capabilities c JOIN application_native_field_contracts f ON f.module_key=c.module_key WHERE c.module_key=module),CASE WHEN EXISTS(SELECT 1 FROM application_native_resource_owners owner WHERE owner.module_key=module AND owner.semantic_writes_required) THEN false ELSE NULL::boolean END)
$$;
REVOKE ALL ON FUNCTION application_deployed_module_matches(text,text,text[],text[],text[],text) FROM PUBLIC;
CREATE FUNCTION application_deployed_module_state(w uuid,module text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE capability application_deployed_module_capabilities;contract application_native_field_contracts;schemas jsonb;namespace text;procedure_name text;revision text;lifecycle jsonb;
BEGIN
 SELECT * INTO capability FROM application_deployed_module_capabilities WHERE module_key=module;
 SELECT * INTO contract FROM application_native_field_contracts WHERE module_key=module;
 IF capability.module_key IS NULL OR capability.contract_version IS DISTINCT FROM contract.contract_version
 OR application_native_record_port_valid(contract.metadata_reader) IS NOT TRUE
 OR contract.catalog_reader IS NULL OR application_native_catalog_port_valid(contract.catalog_reader) IS NOT TRUE
 OR application_native_configuration_verified(w,module) IS NOT TRUE THEN RETURN NULL;END IF;
 IF contract.configuration_reader IS NOT NULL THEN
 SELECT n.nspname,p.proname INTO namespace,procedure_name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=contract.configuration_reader;
 EXECUTE format('SELECT %I.%I($1)',namespace,procedure_name) INTO revision USING w;
 END IF;
 SELECT to_jsonb(m) INTO lifecycle FROM workspace_modules m WHERE m.workspace_id=w AND m.module_key=module;
 IF coalesce(lifecycle->>'state',capability.default_state)<>'enabled' THEN RETURN NULL;END IF;
 SELECT jsonb_agg(jsonb_build_object('owner',to_jsonb(o),'id',t.id,'schemaVersion',t.schema_version,'properties',t.properties) ORDER BY t.id)
 INTO schemas FROM application_native_resource_owners o JOIN entity_types t ON t.workspace_id=o.workspace_id AND o.origin=jsonb_build_object('kind','generic','entityTypeId',t.id)
 WHERE o.workspace_id=w AND o.module_key=module AND o.resource_type='record.'||t.id::text;
 IF schemas IS NULL OR EXISTS(SELECT 1 FROM application_native_resource_owners WHERE workspace_id=w AND module_key=module AND origin->>'kind'<>'generic') THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('capability',to_jsonb(capability),'fieldContract',to_jsonb(contract),'schemas',schemas,'configurationRevision',revision,'moduleLifecycle',coalesce(lifecycle,jsonb_build_object('state',capability.default_state,'version',0)),
 'ports',jsonb_build_array(application_policy_port_fingerprint(contract.metadata_reader),application_policy_port_fingerprint(contract.catalog_reader),application_policy_port_fingerprint(contract.configuration_reader)));
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_deployed_module_state(uuid,text) FROM PUBLIC;
CREATE FUNCTION read_application_module_role(w uuid,module text,role_key text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;app_id uuid:=nullif(current_setting('app.application_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
BEGIN
 IF actor IS NULL OR acting IS NULL OR NOT EXISTS(SELECT 1 FROM assistants WHERE id=acting AND workspace_id=w)
 OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.application_native_role_assignments'::regclass
 WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
 OR NOT EXISTS(SELECT 1 FROM application_native_field_contracts c WHERE c.module_key=module AND role_key=ANY(c.role_keys))
 OR application_native_configuration_verified(w,module) IS NOT TRUE THEN RETURN false;END IF;
 IF app_id IS NOT NULL THEN
 IF NOT EXISTS(SELECT 1 FROM application_clients c WHERE c.id=app_id AND c.workspace_id=w AND c.module_key=module AND c.executing_assistant_id=acting)
 OR application_current_maxima() IS NULL THEN RETURN false;END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) OR assistant_placement_visible(actor,acting) IS NOT TRUE THEN RETURN false;END IF;
 END IF;
 RETURN EXISTS(SELECT 1 FROM application_native_role_assignments a WHERE a.workspace_id=w AND a.module_key=module AND a.user_id=actor
 AND a.role_key=read_application_module_role.role_key AND a.status='active' AND a.starts_at<=statement_timestamp() AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp()));
END $$;
REVOKE ALL ON FUNCTION read_application_module_role(uuid,text,text) FROM PUBLIC;
CREATE FUNCTION application_lock_module_records(w uuid,module text,ids uuid[]) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb:=application_current_maxima();actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 command_key text:=nullif(current_setting('app.application_command_key',true),'');candidate record;observed integer:=0;policy jsonb;
BEGIN
 IF ids IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 100 OR array_position(ids,NULL) IS NOT NULL
 OR cardinality(ids)<>(SELECT count(DISTINCT id) FROM unnest(ids) id)
 OR actor IS NULL OR NOT EXISTS(SELECT 1 FROM application_deployed_module_capabilities d WHERE d.module_key=module AND command_key=ANY(d.commands))
 OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entity_instances'::regclass WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
 THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF context IS NOT NULL THEN
 IF context->>'workspaceId' IS DISTINCT FROM w::text OR NOT EXISTS(SELECT 1 FROM application_clients c WHERE c.id=(context->>'appId')::uuid AND c.workspace_id=w AND c.module_key=module) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 ELSE
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL OR current_setting('app.deployed_application_module',true) IS DISTINCT FROM module
 OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
 OR assistant_placement_visible(actor,nullif(current_setting('app.v2_assistant_id',true),'')::uuid) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 END IF;
 FOR candidate IN SELECT r.id,r.entity_type_id,r.workspace_id,r.sensitivity,r.compartments,r.project_ids FROM entity_instances r
 JOIN application_native_resource_owners o ON o.workspace_id=r.workspace_id AND o.origin=jsonb_build_object('kind','generic','entityTypeId',r.entity_type_id) AND o.module_key=module
 WHERE r.workspace_id=w AND r.id=ANY(ids) ORDER BY r.id FOR UPDATE OF r LOOP
 IF scope_review_state_held('entity_instance',candidate.id) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF context IS NOT NULL THEN
 IF application_reference_allows(w,jsonb_build_object('kind','generic','entityTypeId',candidate.entity_type_id),'record.'||candidate.entity_type_id::text,candidate.id) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 ELSE
 policy:=application_current_native_field_policy(w,jsonb_build_object('kind','generic','entityTypeId',candidate.entity_type_id),'record.'||candidate.entity_type_id::text,candidate.id);
 IF context_scope_allows_current_principal(w,candidate.sensitivity,candidate.compartments,candidate.project_ids) IS NOT TRUE
 OR policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' OR jsonb_array_length(policy->'readFields')=0 THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 END IF;
 observed:=observed+1;
 END LOOP;
 IF observed<>cardinality(ids) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION application_lock_module_records(uuid,text,uuid[]) FROM PUBLIC;
ALTER TABLE application_scoped_activations DROP CONSTRAINT application_scoped_activations_profile_check;
ALTER TABLE application_scoped_activations ADD CONSTRAINT application_scoped_activations_profile_check
 CHECK(profile IN('canonical_service_v1','canonical_records_service_v1','canonical_module_service_v1'));
ALTER TABLE application_scoped_activations ADD COLUMN deployed_snapshot jsonb;
ALTER FUNCTION application_scoped_qualified(uuid,uuid) RENAME TO application_scoped_qualified_before_modules;
REVOKE ALL ON FUNCTION application_scoped_qualified_before_modules(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION application_scoped_qualified(w uuid,a uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT application_scoped_qualified_before_modules(w,a) OR EXISTS(
 SELECT 1 FROM application_scoped_activations s JOIN application_clients c ON c.id=s.app_id AND c.workspace_id=s.workspace_id
 JOIN assistants agent ON agent.id=s.assistant_id AND agent.workspace_id=s.workspace_id
 JOIN workspace_members issuer ON issuer.workspace_id=s.workspace_id AND issuer.user_id=s.activated_by AND issuer.role IN('owner','admin')
 WHERE s.app_id=a AND s.workspace_id=w AND s.status='active' AND s.profile='canonical_module_service_v1'
 AND c.status='active' AND c.client_mode='api_client' AND c.module_key NOT IN('native','records')
 AND c.grant_revision=s.app_revision AND c.executing_assistant_id=s.assistant_id
 AND s.deployed_snapshot IS NOT NULL AND s.deployed_snapshot=application_deployed_module_state(w,c.module_key))
$$;
ALTER FUNCTION application_activation_snapshot(uuid) RENAME TO application_activation_snapshot_before_modules;
REVOKE ALL ON FUNCTION application_activation_snapshot_before_modules(uuid) FROM PUBLIC;
CREATE FUNCTION application_activation_snapshot(a uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c application_clients;agent assistants;deployed jsonb;
BEGIN
 SELECT * INTO c FROM application_clients WHERE id=a;
 IF c.module_key IN('native','records') OR c.id IS NULL THEN RETURN application_activation_snapshot_before_modules(a);END IF;
 IF c.status<>'active' OR c.client_mode<>'api_client' OR application_governance_allows(c.workspace_id) IS NOT TRUE
 OR nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO agent FROM assistants WHERE id=c.executing_assistant_id AND workspace_id=c.workspace_id
 AND assistant_placement_visible(nullif(current_setting('app.current_user_id',true),'')::uuid,id);
 deployed:=application_deployed_module_state(c.workspace_id,c.module_key);
 IF agent.id IS NULL OR deployed IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('profile','canonical_module_service_v1','application',to_jsonb(c),'assistant',to_jsonb(agent),'moduleContract',deployed);
END $$;
CREATE FUNCTION application_scoped_reference_grant_allowed(a uuid,p jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE app application_clients;target text;
BEGIN
 SELECT * INTO app FROM application_clients WHERE id=a;
 target:=CASE p->>'typeKey' WHEN 'person' THEN 'contact' ELSE p->>'typeKey' END;
 RETURN app.id IS NOT NULL AND application_scoped_qualified(app.workspace_id,a)
 AND p->'principal'->>'kind'='service' AND p->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb
 AND p->>'typeKey' IN('company','person','deal','task') AND p->'selector'->>'kind'='ids'
 AND p->'actions'='["read"]'::jsonb AND p->'readFields'='[]'::jsonb AND p->'writeFields'='[]'::jsonb
 AND (app.module_key='records' OR EXISTS(SELECT 1 FROM application_deployed_module_capabilities c WHERE c.module_key=app.module_key AND 'native'=ANY(c.dependencies)))
 AND EXISTS(SELECT 1 FROM entity_types t,LATERAL jsonb_array_elements(t.properties) field WHERE t.workspace_id=app.workspace_id
 AND field->'config'->>'kind'='relation' AND field->'config'->'targetEntityTypeRef'->>'kind'='builtin' AND field->'config'->'targetEntityTypeRef'->>'name'=target
 AND (app.module_key='records' OR EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=t.workspace_id AND o.origin=jsonb_build_object('kind','generic','entityTypeId',t.id) AND o.module_key=app.module_key)));
END $$;
REVOKE ALL ON FUNCTION application_scoped_reference_grant_allowed(uuid,jsonb) FROM PUBLIC;
ALTER FUNCTION application_scoped_grant_allowed(uuid,jsonb) RENAME TO application_scoped_grant_allowed_before_modules;
REVOKE ALL ON FUNCTION application_scoped_grant_allowed_before_modules(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION application_scoped_grant_allowed(a uuid,p jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE app application_clients;capability application_deployed_module_capabilities;schema_row entity_types;fields text[];writable text[];
BEGIN
 SELECT * INTO app FROM application_clients WHERE id=a;
 IF p->'origin'->>'kind'='native' AND app.module_key<>'native' THEN RETURN application_scoped_reference_grant_allowed(a,p);END IF;
 IF app.module_key IN('native','records') OR app.id IS NULL THEN RETURN application_scoped_grant_allowed_before_modules(a,p);END IF;
 IF application_scoped_qualified(app.workspace_id,a) IS NOT TRUE OR p->'principal'->>'kind' IS DISTINCT FROM 'service'
 OR p->'origin'->>'kind' IS DISTINCT FROM 'generic' OR p->'selector'->>'kind' NOT IN('self','ids') THEN RETURN false;END IF;
 SELECT * INTO capability FROM application_deployed_module_capabilities WHERE module_key=app.module_key;
 SELECT t.* INTO schema_row FROM entity_types t JOIN application_native_resource_owners o ON o.workspace_id=t.workspace_id
 AND o.origin=jsonb_build_object('kind','generic','entityTypeId',t.id) AND o.resource_type='record.'||t.id::text
 WHERE t.id=(p->'origin'->>'entityTypeId')::uuid AND t.workspace_id=app.workspace_id AND o.module_key=app.module_key;
 IF capability.module_key IS NULL OR schema_row.id IS NULL OR p->'origin' IS DISTINCT FROM jsonb_build_object('kind','generic','entityTypeId',schema_row.id)
 OR p->>'typeKey' IS DISTINCT FROM 'record.'||schema_row.id::text THEN RETURN false;END IF;
 fields:=ARRAY(SELECT property->>'name' FROM jsonb_array_elements(schema_row.properties) property);
 writable:=ARRAY(SELECT property->>'name' FROM jsonb_array_elements(schema_row.properties) property WHERE property->'config'->>'kind' NOT IN('created_time','created_by','last_edited_time','last_edited_by'));
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'actions') action
 WHERE action NOT IN('read','query','history','schema','create','patch','delete') AND NOT (action LIKE 'command:%' AND substring(action FROM 9)=ANY(capability.commands)))
 AND p->'readFields'<@to_jsonb(fields) AND p->'writeFields'<@to_jsonb(writable);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;
DO $extend$ DECLARE definition text;original text;replacement text;BEGIN
 definition:=pg_get_functiondef('application_apply_activation(uuid)'::regprocedure);
 original:=$old$'canonical_service_v1','canonical_records_service_v1'$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'module_activation_profiles_changed';END IF;
 definition:=replace(definition,original,$new$'canonical_service_v1','canonical_records_service_v1','canonical_module_service_v1'$new$);
 original:=$old$app_id,workspace_id,profile,app_revision,assistant_id,activated_by,status)$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'module_activation_insert_changed';END IF;
 definition:=replace(definition,original,$new$app_id,workspace_id,profile,app_revision,assistant_id,activated_by,status,deployed_snapshot)$new$);
 original:=$old$(s#>>'{application,executing_assistant_id}')::uuid,v.actor_id,'active')$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'module_activation_snapshot_changed';END IF;
 definition:=replace(definition,original,$new$(s#>>'{application,executing_assistant_id}')::uuid,v.actor_id,'active',s->'moduleContract')$new$);
 original:=$old$profile=excluded.profile,app_revision=excluded.app_revision$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'module_activation_conflict_changed';END IF;
 EXECUTE replace(definition,original,$new$deployed_snapshot=excluded.deployed_snapshot,profile=excluded.profile,app_revision=excluded.app_revision$new$);
 definition:=pg_get_functiondef('application_grant_release_snapshot_before_source_service(uuid,jsonb)'::regprocedure);
 original:=$old$origin->>'kind'='generic' AND app.module_key='records'$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'module_generic_release_branch_changed';END IF;
 EXECUTE replace(definition,original,$new$origin->>'kind'='generic' AND (app.module_key='records' OR EXISTS(SELECT 1 FROM application_native_resource_owners o
 JOIN application_deployed_module_capabilities c ON c.module_key=o.module_key JOIN application_native_field_contracts f ON f.module_key=c.module_key AND f.contract_version=c.contract_version
 WHERE o.workspace_id=app.workspace_id AND o.origin=proposal->'origin' AND o.resource_type=proposal->>'typeKey' AND o.module_key=app.module_key))$new$);
 definition:=pg_get_functiondef('application_grant_release_snapshot_before_source_service(uuid,jsonb)'::regprocedure);
 original:=$old$origin='{"kind":"native","moduleKey":"native"}'::jsonb AND app.module_key='native' AND proposal->'selector'->>'kind' IN('ids','self')$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'module_native_reference_branch_changed';END IF;
 EXECUTE replace(definition,original,$new$origin='{"kind":"native","moduleKey":"native"}'::jsonb AND (app.module_key='native' OR application_scoped_reference_grant_allowed(app.id,proposal)) AND proposal->'selector'->>'kind' IN('ids','self')$new$);
 definition:=pg_get_functiondef('application_scoped_credential_allowed(uuid,jsonb)'::regprocedure);
 original:=$old$jsonb_array_elements_text(p->'grantIds') id LEFT JOIN application_access_grants g ON g.id=id::uuid$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'scoped_credential_selected_join_changed';END IF;
 EXECUTE replace(definition,original,$new$jsonb_array_elements_text(p->'grantIds') selected(grant_id) LEFT JOIN application_access_grants g ON g.id=selected.grant_id::uuid$new$);
 definition:=pg_get_functiondef('application_native_governance_proposal_allows(uuid,text,jsonb)'::regprocedure);
 original:=$old$IF NOT FOUND THEN RETURN false; END IF;
  -- Delegation cannot manufacture a role$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'module_service_role_target_changed';END IF;
 EXECUTE replace(definition,original,$new$IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM public.users u JOIN public.application_clients c ON u.auth_provider='channel'
   AND u.auth_provider_id LIKE 'app-service:'||c.id::text||':%' AND c.workspace_id=w AND c.module_key=module AND c.status='active'
   WHERE u.id=(proposal->>'userId')::uuid AND public.application_scoped_qualified(w,c.id)) THEN RETURN false;END IF;
  -- Delegation cannot manufacture a role$new$);
 definition:=pg_get_functiondef('application_native_governance_proposal_allows(uuid,text,jsonb)'::regprocedure);
 original:=$old$  -- Delegation cannot manufacture a role or extend its current issuer horizon.$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'module_initial_role_branch_changed';END IF;
 EXECUTE replace(definition,original,$new$  -- Reviewed initial owner self-assignment precedes schema ownership and cannot revive history.
  IF (proposal->>'userId')::uuid=actor
   AND EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=w AND m.user_id=actor AND m.role='owner')
   AND EXISTS(SELECT 1 FROM public.application_deployed_module_capabilities c WHERE c.module_key=module)
   AND NOT EXISTS(SELECT 1 FROM public.application_native_role_assignments a WHERE a.workspace_id=w AND a.module_key=module AND a.role_key=proposal->>'roleKey')
   AND NOT EXISTS(SELECT 1 FROM public.application_native_resource_owners o WHERE o.workspace_id=w AND o.module_key=module)
   THEN RETURN true;END IF;
  -- Delegation cannot manufacture a role or extend its current issuer horizon.$new$);
 definition:=pg_get_functiondef('application_apply_native_governance_review(uuid,uuid,uuid)'::regprocedure);
 original:=$old$BEGIN
 SELECT * INTO review$old$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'module_initial_role_apply_lock_changed';END IF;
 EXECUTE replace(definition,original,$new$BEGIN
 -- Serialize first-role reviews before reading current revision or role history.
 PERFORM 1 FROM public.workspaces WHERE id=w FOR UPDATE;
 SELECT * INTO review$new$);
END $extend$;
REVOKE ALL ON FUNCTION application_scoped_qualified(uuid,uuid),application_scoped_grant_allowed(uuid,jsonb),application_activation_snapshot(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON application_deployed_module_capabilities FROM app_user;
 REVOKE ALL ON FUNCTION application_scoped_qualified_before_modules(uuid,uuid),application_scoped_grant_allowed_before_modules(uuid,jsonb),application_activation_snapshot_before_modules(uuid) FROM app_user;
 GRANT EXECUTE ON FUNCTION application_deployed_module_matches(text,text,text[],text[],text[],text),application_lock_module_records(uuid,text,uuid[]),read_application_module_role(uuid,text,text),application_scoped_qualified(uuid,uuid),application_scoped_grant_allowed(uuid,jsonb) TO app_user;
END IF;END $$;
COMMIT;
