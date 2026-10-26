BEGIN;
-- The maintained configuration lock is shared by native mutators and governance.
CREATE FUNCTION application_lock_canonical_crm_configuration(w uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'invalid_value: canonical CRM requires READ COMMITTED' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('crm-config:'||w::text,0));
END $$;
REVOKE ALL ON FUNCTION application_lock_canonical_crm_configuration(uuid) FROM PUBLIC;

-- [COMP:api/application-records] The existing field boundary admits current
-- application patch + command fields too; it remains a restriction, never a grant.
ALTER FUNCTION application_native_entity_field_writes_allowed(uuid,jsonb,text[]) RENAME TO application_native_entity_field_writes_before_app_patch;
REVOKE ALL ON FUNCTION application_native_entity_field_writes_before_app_patch(uuid,jsonb,text[]) FROM PUBLIC;
CREATE FUNCTION application_native_entity_field_writes_allowed(record_id uuid,patch jsonb,typed_fields text[] DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r record;fields text[];decision jsonb;command_decision jsonb;command_key text;context jsonb;
BEGIN
 IF nullif(current_setting('app.application_id',true),'') IS NULL THEN
  SELECT e.workspace_id,e.kind INTO r FROM public.entities e WHERE e.id=record_id;
  IF FOUND AND r.kind IN('company','person','deal') AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid) THEN
   PERFORM application_lock_canonical_crm_configuration(r.workspace_id);
  END IF;
  RETURN application_native_entity_field_writes_before_app_patch(record_id,patch,typed_fields);
 END IF;
 context:=application_current_maxima();command_key:=nullif(current_setting('app.application_command_key',true),'');
 IF context IS NULL OR context->>'readOnly'='true' OR command_key IS NULL OR jsonb_typeof(patch) IS DISTINCT FROM 'object'
  OR typed_fields IS NOT NULL AND (cardinality(typed_fields)>128 OR array_position(typed_fields,NULL) IS NOT NULL) THEN RETURN false;END IF;
 SELECT e.workspace_id,e.kind,e.created_by_user_id,e.user_id,e.sensitivity,e.compartments,e.project_ids,e.valid_to,e.retracted_at,e.scope_held
  INTO r FROM public.entities e WHERE e.id=record_id;
 IF NOT FOUND OR r.kind NOT IN('company','person','deal') OR r.workspace_id::text IS DISTINCT FROM context->>'workspaceId'
  OR r.valid_to IS NOT NULL OR r.retracted_at IS NOT NULL OR r.scope_held THEN RETURN false;END IF;
 fields:=coalesce(typed_fields,ARRAY(SELECT jsonb_object_keys(CASE WHEN patch ? 'attributes' THEN application_native_entity_attribute_values(patch->'attributes') ELSE '{}'::jsonb END)));
 IF patch ? 'displayName' THEN fields:=fields||'name'::text;END IF;
 IF patch ? 'canonicalId' THEN fields:=fields||CASE r.kind WHEN 'company' THEN 'domain' WHEN 'person' THEN 'email' ELSE 'canonicalId' END;END IF;
 fields:=ARRAY(SELECT DISTINCT field FROM unnest(fields) field ORDER BY field);
 decision:=application_resource_fields(r.workspace_id,'{"kind":"native","moduleKey":"native"}',r.kind,record_id::text,r.created_by_user_id,r.sensitivity,r.compartments,r.project_ids,r.user_id,'patch');
 command_decision:=application_resource_fields(r.workspace_id,'{"kind":"native","moduleKey":"native"}',r.kind,record_id::text,r.created_by_user_id,r.sensitivity,r.compartments,r.project_ids,r.user_id,'command:'||command_key);
 RETURN coalesce(decision IS NOT NULL AND command_decision IS NOT NULL AND to_jsonb(fields)<@(decision->'write') AND to_jsonb(fields)<@(command_decision->'write'),false);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_entity_field_writes_allowed(uuid,jsonb,text[]) FROM PUBLIC;

-- Metadata only, under current source, native/app field and mutation authority.
CREATE FUNCTION application_company_patch_state(record_id uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r record;source jsonb;policy jsonb;mask jsonb;w uuid;context jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF actor IS NULL OR fields IS NULL OR cardinality(fields)>128 OR array_position(fields,NULL) IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_roles role JOIN pg_class tab ON tab.oid='public.entities'::regclass
   WHERE role.rolname=session_user AND (role.rolsuper OR role.rolbypassrls OR pg_has_role(role.oid,tab.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 SELECT e.workspace_id INTO w FROM public.entities e WHERE e.id=record_id AND e.kind='company' AND e.valid_to IS NULL AND e.retracted_at IS NULL AND NOT e.scope_held;
 IF NOT FOUND THEN RETURN NULL;END IF;
 context:=application_current_maxima();
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text THEN RETURN NULL;END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor) THEN RETURN NULL;END IF;
 PERFORM application_lock_canonical_crm_configuration(w);
 SELECT e.id,e.workspace_id,e.created_by_user_id,e.scope_version,e.sensitivity,e.compartments,e.project_ids,e.user_id,e.assistant_id
  INTO r FROM public.entities e WHERE e.id=record_id AND e.kind='company' AND e.valid_to IS NULL AND e.retracted_at IS NULL AND NOT e.scope_held FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 source:=read_scope_source(r.workspace_id,'entity',r.id);
 IF EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=r.workspace_id AND d.resource_kind='entity' AND d.resource_id=r.id)
  OR EXISTS(SELECT 1 FROM read_external_source_dependencies(r.workspace_id,ARRAY['entity'],ARRAY[r.id],ARRAY[r.scope_version::text])) THEN RETURN NULL;END IF;
 IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR scope_review_state_held('entity',r.id)
  OR agent_visibility_allows(r.workspace_id,r.user_id,r.assistant_id) IS NOT TRUE OR agent_mutation_scope_allows(r.compartments) IS NOT TRUE THEN RETURN NULL;END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  IF application_native_entity_field_writes_allowed(record_id,'{}',fields) IS NOT TRUE THEN RETURN NULL;END IF;
 ELSE
  IF workflow_evidence_envelope_visible(r.workspace_id,source) IS NOT TRUE
   OR (r.user_id IS NOT NULL AND r.user_id<>actor)
   OR member_operation_row_allows(member_principal_operation_grants(actor,true,r.workspace_id),r.workspace_id,r.sensitivity,r.compartments) IS NOT TRUE THEN RETURN NULL;END IF;
  policy:=application_current_native_field_policy(r.workspace_id,'{"kind":"native","moduleKey":"native"}','company',r.id);
  IF policy->>'registered' IS DISTINCT FROM 'false' THEN
   IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' OR NOT coalesce(to_jsonb(fields)<@(policy->'writeFields'),false) THEN RETURN NULL;END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('workspaceId',r.workspace_id,'id',r.id,'version',r.scope_version::text,'scope',source);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_company_patch_state(uuid,text[]) FROM PUBLIC;

CREATE FUNCTION application_patch_canonical_company(record_id uuid,patch jsonb,expected_version text DEFAULT NULL,inherited jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fields text[];state jsonb;original public.entities;attributes_patch jsonb:='{}';previous_intent text;updated_version text;
 teams text[];projects uuid[];tier text;reference jsonb;target_scope jsonb;sets text;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF jsonb_typeof(patch) IS DISTINCT FROM 'object' OR patch-ARRAY['name','domain','tags','externalRef','customFields']<>'{}'
  OR patch ? 'name' AND (jsonb_typeof(patch->'name') IS DISTINCT FROM 'string' OR length(btrim(patch->>'name'))=0 OR length(patch->>'name')>256)
  OR patch ? 'domain' AND patch->'domain'<>'null' AND (jsonb_typeof(patch->'domain') IS DISTINCT FROM 'string' OR length(patch->>'domain')>320)
  OR patch ? 'customFields' AND jsonb_typeof(patch->'customFields') IS DISTINCT FROM 'object'
  OR inherited IS NOT NULL AND (jsonb_typeof(inherited) IS DISTINCT FROM 'object' OR inherited-ARRAY['compartments','projectIds','sensitivity']<>'{}') THEN
  RAISE EXCEPTION 'invalid_value: invalid canonical company patch' USING ERRCODE='22023';END IF;
 fields:=ARRAY(SELECT key FROM jsonb_object_keys(patch) key WHERE key<>'customFields' UNION SELECT 'custom.'||key FROM jsonb_object_keys(coalesce(patch->'customFields','{}')) key ORDER BY 1);
 state:=application_company_patch_state(record_id,fields);
 IF state IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF expected_version IS NOT NULL AND (expected_version !~ '^[1-9]\d*$' OR state->>'version'<>expected_version) THEN
  RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001';END IF;
 IF patch='{}' AND inherited IS NULL THEN RETURN jsonb_build_object('workspaceId',state->'workspaceId','origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey','company','id',record_id,'version',state->'version');END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(coalesce(patch->'customFields','{}')) provided WHERE NOT EXISTS(
  SELECT 1 FROM crm_field_definitions f WHERE f.workspace_id=(state->>'workspaceId')::uuid AND f.entity_kind='company' AND f.field_key=provided AND f.archived_at IS NULL)) THEN
  RAISE EXCEPTION 'invalid_value: undeclared canonical custom field' USING ERRCODE='22023';END IF;
 -- Business values stay inside the canonical database mutation after admission.
 SELECT * INTO original FROM public.entities WHERE id=record_id;
 teams:=original.compartments;projects:=original.project_ids;tier:=original.sensitivity;
 IF inherited IS NOT NULL THEN
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(coalesce(inherited->'compartments','[]')))) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(coalesce(inherited->'projectIds','[]'))::uuid)) value ORDER BY value);
  IF inherited->>'sensitivity' IS NOT NULL THEN
   IF sensitivity_rank(inherited->>'sensitivity') IS NULL THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023';END IF;
   IF sensitivity_rank(inherited->>'sensitivity')>sensitivity_rank(tier) THEN tier:=inherited->>'sensitivity';END IF;
  END IF;
 END IF;
 IF patch ? 'domain' AND coalesce(patch->>'domain','')<>'' THEN attributes_patch:=attributes_patch||jsonb_build_object('domain',patch->'domain');END IF;
 IF patch ? 'tags' THEN attributes_patch:=attributes_patch||jsonb_build_object('tags',patch->'tags');END IF;
 IF patch ? 'externalRef' THEN attributes_patch:=attributes_patch||jsonb_build_object('external_ref',patch->'externalRef');END IF;
 IF patch ? 'customFields' THEN attributes_patch:=attributes_patch||jsonb_build_object('custom_fields',(SELECT coalesce(jsonb_object_agg(key,value),'{}') FROM jsonb_each(patch->'customFields') WHERE value<>'null'::jsonb AND value<>'""'::jsonb));END IF;
 FOR reference IN SELECT value FROM jsonb_array_elements(application_field_references(original.workspace_id,'{"kind":"native","moduleKey":"native"}','company',application_native_entity_attribute_values(attributes_patch))) LOOP
  target_scope:=read_scope_source(original.workspace_id,'entity',(reference->>'id')::uuid);
  IF target_scope IS NULL OR target_scope->>'held' IS DISTINCT FROM 'false' OR target_scope->>'userId' IS NOT NULL AND target_scope->>'userId' IS DISTINCT FROM original.user_id::text
   OR target_scope->>'assistantId' IS NOT NULL AND target_scope->>'assistantId' IS DISTINCT FROM original.assistant_id::text THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(target_scope->'compartments'))) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(target_scope->'projectIds')::uuid)) value ORDER BY value);
  IF sensitivity_rank(target_scope->>'sensitivity')>sensitivity_rank(tier) THEN tier:=target_scope->>'sensitivity';END IF;
 END LOOP;
 IF agent_mutation_scope_allows(teams) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF cardinality(fields)=0 AND tier=original.sensitivity AND teams=original.compartments AND projects=original.project_ids THEN
  RETURN jsonb_build_object('workspaceId',original.workspace_id,'origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey','company','id',record_id,'version',original.scope_version::text);END IF;
 previous_intent:=coalesce(current_setting('app.native_entity_write_intent',true),'');
 PERFORM set_config('app.native_entity_write_intent',jsonb_build_object('workspaceId',original.workspace_id,'typeKey','company','id',record_id,'fields',fields)::text,true);
 INSERT INTO brain_row_versions(primitive,row_id,version_no,before_image,valid_from,valid_to,mutation_actor,mutation_reason,sensitivity,workspace_id)
  SELECT 'entity',record_id,coalesce(max(v.version_no),0)+1,to_jsonb(original)-'embedding',coalesce(max(v.valid_to),original.created_at),clock_timestamp(),
   CASE WHEN nullif(current_setting('app.application_id',true),'') IS NULL THEN 'human_edit' ELSE 'assistant_turn' END,'native.company.patch',original.sensitivity,original.workspace_id
  FROM brain_row_versions v WHERE v.primitive='entity' AND v.row_id=record_id;
 sets:='attributes=public.application_merge_native_entity_attributes(attributes,$1,$2),sensitivity=$3,compartments=$4,project_ids=$5,updated_at=clock_timestamp()';
 IF patch ? 'name' THEN sets:=sets||',display_name=$6';END IF;
 IF patch ? 'domain' THEN sets:=sets||',canonical_id=$7';END IF;
 -- Only compiled column fragments vary; every value remains bound.
 EXECUTE 'UPDATE public.entities SET '||sets||' WHERE id=$8 RETURNING scope_version::text'
  INTO updated_version USING attributes_patch,fields,tier,teams,projects,patch->>'name',patch->>'domain',record_id;
 PERFORM set_config('app.native_entity_write_intent',previous_intent,true);
 state:=application_company_patch_state(record_id,fields);
 IF state IS NULL OR state->>'version' IS DISTINCT FROM updated_version THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('workspaceId',original.workspace_id,'origin',jsonb_build_object('kind','native','moduleKey','native'),'typeKey','company','id',record_id,'version',updated_version);
END $$;
REVOKE ALL ON FUNCTION application_patch_canonical_company(uuid,jsonb,text,jsonb) FROM PUBLIC;
-- A semantic typed company write versions its observable timestamp even when
-- selected values are equal. Bookkeeping without an explicit intent stays exempt.
CREATE FUNCTION application_version_typed_company_patch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE intent jsonb:=nullif(current_setting('app.native_entity_write_intent',true),'')::jsonb;
BEGIN
 IF NEW.kind='company' AND intent->>'workspaceId'=OLD.workspace_id::text AND intent->>'typeKey'='company' AND intent->>'id'=OLD.id::text
  AND jsonb_typeof(intent->'fields')='array' AND jsonb_array_length(intent->'fields') BETWEEN 1 AND 128 AND NEW.scope_version=OLD.scope_version THEN
  NEW.scope_version:=OLD.scope_version+1;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_version_typed_company_patch() FROM PUBLIC;
CREATE TRIGGER zz_application_company_patch_revision BEFORE UPDATE ON public.entities FOR EACH ROW EXECUTE FUNCTION application_version_typed_company_patch();
CREATE FUNCTION application_hold_company_patch_descendants() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.kind='company' AND NEW.scope_version<>OLD.scope_version AND entity_scope_semantic_row(to_jsonb(NEW))=entity_scope_semantic_row(to_jsonb(OLD)) THEN
  PERFORM hold_scope_descendants(NEW.workspace_id,'entity',NEW.id);
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_hold_company_patch_descendants() FROM PUBLIC;
CREATE TRIGGER application_company_patch_descendants AFTER UPDATE ON public.entities FOR EACH ROW EXECUTE FUNCTION application_hold_company_patch_descendants();

DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON FUNCTION application_native_entity_field_writes_before_app_patch(uuid,jsonb,text[]) FROM app_user;
 GRANT EXECUTE ON FUNCTION application_lock_canonical_crm_configuration(uuid),application_native_entity_field_writes_allowed(uuid,jsonb,text[]),application_company_patch_state(uuid,text[]),application_patch_canonical_company(uuid,jsonb,text,jsonb) TO app_user;
END IF;END $$;
COMMIT;
