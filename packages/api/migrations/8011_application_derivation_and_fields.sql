-- Immutable field evidence over canonical records. Runtime qualification stays closed.
-- [COMP:api/application-field-evidence]
BEGIN;

-- Opaque deterministic UUIDv8-shaped identity; the digest is not an authority token.
CREATE FUNCTION application_field_resource_uuid(identity text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $$
 SELECT (substr(identity,1,8)||'-'||substr(identity,9,4)||'-8'||substr(identity,14,3)||'-8'||substr(identity,18,3)||'-'||substr(identity,21,12))::uuid
$$;
REVOKE ALL ON FUNCTION application_field_resource_uuid(text) FROM PUBLIC;

-- One logical field projection survives live row versions; immutable observations
-- retain its exact field/schema/scope/relationship evidence. No business values.
CREATE TABLE application_field_resources (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 origin jsonb NOT NULL CHECK(jsonb_typeof(origin)='object' AND origin->>'kind' IN('generic','native')),
 type_key text NOT NULL CHECK(type_key ~ '^[a-z][a-z0-9_.-]{0,127}$'),
 resource_id uuid NOT NULL,
 selection text NOT NULL CHECK(selection IN('read','query','history','identity')),
 selected_version text CHECK(selected_version IS NULL OR length(selected_version) BETWEEN 1 AND 256),
 fields text[] NOT NULL CHECK(cardinality(fields)<=256 AND array_position(fields,NULL) IS NULL),
 field_identity text NOT NULL CHECK(field_identity ~ '^[a-f0-9]{64}$'),
 identity text NOT NULL CHECK(identity ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((selection='history')=(selected_version IS NOT NULL)),
 CHECK(id=application_field_resource_uuid(identity)),
 UNIQUE(workspace_id,identity),UNIQUE(id,workspace_id)
);
CREATE TABLE application_field_observations (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 resource_id uuid NOT NULL,
 version text NOT NULL CHECK(version ~ '^[a-f0-9]{64}$'),
 record_version text NOT NULL CHECK(length(record_version) BETWEEN 1 AND 256),
 policy_version text NOT NULL CHECK(policy_version ~ '^[a-f0-9]{64}$'),
 source_kind text NOT NULL,
 source_id uuid NOT NULL,
 source_version text NOT NULL CHECK(length(source_version) BETWEEN 1 AND 256),
 source_scope jsonb NOT NULL CHECK(jsonb_typeof(source_scope)='object'
   AND source_scope ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']
   AND source_scope-ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']='{}'::jsonb
   AND source_scope->>'workspaceId'=workspace_id::text AND entity_derivation_envelope_valid(source_scope)),
 owner_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(resource_id,version),
 FOREIGN KEY(resource_id,workspace_id) REFERENCES application_field_resources(id,workspace_id) ON DELETE CASCADE
);
CREATE TABLE application_field_observation_sources (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 resource_id uuid NOT NULL,
 version text NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN('application_field','external_source')),
 source_id uuid NOT NULL,
 source_version text NOT NULL CHECK(length(source_version) BETWEEN 1 AND 256),
 PRIMARY KEY(resource_id,version,source_kind,source_id,source_version),
 FOREIGN KEY(resource_id,version) REFERENCES application_field_observations(resource_id,version) ON DELETE CASCADE,
 FOREIGN KEY(resource_id,workspace_id) REFERENCES application_field_resources(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX application_field_resource_record ON application_field_resources(workspace_id,resource_id);
CREATE INDEX application_field_observation_parent ON application_field_observation_sources(workspace_id,source_kind,source_id);

CREATE FUNCTION guard_application_field_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION guard_application_field_metadata() FROM PUBLIC;
CREATE TRIGGER application_field_resource_immutable BEFORE UPDATE OR DELETE ON application_field_resources
 FOR EACH ROW EXECUTE FUNCTION guard_application_field_metadata();
CREATE TRIGGER application_field_observation_immutable BEFORE UPDATE OR DELETE ON application_field_observations
 FOR EACH ROW EXECUTE FUNCTION guard_application_field_metadata();
CREATE TRIGGER application_field_observation_sources_immutable BEFORE UPDATE OR DELETE ON application_field_observation_sources
 FOR EACH ROW EXECUTE FUNCTION guard_application_field_metadata();
ALTER TABLE application_field_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_field_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_field_observation_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON application_field_resources,application_field_observations,application_field_observation_sources FROM PUBLIC;

-- Generic rows and member references have different physical version columns.
-- Do not add them to scope_source_table, whose generic helpers assume scope_version.
ALTER FUNCTION read_scope_source(uuid,text,uuid) RENAME TO read_scope_source_before_application_fields;
REVOKE ALL ON FUNCTION read_scope_source_before_application_fields(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_scope_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 IF k='entity_instance' THEN
  SELECT jsonb_build_object('workspaceId',r.workspace_id,'userId',NULL,'assistantId',NULL,
   'sensitivity',r.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids,
   'version',r.record_version::text,'held',scope_review_state_held(k,i),'validTo',NULL,'retractedAt',NULL)
   INTO result FROM entity_instances r WHERE r.workspace_id=w AND r.id=i FOR SHARE;
  RETURN result;
 ELSIF k='workspace_member' THEN
  SELECT jsonb_build_object('workspaceId',m.workspace_id,'userId',NULL,'assistantId',NULL,
   'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb,
   'version',md5(to_jsonb(m)::text),'held',scope_review_state_held(k,i),'validTo',NULL,'retractedAt',NULL)
   INTO result FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=i FOR SHARE;
  RETURN result;
 ELSIF k='application_field' THEN
  RETURN application_current_field_snapshot(w,i);
 END IF;
 RETURN read_scope_source_before_application_fields(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_scope_source(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION application_admitted_native_metadata(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid; result jsonb;
BEGIN
 IF actor IS NULL OR k NOT IN('entity_instance','workspace_member')
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor
  OR acting IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM assistants a WHERE a.workspace_id=w AND a.id=acting)
   OR assistant_placement_visible(actor,acting) IS NOT TRUE) THEN RETURN NULL; END IF;
 result:=read_scope_source(w,k,i);
 IF result IS NULL OR result->>'held' IS DISTINCT FROM 'false'
  OR agent_visibility_allows(w,(result->>'userId')::uuid,(result->>'assistantId')::uuid) IS NOT TRUE
  OR workflow_evidence_envelope_visible(w,result) IS NOT TRUE THEN RETURN NULL; END IF;
 RETURN result;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_admitted_native_metadata(uuid,text,uuid) FROM PUBLIC;

ALTER FUNCTION read_entity_derivation_source(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_application_fields;
REVOKE ALL ON FUNCTION read_entity_derivation_source_before_application_fields(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF k IN('entity_instance','workspace_member') THEN RETURN application_admitted_native_metadata(w,k,i); END IF;
 IF k='application_field' THEN RETURN application_current_field_snapshot(w,i); END IF;
 RETURN read_entity_derivation_source_before_application_fields(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_entity_derivation_source(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION application_field_digest(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION application_field_digest(jsonb) FROM PUBLIC;

-- Internal canonical projection, never a raw app-role content API. Every value
-- is selected under the actual member/app authority before observation capture.
CREATE FUNCTION application_field_projection_state(w uuid,p_origin jsonb,p_type text,p_id uuid,
 p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE context jsonb; origin_kind text:=p_origin->>'kind'; action text;
 kind text; native_row jsonb; projected jsonb; scope jsonb; values_json jsonb;
 metadata jsonb; identity_metadata jsonb; property jsonb; custom record; cell jsonb;
 generic_type uuid; version text; owner uuid; reference jsonb; candidate record;
BEGIN
 IF p_selection NOT IN('read','query','history','identity') OR p_fields IS NULL
  OR cardinality(p_fields)>256 OR array_position(p_fields,NULL) IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(p_fields) field WHERE length(field) NOT BETWEEN 1 AND 256)
  OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_fields) field)
  OR (p_selection='history') IS DISTINCT FROM (p_selected_version IS NOT NULL) THEN RETURN NULL; END IF;
 action:=CASE p_selection WHEN 'identity' THEN 'read' ELSE p_selection END;
 context:=application_current_maxima();
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL AND context IS NULL THEN RETURN NULL; END IF;
 IF context IS NOT NULL AND context->>'workspaceId' IS DISTINCT FROM w::text THEN RETURN NULL; END IF;
 IF origin_kind='generic' AND p_origin-ARRAY['kind','entityTypeId']='{}'::jsonb THEN
  generic_type:=(p_origin->>'entityTypeId')::uuid;kind:='entity_instance';p_type:='record.'||generic_type;
  SELECT to_jsonb(r) INTO native_row FROM entity_instances r WHERE r.workspace_id=w AND r.entity_type_id=generic_type AND r.id=p_id;
  IF native_row IS NULL OR scope_review_state_held(kind,p_id) THEN RETURN NULL; END IF;
  owner:=(native_row->>'created_by')::uuid;
  SELECT coalesce(jsonb_agg(p ORDER BY p->>'name'),'[]'::jsonb) INTO metadata
   FROM entity_types t,LATERAL jsonb_array_elements(t.properties) p WHERE t.id=generic_type AND t.workspace_id=w AND p->>'name'=ANY(p_fields);
  IF jsonb_array_length(metadata)<>cardinality(p_fields) THEN RETURN NULL; END IF;
  IF context IS NOT NULL THEN
   -- Canonical generic identity is reader independent. Each app resolves an
   -- actually admitted catalog alias from its own current maxima, never the
   -- original reader's app/grant/type alias.
   FOR candidate IN SELECT DISTINCT m->'grants'->0->>'typeKey' AS type_key
    FROM jsonb_array_elements(context->'layers') layer,LATERAL jsonb_array_elements(layer->'maxima') m
    WHERE m->'grants'->0->'origin'=p_origin ORDER BY type_key LOOP
    BEGIN
     IF p_selection='history' THEN
      SELECT to_jsonb(p) INTO projected FROM application_generic_history(generic_type,candidate.type_key,p_id,p_selected_version::bigint+1,1) p
       WHERE p.record_version::text=p_selected_version;
     ELSE
      SELECT to_jsonb(p) INTO projected FROM application_generic_projection(generic_type,candidate.type_key,action,p_id,p_fields) p;
     END IF;
    EXCEPTION WHEN insufficient_privilege THEN projected:=NULL;
    END;
    EXIT WHEN projected IS NOT NULL;
   END LOOP;
   IF projected IS NULL THEN RETURN NULL; END IF;
   values_json:=projected->'data';scope:=(projected->'source')||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);version:=projected->>'record_version';
  ELSE
   scope:=read_admitted_native_scope_snapshot(w,kind,p_id);
   IF scope IS NULL OR scope->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL; END IF;
   version:=native_row->>'record_version';values_json:=native_row->'data';
   IF p_selection='history' THEN
    SELECT to_jsonb(h) INTO projected FROM application_record_revisions h
     WHERE h.workspace_id=w AND h.entity_instance_id=p_id AND h.record_version::text=p_selected_version;
    IF projected IS NULL THEN RETURN NULL; END IF;
    scope:=scope||jsonb_build_object('sensitivity',projected->'sensitivity','compartments',projected->'compartments','projectIds',projected->'project_ids');
    IF workflow_evidence_envelope_visible(w,scope) IS NOT TRUE THEN RETURN NULL; END IF;
    values_json:=projected->'data';version:=p_selected_version;
   ELSE
    -- Materialized system cells use the canonical row metadata, never user data.
    FOR property IN SELECT value FROM jsonb_array_elements(metadata) LOOP
     cell:=NULL;
     CASE property->'config'->>'kind'
      WHEN 'created_time' THEN cell:=native_row->'created_at';
      WHEN 'last_edited_time' THEN cell:=native_row->'last_edited_at';
      WHEN 'created_by' THEN cell:=coalesce(native_row->'created_by','null'::jsonb);
      WHEN 'last_edited_by' THEN cell:=coalesce(native_row->'last_edited_by','null'::jsonb);
      ELSE NULL;
     END CASE;
     IF cell IS NOT NULL THEN values_json:=values_json||jsonb_build_object(property->>'name',jsonb_build_object('kind',property->'config'->>'kind','value',cell)); END IF;
    END LOOP;
   END IF;
  END IF;
  -- Display labels can change without replacing a canonical field identity.
  SELECT coalesce(jsonb_agg(jsonb_build_object('key',p->'name','kind',p#>'{config,kind}','target',p#>'{config,targetEntityTypeRef}') ORDER BY p->>'name'),'[]')
   INTO identity_metadata FROM jsonb_array_elements(metadata) p;
 ELSIF p_origin=jsonb_build_object('kind','native','moduleKey','native') AND p_type IN('company','person','deal','task','file','workspace_member') THEN
  IF p_selection='history' THEN RETURN NULL; END IF;
  kind:=CASE p_type WHEN 'task' THEN 'task' WHEN 'file' THEN 'workspace_file' WHEN 'workspace_member' THEN 'workspace_member' ELSE 'entity' END;
  IF context IS NOT NULL THEN
   projected:=application_native_projection(p_type,p_id,action,p_fields);
   IF projected IS NULL THEN RETURN NULL; END IF;
   values_json:=projected->'values';scope:=projected->'source';version:=scope->>'version';
  ELSE
   scope:=read_admitted_native_scope_snapshot(w,kind,p_id);
   IF scope IS NULL OR scope->>'held' IS DISTINCT FROM 'false' OR scope->>'validTo' IS NOT NULL OR scope->>'retractedAt' IS NOT NULL THEN RETURN NULL; END IF;
   IF p_type='workspace_member' THEN
    native_row:=jsonb_build_object('id',p_id);values_json:=native_row;
   ELSIF p_type='file' THEN
    SELECT to_jsonb(f) INTO native_row FROM workspace_files f WHERE f.workspace_id=w AND f.id=p_id;
    values_json:=jsonb_build_object('name',native_row->'name','mimeType',native_row->'mime','sizeBytes',native_row->'size_bytes','storageRef',native_row->'storage_uri');
   ELSIF p_type='task' THEN
    SELECT to_jsonb(t) INTO native_row FROM tasks t WHERE t.workspace_id=w AND t.id=p_id;
    values_json:=jsonb_build_object('title',native_row->'title','status',native_row->'status');
   ELSE
    SELECT to_jsonb(e) INTO native_row FROM entities e WHERE e.workspace_id=w AND e.id=p_id AND e.kind=p_type;
    values_json:=CASE p_type WHEN 'company' THEN jsonb_build_object('name',native_row->'display_name','domain',native_row#>'{attributes,domain}')
     WHEN 'person' THEN jsonb_build_object('name',native_row->'display_name','email',native_row#>'{attributes,email}','phone',native_row#>'{attributes,phone}')
     ELSE jsonb_build_object('name',native_row->'display_name','stage',native_row#>'{attributes,stage}','amount',native_row#>'{attributes,amount}') END;
    FOR custom IN SELECT f.* FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type
     AND f.archived_at IS NULL AND 'custom.'||f.field_key=ANY(p_fields) LOOP
     values_json:=values_json||jsonb_build_object('custom.'||custom.field_key,coalesce(native_row->'attributes'->'custom_fields'->custom.field_key,'null'::jsonb));
    END LOOP;
   END IF;
   IF native_row IS NULL THEN RETURN NULL; END IF;
   version:=scope->>'version';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('key',field,'kind','builtin','version',1) ORDER BY field),'[]') INTO metadata
   FROM unnest(p_fields) field WHERE NOT starts_with(field,'custom.');
  SELECT metadata||coalesce(jsonb_agg(to_jsonb(f)-ARRAY['label','position','created_at','updated_at'] ORDER BY f.field_key),'[]') INTO metadata
   FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL AND 'custom.'||f.field_key=ANY(p_fields);
  SELECT coalesce(jsonb_agg(CASE WHEN p ? 'field_key' THEN jsonb_build_object('id',p->'id','key',p->'field_key','kind',p->'field_type') ELSE p END
   ORDER BY coalesce(p->>'key',p->>'field_key')),'[]') INTO identity_metadata FROM jsonb_array_elements(metadata) p;
  IF native_row IS NULL THEN
   IF p_type='task' THEN SELECT to_jsonb(t) INTO native_row FROM tasks t WHERE t.workspace_id=w AND t.id=p_id;
   ELSIF p_type IN('company','person','deal') THEN SELECT to_jsonb(e) INTO native_row FROM entities e WHERE e.workspace_id=w AND e.id=p_id AND e.kind=p_type; END IF;
  END IF;
  owner:=(native_row->>'created_by_user_id')::uuid;
 ELSE RETURN NULL;
 END IF;
 IF scope IS NULL OR scope->>'workspaceId' IS DISTINCT FROM w::text OR scope->>'held' IS DISTINCT FROM 'false'
  OR version IS NULL OR NOT to_jsonb(p_fields)<@coalesce((SELECT jsonb_agg(key) FROM jsonb_object_keys(values_json) key),'[]') THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO values_json FROM jsonb_each(values_json) WHERE key=ANY(p_fields);
 -- Reference discovery/admission uses original returned values, never a later
 -- target selected from changed business data. Only opaque canonical refs persist.
 FOR reference IN SELECT value FROM jsonb_array_elements(application_field_references(w,p_origin,p_type,values_json)) LOOP
  IF application_field_reference_admitted(w,reference) IS NOT TRUE THEN RETURN NULL; END IF;
 END LOOP;
 RETURN jsonb_build_object('values',values_json,'source',scope,'recordVersion',version,'sourceKind',kind,'sourceId',p_id,
  'sourceVersion',CASE WHEN p_selection='history' THEN p_selected_version ELSE scope->>'version' END,'ownerId',owner,
  'fieldIdentity',application_field_digest(jsonb_build_object('origin',p_origin,'type',p_type,'fields',identity_metadata)),
  'policyVersion',application_field_digest(metadata),'references',application_field_references(w,p_origin,p_type,values_json));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR datetime_field_overflow OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;

-- Internal metadata descriptors, derived from an already admitted projection.
CREATE FUNCTION application_field_references(w uuid,p_origin jsonb,p_type text,p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb:='[]'; property jsonb; cell jsonb; item jsonb; target_origin jsonb; target_type text; target_id uuid;
 file_row workspace_files; custom record;
BEGIN
 IF p_origin->>'kind'='generic' THEN
  FOR property IN SELECT p FROM entity_types t,LATERAL jsonb_array_elements(t.properties) p
   WHERE t.workspace_id=w AND t.id=(p_origin->>'entityTypeId')::uuid AND p_values ? (p->>'name') LOOP
   cell:=p_values->(property->>'name');
   IF cell->'value' IS NULL OR cell->'value'='null'::jsonb THEN CONTINUE; END IF;
   IF property->'config'->>'kind'='files' THEN
    IF jsonb_typeof(cell->'value')<>'array' THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
    FOR item IN SELECT jsonb_array_elements(cell->'value') LOOP
     SELECT * INTO file_row FROM workspace_files f WHERE f.workspace_id=w AND f.storage_uri='gs://'||(item->>'bucket')||'/'||(item->>'path');
     IF NOT FOUND OR item->>'name' IS DISTINCT FROM file_row.name OR item->>'mimeType' IS DISTINCT FROM file_row.mime
      OR (item->>'sizeBytes')::numeric IS DISTINCT FROM file_row.size_bytes THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
     result:=result||jsonb_build_array(jsonb_build_object('origin',jsonb_build_object('kind','native','moduleKey','native'),
      'typeKey','file','id',file_row.id,'fields',ARRAY['mimeType','name','sizeBytes','storageRef']));
    END LOOP;
    CONTINUE;
   ELSIF property->'config'->>'kind' IN('person','created_by','last_edited_by') THEN
    target_origin:=jsonb_build_object('kind','native','moduleKey','native');target_type:='workspace_member';target_id:=(cell->>'value')::uuid;
   ELSIF property->'config'->>'kind'='relation' THEN
    target_id:=(cell->>'value')::uuid;
    IF property->'config'->'targetEntityTypeRef'->>'kind'='user_defined' THEN
     target_origin:=jsonb_build_object('kind','generic','entityTypeId',property->'config'->'targetEntityTypeRef'->>'entityTypeId');
     target_type:='record.'||(property->'config'->'targetEntityTypeRef'->>'entityTypeId');
    ELSIF property->'config'->'targetEntityTypeRef'->>'kind'='builtin'
     AND property->'config'->'targetEntityTypeRef'->>'name' IN('company','contact','deal','task') THEN
     target_origin:=jsonb_build_object('kind','native','moduleKey','native');target_type:=property->'config'->'targetEntityTypeRef'->>'name';
     IF target_type='contact' THEN target_type:='person'; END IF;
    ELSE RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
   ELSE CONTINUE;
   END IF;
   result:=result||jsonb_build_array(jsonb_build_object('origin',target_origin,'typeKey',target_type,'id',target_id,'fields','[]'::jsonb));
  END LOOP;
 ELSIF p_origin=jsonb_build_object('kind','native','moduleKey','native') AND p_type IN('company','person','deal') THEN
  FOR custom IN SELECT f.* FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type
   AND f.archived_at IS NULL AND f.field_type='entity_reference' AND p_values ? ('custom.'||f.field_key) LOOP
   cell:=p_values->('custom.'||custom.field_key);
   IF cell='null'::jsonb THEN CONTINUE; END IF;
   target_id:=(cell#>>'{}')::uuid;
   SELECT e.kind INTO target_type FROM entities e WHERE e.workspace_id=w AND e.id=target_id;
   IF target_type IS NULL OR NOT custom.options ? target_type THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
   result:=result||jsonb_build_array(jsonb_build_object('origin',jsonb_build_object('kind','native','moduleKey','native'),
    'typeKey',target_type,'id',target_id,'fields','[]'::jsonb));
  END LOOP;
 END IF;
 IF jsonb_array_length(result)>256 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') FROM (SELECT DISTINCT value FROM jsonb_array_elements(result)) refs);
END $$;
REVOKE ALL ON FUNCTION application_field_references(uuid,jsonb,text,jsonb) FROM PUBLIC;

CREATE FUNCTION application_field_reference_admitted(w uuid,reference jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE context jsonb; state jsonb; fields text[];
BEGIN
 IF reference IS NULL OR jsonb_typeof(reference)<>'object' OR NOT reference ?& ARRAY['origin','typeKey','id','fields']
  OR reference-ARRAY['origin','typeKey','id','fields']<>'{}'::jsonb OR jsonb_typeof(reference->'fields')<>'array' THEN RETURN false; END IF;
 fields:=ARRAY(SELECT jsonb_array_elements_text(reference->'fields'));
 context:=application_current_maxima();
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL AND context IS NULL THEN RETURN false; END IF;
 IF context IS NOT NULL THEN
  RETURN context->>'workspaceId'=w::text AND application_reference_allows(w,reference->'origin',reference->>'typeKey',(reference->>'id')::uuid,fields);
 END IF;
 -- Identity/file selections have no relation values, so this cannot follow a
 -- user-authored arbitrary relation graph or recursively evaluate a business field.
 state:=application_field_projection_state(w,reference->'origin',reference->>'typeKey',(reference->>'id')::uuid,'identity',NULL,fields);
 RETURN state IS NOT NULL;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_field_reference_admitted(uuid,jsonb) FROM PUBLIC;

-- Readonly current metadata computation. It never inserts an observation in an
-- access predicate; capture materializes this exact state after version checks.
CREATE FUNCTION application_compute_field_envelope(w uuid,p_origin jsonb,p_type text,p_id uuid,
 p_selection text,p_selected_version text,p_fields text[],depth integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE state jsonb; field_keys text[]; identity text; resource uuid; scope jsonb; version text;
 reference jsonb; child jsonb; children jsonb:='[]'; sources jsonb:='[]'; native_source jsonb; external record;
BEGIN
 IF depth NOT BETWEEN 0 AND 2 THEN RETURN NULL; END IF;
 IF p_origin->>'kind'='generic' THEN p_type:='record.'||(p_origin->>'entityTypeId')::uuid; END IF;
 field_keys:=ARRAY(SELECT DISTINCT field FROM unnest(p_fields) field ORDER BY field);
 IF p_fields IS NULL OR cardinality(field_keys) IS DISTINCT FROM cardinality(p_fields) THEN RETURN NULL; END IF;
 state:=application_field_projection_state(w,p_origin,p_type,p_id,p_selection,p_selected_version,field_keys);
 IF state IS NULL THEN RETURN NULL; END IF;
 scope:=jsonb_build_object('workspaceId',w,'userId',state#>'{source,userId}','assistantId',state#>'{source,assistantId}',
  'sensitivity',state#>'{source,sensitivity}','compartments',state#>'{source,compartments}','projectIds',state#>'{source,projectIds}');
 IF entity_derivation_envelope_valid(scope) IS NOT TRUE THEN RETURN NULL; END IF;
 identity:=application_field_digest(jsonb_build_object('workspaceId',w,'origin',p_origin,'typeKey',p_type,'id',p_id,
  'selection',p_selection,'selectedVersion',p_selected_version,'fields',field_keys,'fieldIdentity',state->'fieldIdentity'));
 resource:=application_field_resource_uuid(identity);
 FOR reference IN SELECT value FROM jsonb_array_elements(state->'references') ORDER BY value::text LOOP
  child:=application_compute_field_envelope(w,reference->'origin',reference->>'typeKey',(reference->>'id')::uuid,
   'identity',NULL,ARRAY(SELECT jsonb_array_elements_text(reference->'fields')),depth+1);
  IF child IS NULL THEN RETURN NULL; END IF;
  children:=children||jsonb_build_array(child);
  sources:=sources||jsonb_build_array(child->'source')||coalesce(child->'sources','[]'::jsonb);
  IF jsonb_array_length(sources)>=4096 THEN RETURN NULL; END IF;
 END LOOP;
 -- Preserve immutable external obligations independently of later native cleanup.
 -- This discovery is metadata only. Capture and every payload boundary must pin
 -- actual current source receipts; metadata discovery is never authorization.
 FOR external IN SELECT * FROM read_external_source_dependencies(w,ARRAY[state->>'sourceKind'],ARRAY[p_id],ARRAY[state->>'sourceVersion']) LOOP
  IF external.source IS NULL OR external.source->>'workspaceId' IS DISTINCT FROM w::text
   OR external.node_version IS DISTINCT FROM external.source->>'version' THEN RETURN NULL; END IF;
  sources:=sources||jsonb_build_array(external.source);
  IF jsonb_array_length(sources)>=4096 THEN RETURN NULL; END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO sources
  FROM (SELECT DISTINCT value FROM jsonb_array_elements(sources)) unique_sources;
 version:=application_field_digest(jsonb_build_object('resourceId',resource,'recordVersion',state->'recordVersion',
  'sourceVersion',state->'sourceVersion','policyVersion',state->'policyVersion','scope',scope,'sources',sources));
 RETURN jsonb_build_object('resourceId',resource,'identity',identity,'origin',p_origin,'typeKey',p_type,'id',p_id,
  'selection',p_selection,'selectedVersion',p_selected_version,'fields',field_keys,'fieldIdentity',state->'fieldIdentity',
  'state',state,'children',children,'sources',sources,
  'source',scope||jsonb_build_object('resourceKind','application_field','resourceId',resource,'version',version));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer) FROM PUBLIC;

CREATE FUNCTION application_current_field_snapshot(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE resource application_field_resources; current jsonb;
BEGIN
 SELECT * INTO resource FROM application_field_resources f WHERE f.workspace_id=w AND f.id=i;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF scope_review_state_held('application_field',i) THEN RETURN '{"held":true}'::jsonb; END IF;
 current:=application_compute_field_envelope(w,resource.origin,resource.type_key,resource.resource_id,
  resource.selection,resource.selected_version,resource.fields);
 IF current IS NULL OR current->>'resourceId' IS DISTINCT FROM i::text
  OR current->>'identity' IS DISTINCT FROM resource.identity THEN RETURN '{"held":true}'::jsonb; END IF;
 RETURN current->'source'||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);
END $$;
REVOKE ALL ON FUNCTION application_current_field_snapshot(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION application_materialize_field_envelope(w uuid,envelope jsonb,depth integer DEFAULT 0) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE child jsonb; source jsonb; resource application_field_resources; observation application_field_observations;
 resource_id_value uuid:=(envelope->>'resourceId')::uuid; v text:=envelope#>>'{source,version}'; field_keys text[];
BEGIN
 IF depth NOT BETWEEN 0 AND 2 OR envelope#>>'{source,workspaceId}' IS DISTINCT FROM w::text THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
 FOR child IN SELECT value FROM jsonb_array_elements(envelope->'children') ORDER BY value->>'resourceId' LOOP
  PERFORM application_materialize_field_envelope(w,child,depth+1);
 END LOOP;
 field_keys:=ARRAY(SELECT jsonb_array_elements_text(envelope->'fields'));
 INSERT INTO application_field_resources(id,workspace_id,origin,type_key,resource_id,selection,selected_version,fields,field_identity,identity)
  VALUES(resource_id_value,w,envelope->'origin',envelope->>'typeKey',(envelope->>'id')::uuid,envelope->>'selection',envelope->>'selectedVersion',
   field_keys,envelope->>'fieldIdentity',envelope->>'identity') ON CONFLICT DO NOTHING;
 SELECT * INTO resource FROM application_field_resources r WHERE r.workspace_id=w AND r.id=resource_id_value;
 IF NOT FOUND OR (resource.origin,resource.type_key,resource.resource_id,resource.selection,resource.selected_version,resource.fields,resource.field_identity,resource.identity)
  IS DISTINCT FROM (envelope->'origin',envelope->>'typeKey',(envelope->>'id')::uuid,envelope->>'selection',envelope->>'selectedVersion',field_keys,envelope->>'fieldIdentity',envelope->>'identity') THEN
  RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023'; END IF;
 source:=(envelope->'source')-ARRAY['resourceKind','resourceId','version'];
 INSERT INTO application_field_observations(workspace_id,resource_id,version,record_version,policy_version,source_kind,source_id,source_version,source_scope,owner_id)
  VALUES(w,resource_id_value,v,envelope#>>'{state,recordVersion}',envelope#>>'{state,policyVersion}',envelope#>>'{state,sourceKind}',
   (envelope#>>'{state,sourceId}')::uuid,envelope#>>'{state,sourceVersion}',source,(envelope#>>'{state,ownerId}')::uuid)
  ON CONFLICT DO NOTHING;
 SELECT * INTO observation FROM application_field_observations o WHERE o.workspace_id=w AND o.resource_id=resource_id_value AND o.version=v;
 IF NOT FOUND OR (observation.record_version,observation.policy_version,observation.source_kind,observation.source_id,observation.source_version,observation.source_scope,observation.owner_id)
  IS DISTINCT FROM (envelope#>>'{state,recordVersion}',envelope#>>'{state,policyVersion}',envelope#>>'{state,sourceKind}',
   (envelope#>>'{state,sourceId}')::uuid,envelope#>>'{state,sourceVersion}',source,(envelope#>>'{state,ownerId}')::uuid) THEN
  RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023'; END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(envelope->'sources') ORDER BY value->>'resourceKind',value->>'resourceId',value->>'version' LOOP
  IF source->>'workspaceId' IS DISTINCT FROM w::text OR source->>'resourceKind' NOT IN('application_field','external_source') THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
  INSERT INTO application_field_observation_sources(workspace_id,resource_id,version,source_kind,source_id,source_version)
   VALUES(w,resource_id_value,v,source->>'resourceKind',(source->>'resourceId')::uuid,source->>'version') ON CONFLICT DO NOTHING;
 END LOOP;
 IF (SELECT count(*) FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=resource_id_value AND s.version=v)
  IS DISTINCT FROM jsonb_array_length(envelope->'sources') THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023'; END IF;
END $$;
REVOKE ALL ON FUNCTION application_materialize_field_envelope(uuid,jsonb,integer) FROM PUBLIC;

-- The app-role capture port returns only freshly admitted selected values and
-- metadata. It cannot register a callback, accept caller evidence or widen fields.
CREATE FUNCTION observe_application_field_projection(w uuid,p_origin jsonb,p_type text,p_id uuid,p_record_version text,
 p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE envelope jsonb; snapshot jsonb; source jsonb; external jsonb; sources jsonb;
BEGIN
 envelope:=application_compute_field_envelope(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);
 IF envelope IS NULL OR envelope#>>'{state,recordVersion}' IS DISTINCT FROM p_record_version THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(envelope->'sources') WHERE value->>'resourceKind'='external_source' LOOP
  external:=external_source_snapshot(w,(source->>'resourceId')::uuid);
  IF external IS NULL OR external->>'held' IS DISTINCT FROM 'false' OR external->>'version' IS DISTINCT FROM source->>'version'
   OR NOT EXISTS(SELECT 1 FROM external_source_observations o WHERE o.workspace_id=w AND o.id=(source->>'resourceId')::uuid
    AND o.observation#>>'{retention,mode}'='governed') THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 END LOOP;
 PERFORM application_materialize_field_envelope(w,envelope);
 snapshot:=application_current_field_snapshot(w,(envelope->>'resourceId')::uuid);
 IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false' OR snapshot->>'version' IS DISTINCT FROM envelope#>>'{source,version}' THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 sources:=jsonb_build_array(envelope->'source')||(envelope->'sources');
 RETURN jsonb_build_object('values',envelope#>'{state,values}','sources',sources,'policyVersion',envelope#>'{state,policyVersion}');
END $$;
REVOKE ALL ON FUNCTION observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[]) FROM PUBLIC;

-- Shared metadata traversal. A known field observation is immutable, while
-- native derivations retain all historical obligations on a canonical ID.
CREATE FUNCTION application_scope_source_edges(w uuid,k text,i uuid,v text)
RETURNS TABLE(kind text,id uuid,version text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
  JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
  WHERE d.workspace_id=w AND d.resource_kind=k AND d.resource_id=i
 UNION
 SELECT k,prior_id,v FROM unnest(CASE WHEN scope_source_table(k) IS NOT NULL
  THEN ARRAY(SELECT resource_id FROM scope_source_ancestors(w,k,i)) ELSE '{}'::uuid[] END) prior_id WHERE prior_id<>i
 UNION
 SELECT o.source_kind,o.source_id,o.source_version FROM application_field_observations o
  WHERE k='application_field' AND o.workspace_id=w AND o.resource_id=i AND o.version=v
 UNION
 SELECT s.source_kind,s.source_id,s.source_version FROM application_field_observation_sources s
  WHERE k='application_field' AND s.workspace_id=w AND s.resource_id=i AND s.version=v
 UNION
 SELECT 'workspace_file',wf.id,wf.scope_version::text FROM file_segments fs
  JOIN workspace_files wf ON wf.id=fs.file_id AND wf.workspace_id=fs.workspace_id
  WHERE k='file_segment' AND fs.workspace_id=w AND fs.id=i
 UNION
 SELECT observed.value->>'resourceKind',(observed.value->>'resourceId')::uuid,observed.value->>'version'
  FROM jsonb_array_elements(CASE WHEN k='workflow_run' THEN read_workflow_derivation_inputs(w,i) ELSE '[]'::jsonb END) input
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(input#>'{evidence,sources}','[]'::jsonb)
   ||CASE WHEN jsonb_typeof(input->'blueprintSource')='object' THEN jsonb_build_array(input->'blueprintSource') ELSE '[]'::jsonb END) observed(value)
$$;
REVOKE ALL ON FUNCTION application_scope_source_edges(uuid,text,uuid,text) FROM PUBLIC;

CREATE FUNCTION application_scope_lineage(w uuid,kinds text[],ids uuid[],versions text[])
RETURNS TABLE(kind text,id uuid,version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE nodes jsonb;
BEGIN
 IF kinds IS NULL OR ids IS NULL OR versions IS NULL
  OR cardinality(kinds) IS DISTINCT FROM cardinality(ids) OR cardinality(ids) IS DISTINCT FROM cardinality(versions)
  OR cardinality(ids) NOT BETWEEN 1 AND 100 OR array_position(kinds,NULL) IS NOT NULL
  OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
 WITH RECURSIVE lineage(kind,id,version) AS (
  SELECT * FROM unnest(kinds,ids,versions)
  UNION
  SELECT next.kind,next.id,next.version FROM lineage l
   CROSS JOIN LATERAL application_scope_source_edges(w,l.kind,l.id,l.version) next
 ), bounded AS MATERIALIZED(SELECT * FROM lineage LIMIT 4097)
 SELECT coalesce(jsonb_agg(to_jsonb(b)),'[]') INTO nodes FROM bounded b;
 -- UNION terminates native high-water back-edges (including a row edited from
 -- its earlier version). New field-child graphs are separately depth bounded
 -- by capture and the admitted reader; no app role may author metadata edges.
 IF jsonb_array_length(nodes)>4096 OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n
  WHERE n->>'version' IS NULL OR n->>'kind' IS NULL OR n->>'id' IS NULL
   OR n->>'kind'='application_field' AND NOT EXISTS(SELECT 1 FROM application_field_observations o
    WHERE o.workspace_id=w AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version')) THEN
  RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023'; END IF;
 RETURN QUERY SELECT DISTINCT n->>'kind',(n->>'id')::uuid,n->>'version' FROM jsonb_array_elements(nodes) n;
END $$;
REVOKE ALL ON FUNCTION application_scope_lineage(uuid,text[],uuid[],text[]) FROM PUBLIC;

CREATE OR REPLACE FUNCTION read_external_source_dependencies(w uuid,kinds text[],ids uuid[],versions text[])
RETURNS TABLE(node_version text,source jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT l.version,CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object(
  'workspaceId',o.workspace_id,'userId',NULL,'assistantId',NULL,'resourceKind','external_source','resourceId',o.id,'version',o.version,
  'sensitivity',o.sensitivity,'compartments',o.compartments,'projectIds',o.project_ids) END
 FROM application_scope_lineage(w,kinds,ids,versions) l
 LEFT JOIN external_source_observations o ON o.workspace_id=w AND o.id=l.id WHERE l.kind='external_source'
$$;
REVOKE ALL ON FUNCTION read_external_source_dependencies(uuid,text[],uuid[],text[]) FROM PUBLIC;

CREATE FUNCTION read_application_field_dependencies(w uuid,kinds text[],ids uuid[],versions text[])
RETURNS TABLE(node_version text,source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF kinds IS NULL OR ids IS NULL OR versions IS NULL
  OR cardinality(kinds) IS DISTINCT FROM cardinality(ids) OR cardinality(ids) IS DISTINCT FROM cardinality(versions)
  OR cardinality(ids) NOT BETWEEN 1 AND 100 OR array_position(kinds,NULL) IS NOT NULL
  OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
 -- Native roots can acquire field ancestry only through durable lineage edges.
 -- This indexed empty check avoids rewalking every legacy native source in an
 -- installation/workspace that has never produced a field-backed derivative.
 IF NOT 'application_field'=ANY(kinds) AND NOT EXISTS(SELECT 1 FROM scope_derivation_sources s
  WHERE s.workspace_id=w AND s.source_kind='application_field') THEN RETURN; END IF;
 RETURN QUERY SELECT l.version,o.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',o.resource_id,'version',o.version)
 FROM application_scope_lineage(w,kinds,ids,versions) l
 LEFT JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=l.id AND o.version=l.version
 WHERE l.kind='application_field';
END $$;
REVOKE ALL ON FUNCTION read_application_field_dependencies(uuid,text[],uuid[],text[]) FROM PUBLIC;

-- Recorded observations never acquire native missing-row permission. A live
-- content edit may pass D1 only when current fields, policy and every original
-- relationship target are still admitted. Exact writers use the current reader.
CREATE FUNCTION application_recorded_field_state(w uuid,i uuid,v text,depth integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE resource application_field_resources; observation application_field_observations;
 current jsonb; dependency record; admitted jsonb;
BEGIN
 IF depth NOT BETWEEN 0 AND 3 THEN RETURN '{"held":true}'::jsonb; END IF;
 SELECT * INTO resource FROM application_field_resources r WHERE r.workspace_id=w AND r.id=i;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO observation FROM application_field_observations o WHERE o.workspace_id=w AND o.resource_id=i AND o.version=v;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF scope_review_state_held('application_field',i) THEN RETURN '{"held":true}'::jsonb; END IF;
 current:=application_compute_field_envelope(w,resource.origin,resource.type_key,resource.resource_id,
  resource.selection,resource.selected_version,resource.fields);
 IF current IS NULL OR current->>'identity' IS DISTINCT FROM resource.identity
  OR current#>>'{state,policyVersion}' IS DISTINCT FROM observation.policy_version THEN RETURN '{"held":true}'::jsonb; END IF;
 FOR dependency IN SELECT * FROM application_field_observation_sources s
  WHERE s.workspace_id=w AND s.resource_id=i AND s.version=v ORDER BY s.source_kind,s.source_id,s.source_version LOOP
  IF dependency.source_kind='application_field' THEN
   admitted:=application_recorded_field_state(w,dependency.source_id,dependency.source_version,depth+1);
  ELSE admitted:=external_source_snapshot(w,dependency.source_id);
  END IF;
  IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false'
   OR dependency.source_kind='external_source' AND admitted->>'version' IS DISTINCT FROM dependency.source_version THEN
   RETURN '{"held":true}'::jsonb; END IF;
 END LOOP;
 RETURN current->'source'||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);
END $$;
REVOKE ALL ON FUNCTION application_recorded_field_state(uuid,uuid,text,integer) FROM PUBLIC;
CREATE FUNCTION read_admitted_application_field_snapshot(w uuid,i uuid,v text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT application_recorded_field_state(w,i,v,0)
$$;
REVOKE ALL ON FUNCTION read_admitted_application_field_snapshot(uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION read_admitted_application_field_dependencies(w uuid,kinds text[],ids uuid[],versions text[])
RETURNS TABLE(node_version text,source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE dependency record; admitted jsonb; collected jsonb:='[]';
BEGIN
 FOR dependency IN SELECT * FROM read_application_field_dependencies(w,kinds,ids,versions) LOOP
  admitted:=read_admitted_application_field_snapshot(w,(dependency.source->>'resourceId')::uuid,dependency.node_version);
  IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' THEN
   RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501'; END IF;
  collected:=collected||jsonb_build_array(jsonb_build_object('nodeVersion',dependency.node_version,'source',dependency.source));
 END LOOP;
 RETURN QUERY SELECT value->>'nodeVersion',value->'source' FROM jsonb_array_elements(collected);
END $$;
REVOKE ALL ON FUNCTION read_admitted_application_field_dependencies(uuid,text[],uuid[],text[]) FROM PUBLIC;

-- The shared walk includes original fields' page ancestry as well. There is no
-- new field path around the existing restrictive page readers/output barrier.
CREATE OR REPLACE FUNCTION read_resource_page_dependencies(w uuid,k text,i uuid,v text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE node record; snapshot jsonb; result jsonb:='[]';
BEGIN
 FOR node IN SELECT * FROM application_scope_lineage(w,ARRAY[k],ARRAY[i],ARRAY[v])
  WHERE kind IN('page_event_changed','page_event_destination','page_live_changed','page_live_destination') LOOP
  snapshot:=page_scope_source_snapshot(w,node.kind,node.id);
  IF snapshot IS NULL OR snapshot->>'version' IS DISTINCT FROM node.version THEN RAISE EXCEPTION 'page_ancestry_unavailable'; END IF;
  result:=result||jsonb_build_array(snapshot);
 END LOOP;
 RETURN (SELECT coalesce(jsonb_agg(DISTINCT value),'[]') FROM jsonb_array_elements(result));
END $$;
REVOKE ALL ON FUNCTION read_resource_page_dependencies(uuid,text,uuid,text) FROM PUBLIC;

ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check CHECK(source_kind IN
 ('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','crm_event','memory_verification','brain_verification','correction_audit','session_message','feedback_event','workspace_skill_revision','knowledge_source','recording','file_segment','transcript_segment','blueprint_record','browser_profile','browser_session','workflow_run',
 'page_event_changed','page_event_destination','page_live_changed','page_live_destination','external_source','application_field'));

CREATE FUNCTION validate_application_field_dependencies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE output scope_derivations; dependency record; source jsonb; current jsonb; has_fields boolean:=false;
BEGIN
 SELECT * INTO output FROM scope_derivations WHERE workspace_id=NEW.workspace_id AND id=NEW.derivation_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 FOR dependency IN SELECT * FROM read_application_field_dependencies(NEW.workspace_id,ARRAY[NEW.source_kind],ARRAY[NEW.source_id],ARRAY[NEW.source_version]) LOOP
  has_fields:=true;source:=dependency.source;
  current:=application_current_field_snapshot(NEW.workspace_id,(source->>'resourceId')::uuid);
  IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR current->>'version' IS DISTINCT FROM dependency.node_version THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM scope_derivation_sources s WHERE s.workspace_id=NEW.workspace_id AND s.derivation_id=NEW.derivation_id
   AND s.source_kind='application_field' AND s.source_id=(source->>'resourceId')::uuid AND s.source_version=dependency.node_version) THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
  IF source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM output.user_id::text
   AND source->>'userId' IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')
   OR sensitivity_rank(source->>'sensitivity')>sensitivity_rank(output.sensitivity)
   OR NOT to_jsonb(output.compartments)@>(source->'compartments') OR NOT to_jsonb(output.project_ids)@>(source->'projectIds') THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF NOT has_fields THEN RETURN NULL; END IF;
 FOR dependency IN SELECT * FROM read_external_source_dependencies(NEW.workspace_id,ARRAY[NEW.source_kind],ARRAY[NEW.source_id],ARRAY[NEW.source_version]) LOOP
  IF dependency.source IS NULL OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version
   OR NOT external_source_retention_allowed(NEW.workspace_id,(dependency.source->>'resourceId')::uuid,dependency.node_version)
   OR NOT EXISTS(SELECT 1 FROM scope_derivation_sources s WHERE s.workspace_id=NEW.workspace_id AND s.derivation_id=NEW.derivation_id
    AND s.source_kind='external_source' AND s.source_id=(dependency.source->>'resourceId')::uuid AND s.source_version=dependency.node_version) THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
  source:=dependency.source;
  IF sensitivity_rank(source->>'sensitivity')>sensitivity_rank(output.sensitivity)
   OR NOT to_jsonb(output.compartments)@>(source->'compartments') OR NOT to_jsonb(output.project_ids)@>(source->'projectIds') THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION validate_application_field_dependencies() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER application_field_derivation_dependencies AFTER INSERT OR UPDATE ON scope_derivation_sources
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_application_field_dependencies();

CREATE FUNCTION guard_application_field_lineage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE output scope_derivations;
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='scope_derivations' THEN output:=OLD;
 ELSE SELECT * INTO output FROM scope_derivations d WHERE d.workspace_id=OLD.workspace_id AND d.id=OLD.derivation_id; END IF;
 IF output.id IS NOT NULL AND EXISTS(SELECT 1 FROM workspaces WHERE id=output.workspace_id)
  AND read_scope_source(output.workspace_id,output.resource_kind,output.resource_id) IS NOT NULL
  AND EXISTS(SELECT 1 FROM read_application_field_dependencies(output.workspace_id,ARRAY[output.resource_kind],ARRAY[output.resource_id],ARRAY[output.resource_version])) THEN
  RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_application_field_lineage() FROM PUBLIC;
CREATE TRIGGER application_field_sources_immutable BEFORE UPDATE OR DELETE ON scope_derivation_sources
 FOR EACH ROW EXECUTE FUNCTION guard_application_field_lineage();
CREATE TRIGGER application_field_derivations_immutable BEFORE UPDATE OR DELETE ON scope_derivations
 FOR EACH ROW EXECUTE FUNCTION guard_application_field_lineage();

-- An app may validate its own field-only projection. Protected external/page
-- source profiles for application actors are still unsupported and refuse.
ALTER FUNCTION read_admitted_external_source_dependencies(uuid,text[],uuid[],text[])
 RENAME TO read_admitted_external_source_dependencies_before_fields;
REVOKE ALL ON FUNCTION read_admitted_external_source_dependencies_before_fields(uuid,text[],uuid[],text[]) FROM PUBLIC;
CREATE FUNCTION read_admitted_external_source_dependencies(w uuid,kinds text[],ids uuid[],versions text[])
RETURNS TABLE(node_version text,source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE context jsonb; n integer; admitted jsonb;
BEGIN
 IF nullif(current_setting('app.application_id',true),'') IS NULL THEN
  RETURN QUERY SELECT * FROM read_admitted_external_source_dependencies_before_fields(w,kinds,ids,versions); RETURN;
 END IF;
 context:=application_current_maxima();
 IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text
  OR kinds IS NULL OR ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 100
  OR cardinality(kinds) IS DISTINCT FROM cardinality(ids) OR cardinality(ids) IS DISTINCT FROM cardinality(versions)
  OR array_position(kinds,NULL) IS NOT NULL OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(kinds) kind WHERE kind<>'application_field')
  OR EXISTS(SELECT 1 FROM read_external_source_dependencies(w,kinds,ids,versions)) THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501'; END IF;
 FOR n IN 1..cardinality(ids) LOOP
  admitted:=read_admitted_application_field_snapshot(w,ids[n],versions[n]);
  IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' THEN
   RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501'; END IF;
 END LOOP;
 RETURN;
END $$;
REVOKE ALL ON FUNCTION read_admitted_external_source_dependencies(uuid,text[],uuid[],text[]) FROM PUBLIC;

ALTER FUNCTION read_admitted_page_dependencies(uuid,text,uuid,text) RENAME TO read_admitted_page_dependencies_before_fields;
REVOKE ALL ON FUNCTION read_admitted_page_dependencies_before_fields(uuid,text,uuid,text) FROM PUBLIC;
CREATE FUNCTION read_admitted_page_dependencies(w uuid,k text,i uuid,v text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE context jsonb; admitted jsonb; dependencies jsonb;
BEGIN
 IF nullif(current_setting('app.application_id',true),'') IS NULL THEN RETURN read_admitted_page_dependencies_before_fields(w,k,i,v); END IF;
 context:=application_current_maxima();
 IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text OR k<>'application_field' THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501'; END IF;
 admitted:=read_admitted_application_field_snapshot(w,i,v);
 IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501'; END IF;
 dependencies:=read_resource_page_dependencies(w,k,i,v);
 IF jsonb_array_length(dependencies)>0 THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501'; END IF;
 RETURN dependencies;
END $$;
REVOKE ALL ON FUNCTION read_admitted_page_dependencies(uuid,text,uuid,text) FROM PUBLIC;

-- Narrow lineage mutation for a newly created native memory. Raw access-policy
-- and lineage tables retain their existing restrictive app-role policies.
CREATE FUNCTION record_admitted_application_field_derivation(w uuid,k text,i uuid,v text,producer text,sources jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid; output memories;
 source jsonb; current jsonb; output_source jsonb; derivation uuid;
BEGIN
 IF actor IS NULL OR k<>'memory' OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='memories'::regclass
    WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  OR jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 1000
  OR length(btrim(producer)) NOT BETWEEN 1 AND 256
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) s WHERE s->>'resourceKind'='application_field') THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501'; END IF;
 SELECT m.* INTO output FROM memories m WHERE m.workspace_id=w AND m.id=i AND m.scope_version::text=v
  AND m.xmin::text::bigint=(pg_current_xact_id()::text::numeric % 4294967296)::bigint FOR UPDATE;
 IF NOT FOUND OR output.created_by_user_id IS DISTINCT FROM actor OR output.scope_held
  OR output.valid_to IS NOT NULL OR output.retracted_at IS NOT NULL
  OR output.user_id IS NOT NULL AND output.user_id<>actor
  OR output.assistant_id IS NOT NULL AND output.assistant_id IS DISTINCT FROM acting
  OR member_operation_scope_allows(w,output.sensitivity,output.compartments,true) IS NOT TRUE
  OR agent_mutation_scope_allows(output.compartments) IS NOT TRUE
  OR agent_read_scope_allows(output.sensitivity,output.compartments,output.project_ids) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501'; END IF;
 output_source:=read_admitted_native_scope_snapshot(w,k,i);
 IF output_source IS NULL OR output_source->>'held' IS DISTINCT FROM 'false' OR output_source->>'version' IS DISTINCT FROM v
  OR (SELECT count(DISTINCT (s->>'resourceKind',s->>'resourceId')) FROM jsonb_array_elements(sources) s)<>jsonb_array_length(sources) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
  current:=read_entity_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);
  IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR current->>'version' IS DISTINCT FROM source->>'version'
   OR current->>'validTo' IS NOT NULL OR current->>'retractedAt' IS NOT NULL
   OR (current->'workspaceId',current->'userId',current->'assistantId',current->'sensitivity')
    IS DISTINCT FROM (source->'workspaceId',source->'userId',source->'assistantId',source->'sensitivity')
   OR NOT (current->'compartments')@>(source->'compartments') OR NOT (source->'compartments')@>(current->'compartments')
   OR NOT (current->'projectIds')@>(source->'projectIds') OR NOT (source->'projectIds')@>(current->'projectIds') THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
  IF source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text
   OR sensitivity_rank(source->>'sensitivity')>sensitivity_rank(output.sensitivity)
   OR NOT to_jsonb(output.compartments)@>(source->'compartments') OR NOT to_jsonb(output.project_ids)@>(source->'projectIds') THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023'; END IF;
 END LOOP;
 INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,k,i,v,producer,output.user_id,output.assistant_id,output.sensitivity,output.compartments,output.project_ids,p.revision
   FROM workspace_access_policies p WHERE p.workspace_id=w RETURNING id INTO derivation;
 INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,derivation,s->>'resourceKind',(s->>'resourceId')::uuid,s->>'version' FROM jsonb_array_elements(sources) s
   ORDER BY s->>'resourceKind',s->>'resourceId';
 RETURN derivation;
END $$;
REVOKE ALL ON FUNCTION record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb) FROM PUBLIC;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON application_field_resources,application_field_observations,application_field_observation_sources FROM app_user;
  REVOKE ALL ON FUNCTION read_entity_derivation_source_before_application_fields(uuid,text,uuid) FROM app_user;
  REVOKE ALL ON FUNCTION read_admitted_external_source_dependencies_before_fields(uuid,text[],uuid[],text[]),read_admitted_page_dependencies_before_fields(uuid,text,uuid,text) FROM app_user;
  GRANT EXECUTE ON FUNCTION read_admitted_external_source_dependencies(uuid,text[],uuid[],text[]),read_admitted_page_dependencies(uuid,text,uuid,text) TO app_user;
  GRANT EXECUTE ON FUNCTION record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb) TO app_user;
  GRANT EXECUTE ON FUNCTION read_entity_derivation_source(uuid,text,uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[]) TO app_user;
  GRANT EXECUTE ON FUNCTION read_admitted_application_field_snapshot(uuid,uuid,text),read_admitted_application_field_dependencies(uuid,text[],uuid[],text[]) TO app_user;
 END IF;
END $$;
COMMIT;
