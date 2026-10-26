BEGIN;
-- [COMP:api/application-persistence] Immutable Knowledge versions and native body effects.
-- Additional immutable Knowledge boundary for SQL8079 (UNAPPLIED DRAFT).
-- Protected values are separate from append-only version evidence.
CREATE TABLE knowledge_entry_scope_revisions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 entry_id uuid NOT NULL,user_id uuid CHECK(user_id IS NULL),assistant_id uuid CHECK(assistant_id IS NULL),
 sensitivity text NOT NULL CHECK(sensitivity IN('public','internal','confidential')),
 compartments text[] NOT NULL CHECK(array_position(compartments,NULL) IS NULL),
 project_ids uuid[] NOT NULL CHECK(array_position(project_ids,NULL) IS NULL),
 scope_version bigint NOT NULL DEFAULT 1 CHECK(scope_version=1),scope_held boolean NOT NULL DEFAULT false,
 revision_kind text NOT NULL CHECK(revision_kind IN('capture','body')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(workspace_id,id)
);
CREATE TABLE knowledge_entry_revision_publications(
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,revision_id uuid PRIMARY KEY,
 entry_id uuid NOT NULL,entry_version text NOT NULL CHECK(length(entry_version) BETWEEN 1 AND 256),
 FOREIGN KEY(workspace_id,revision_id) REFERENCES knowledge_entry_scope_revisions(workspace_id,id) ON DELETE CASCADE,
 UNIQUE(workspace_id,entry_id,entry_version)
);
CREATE TABLE knowledge_entry_revision_fields(
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,revision_id uuid NOT NULL,field_key text NOT NULL,
 value_sha256 text NOT NULL CHECK(value_sha256 ~ '^[a-f0-9]{64}$'),PRIMARY KEY(revision_id,field_key),
 FOREIGN KEY(workspace_id,revision_id) REFERENCES knowledge_entry_scope_revisions(workspace_id,id) ON DELETE CASCADE,
 CHECK(field_key=ANY(ARRAY['id','path','title','summary','content','tags','relatedIds','metadata','sourceId','sourceSha','createdBy','createdAt','updatedAt']))
);
CREATE TABLE knowledge_entry_revision_values(
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,revision_id uuid NOT NULL,field_key text NOT NULL,value jsonb NOT NULL,
 PRIMARY KEY(revision_id,field_key),FOREIGN KEY(revision_id,field_key) REFERENCES knowledge_entry_revision_fields(revision_id,field_key) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,revision_id) REFERENCES knowledge_entry_scope_revisions(workspace_id,id) ON DELETE CASCADE
);
-- Capture metadata freezes every original input returned by the previous native
-- edge provider. It is not a protected payload or a retention/read allow token.
CREATE TABLE knowledge_entry_revision_capture_inputs(
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,revision_id uuid NOT NULL,
 source_kind text NOT NULL,source_id uuid NOT NULL,source_version text NOT NULL CHECK(length(source_version) BETWEEN 1 AND 256),
 PRIMARY KEY(revision_id,source_kind,source_id,source_version),
 FOREIGN KEY(workspace_id,revision_id) REFERENCES knowledge_entry_scope_revisions(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE knowledge_entry_scope_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entry_revision_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entry_revision_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entry_revision_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entry_revision_capture_inputs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge_entry_scope_revisions,knowledge_entry_revision_publications,knowledge_entry_revision_fields,
 knowledge_entry_revision_values,knowledge_entry_revision_capture_inputs FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON knowledge_entry_scope_revisions,knowledge_entry_revision_publications,knowledge_entry_revision_fields,
  knowledge_entry_revision_values,knowledge_entry_revision_capture_inputs FROM app_user;
END IF;END $$;
DO $$ DECLARE target record;expression text;BEGIN
 FOR target IN SELECT * FROM(VALUES
  ('scope_derivations','scope_derivations_resource_kind_check','resource_kind'),
  ('scope_derivation_sources','scope_derivation_sources_source_kind_check','source_kind'),
  ('scope_resource_states','scope_resource_states_resource_kind_check','resource_kind')) t(tab,name,col) LOOP
  SELECT pg_get_expr(c.conbin,c.conrelid) INTO STRICT expression FROM pg_constraint c WHERE c.conrelid=target.tab::regclass AND c.conname=target.name;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',target.tab,target.name);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK((%s) OR %I=%L)',target.tab,target.name,expression,target.col,'knowledge_entry_revision');
 END LOOP;
END $$;
ALTER FUNCTION scope_source_table(text) RENAME TO scope_source_table_before_knowledge_versions;
REVOKE ALL ON FUNCTION scope_source_table_before_knowledge_versions(text) FROM PUBLIC;
CREATE FUNCTION scope_source_table(k text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN k='knowledge_entry_revision' THEN 'knowledge_entry_scope_revisions' ELSE scope_source_table_before_knowledge_versions(k) END
$$;
REVOKE ALL ON FUNCTION scope_source_table(text) FROM PUBLIC;
CREATE FUNCTION guard_knowledge_revision_metadata() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN RETURN OLD;END IF;
 IF TG_TABLE_NAME='knowledge_entry_scope_revisions' AND TG_OP='UPDATE' THEN
  IF(to_jsonb(NEW)-'scope_held')=(to_jsonb(OLD)-'scope_held') AND(NEW.scope_held=OLD.scope_held OR NOT OLD.scope_held AND NEW.scope_held) THEN RETURN NEW;END IF;
 END IF;
 RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION guard_knowledge_revision_metadata() FROM PUBLIC;
CREATE TRIGGER knowledge_revision_scope_immutable BEFORE UPDATE OR DELETE ON knowledge_entry_scope_revisions FOR EACH ROW EXECUTE FUNCTION guard_knowledge_revision_metadata();
CREATE TRIGGER knowledge_revision_publication_immutable BEFORE UPDATE OR DELETE ON knowledge_entry_revision_publications FOR EACH ROW EXECUTE FUNCTION guard_knowledge_revision_metadata();
CREATE TRIGGER knowledge_revision_field_immutable BEFORE UPDATE OR DELETE ON knowledge_entry_revision_fields FOR EACH ROW EXECUTE FUNCTION guard_knowledge_revision_metadata();
CREATE TRIGGER knowledge_revision_capture_immutable BEFORE UPDATE OR DELETE ON knowledge_entry_revision_capture_inputs FOR EACH ROW EXECUTE FUNCTION guard_knowledge_revision_metadata();

ALTER FUNCTION application_scope_source_edges(uuid,text,uuid,text) RENAME TO application_scope_source_edges_before_knowledge_versions;
REVOKE ALL ON FUNCTION application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text) FROM PUBLIC;
CREATE FUNCTION knowledge_version_source_edges(w uuid,k text,i uuid,v text) RETURNS TABLE(kind text,id uuid,version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE publication knowledge_entry_revision_publications;
BEGIN
 IF k IS DISTINCT FROM 'knowledge_entry' AND k IS DISTINCT FROM 'knowledge_entry_revision' THEN
  RETURN QUERY SELECT e.kind,e.id,e.version FROM application_scope_source_edges_before_knowledge_versions(w,k,i,v) e;RETURN;
 END IF;
 IF k='knowledge_entry' THEN
  SELECT * INTO publication FROM knowledge_entry_revision_publications p WHERE p.workspace_id=w AND p.entry_id=i AND p.entry_version=v;
  IF FOUND THEN RETURN QUERY SELECT 'knowledge_entry_revision'::text,publication.revision_id,'1'::text;RETURN;END IF;
  IF EXISTS(SELECT 1 FROM knowledge_entry_revision_publications p JOIN knowledge_entry_scope_revisions r ON r.workspace_id=p.workspace_id AND r.id=p.revision_id
   WHERE p.workspace_id=w AND p.entry_id=i AND r.revision_kind='body') THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END IF;
 RETURN QUERY SELECT e.kind,e.id,e.version FROM application_scope_source_edges_before_knowledge_versions(w,k,i,v) e
  UNION SELECT c.source_kind,c.source_id,c.source_version FROM knowledge_entry_revision_capture_inputs c
   WHERE k='knowledge_entry_revision' AND c.workspace_id=w AND c.revision_id=i AND v='1'
  UNION SELECT 'knowledge_entry'::text,p.entry_id,p.entry_version FROM knowledge_entry_revision_publications p
   WHERE k='knowledge_entry_revision' AND p.workspace_id=w AND p.revision_id=i AND v='1';
END $$;
REVOKE ALL ON FUNCTION knowledge_version_source_edges(uuid,text,uuid,text) FROM PUBLIC;
CREATE FUNCTION application_scope_source_edges(w uuid,k text,i uuid,v text) RETURNS TABLE(kind text,id uuid,version text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.kind,e.id,e.version FROM knowledge_version_source_edges(w,k,i,v) e
$$;
REVOKE ALL ON FUNCTION application_scope_source_edges(uuid,text,uuid,text) FROM PUBLIC;

-- This private selected-field check returns no values or reusable authority.
CREATE FUNCTION native_knowledge_version_fields_allowed(w uuid,i uuid,fields text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;mask jsonb;source jsonb;
BEGIN
 IF fields IS NULL OR NOT fields<@application_knowledge_field_keys() OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f) THEN RETURN false;END IF;
 context:=application_knowledge_query_context(w);
 IF context IS NULL OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false) THEN RETURN false;END IF;
 source:=read_admitted_native_scope_snapshot(w,'knowledge_entry',i);
 IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR application_query_scope_admits_point(context->'bounds',source) IS NOT TRUE THEN RETURN false;END IF;
 IF context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' THEN
  mask:=read_native_application_field_mask(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry',i::text,source->>'version');
  IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'readFields'),false) THEN RETURN false;END IF;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION native_knowledge_version_fields_allowed(uuid,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION capture_native_knowledge_version(w uuid,i uuid,v text,fields text[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE entry record;revision uuid;field text;value jsonb;digest text;stored text;edge record;count_value integer:=0;
BEGIN
 -- Denied point reads have no metadata revision; typed writers retain strict pre-effect/archive checks.
 IF native_knowledge_version_fields_allowed(w,i,fields) IS NOT TRUE THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||i::text||':'||v,0));
 SELECT k.sensitivity,k.compartments,k.project_ids INTO entry FROM knowledge_entries k WHERE k.workspace_id=w AND k.id=i AND k.scope_version::text=v FOR SHARE;
 IF NOT FOUND OR application_canonical_ancestry_allowed(w,'knowledge_entry',i,v) IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 SELECT p.revision_id INTO revision FROM knowledge_entry_revision_publications p WHERE p.workspace_id=w AND p.entry_id=i AND p.entry_version=v;
 IF NOT FOUND THEN
  INSERT INTO knowledge_entry_scope_revisions(workspace_id,entry_id,sensitivity,compartments,project_ids,revision_kind)
   VALUES(w,i,entry.sensitivity,entry.compartments,entry.project_ids,'capture') RETURNING id INTO revision;
  -- Copy the complete original provider's edge set before publishing this root.
  -- No same-destination or selected-field edge is filtered out.
  FOR edge IN SELECT * FROM application_scope_source_edges_before_knowledge_versions(w,'knowledge_entry',i,v) LOOP
   count_value:=count_value+1;IF count_value>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
   INSERT INTO knowledge_entry_revision_capture_inputs(workspace_id,revision_id,source_kind,source_id,source_version)
    VALUES(w,revision,edge.kind,edge.id,edge.version) ON CONFLICT DO NOTHING;
  END LOOP;
  INSERT INTO knowledge_entry_revision_publications(workspace_id,revision_id,entry_id,entry_version) VALUES(w,revision,i,v);
 END IF;
 FOREACH field IN ARRAY fields LOOP
  EXECUTE format('SELECT to_jsonb(%I) FROM public.knowledge_entries WHERE workspace_id=$1 AND id=$2 AND scope_version::text=$3',
   CASE field WHEN 'relatedIds' THEN 'related_ids' WHEN 'sourceId' THEN 'source_id' WHEN 'sourceSha' THEN 'source_sha'
    WHEN 'createdBy' THEN 'created_by' WHEN 'createdAt' THEN 'created_at' WHEN 'updatedAt' THEN 'updated_at' ELSE field END)
   INTO value USING w,i,v;
  value:=coalesce(value,'null'::jsonb);digest:=application_field_digest(value);
  INSERT INTO knowledge_entry_revision_fields(workspace_id,revision_id,field_key,value_sha256) VALUES(w,revision,field,digest) ON CONFLICT DO NOTHING;
  SELECT f.value_sha256 INTO stored FROM knowledge_entry_revision_fields f WHERE f.workspace_id=w AND f.revision_id=revision AND f.field_key=field;
  IF stored IS DISTINCT FROM digest THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 END LOOP;
 RETURN revision;
END $$;
REVOKE ALL ON FUNCTION capture_native_knowledge_version(uuid,uuid,text,text[]) FROM PUBLIC;

CREATE FUNCTION knowledge_version_field_state(w uuid,i uuid,v text,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE revision knowledge_entry_scope_revisions;context jsonb;catalog jsonb;policy jsonb;field text;value jsonb;digest text;
 scope jsonb;values_json jsonb:='{}';hashes jsonb:='{}';references_json jsonb:='[]';identities jsonb:='[]';ids jsonb:='[]';target_id uuid;target jsonb;
BEGIN
 IF native_knowledge_version_fields_allowed(w,i,fields) IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT r.* INTO revision FROM knowledge_entry_revision_publications p JOIN knowledge_entry_scope_revisions r
  ON r.workspace_id=p.workspace_id AND r.id=p.revision_id WHERE p.workspace_id=w AND p.entry_id=i AND p.entry_version=v;
 IF NOT FOUND OR revision.scope_held OR revision.entry_id<>i THEN RETURN NULL;END IF;
 scope:=jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity',revision.sensitivity,
  'compartments',revision.compartments,'projectIds',revision.project_ids);
 context:=application_knowledge_query_context(w);
 IF context IS NULL OR workflow_evidence_envelope_visible(w,scope) IS NOT TRUE OR application_query_scope_admits_point(context->'bounds',scope) IS NOT TRUE THEN RETURN NULL;END IF;
 catalog:=application_native_field_catalog_for(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry');
 policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry',i::text);
 FOREACH field IN ARRAY fields LOOP
  SELECT f.value_sha256 INTO digest FROM knowledge_entry_revision_fields f WHERE f.workspace_id=w AND f.revision_id=revision.id AND f.field_key=field;
  IF NOT FOUND THEN RETURN NULL;END IF;
  -- Current parent/selected masks have already passed before a retained value is selected.
  SELECT retained.value INTO value FROM knowledge_entry_revision_values retained
   WHERE retained.workspace_id=w AND retained.revision_id=revision.id AND retained.field_key=field;
  IF NOT FOUND THEN
   EXECUTE format('SELECT coalesce(to_jsonb(%I),''null''::jsonb) FROM public.knowledge_entries WHERE workspace_id=$1 AND id=$2 AND scope_version::text=$3',
    CASE field WHEN 'relatedIds' THEN 'related_ids' WHEN 'sourceId' THEN 'source_id' WHEN 'sourceSha' THEN 'source_sha'
     WHEN 'createdBy' THEN 'created_by' WHEN 'createdAt' THEN 'created_at' WHEN 'updatedAt' THEN 'updated_at' ELSE field END)
    INTO value USING w,i,v;
   IF value IS NULL THEN RETURN NULL;END IF;
  END IF;
  IF application_field_digest(value) IS DISTINCT FROM digest THEN RETURN NULL;END IF;
  values_json:=values_json||jsonb_build_object(field,value);hashes:=hashes||jsonb_build_object(field,digest);
 END LOOP;
 IF 'relatedIds'=ANY(fields) THEN
  IF jsonb_typeof(values_json->'relatedIds') IS DISTINCT FROM 'array' OR jsonb_array_length(values_json->'relatedIds')>256 THEN RETURN NULL;END IF;
  FOR target_id IN SELECT DISTINCT item::uuid FROM jsonb_array_elements_text(values_json->'relatedIds') item ORDER BY item::uuid LOOP
   target:=application_knowledge_field_state(w,target_id,ARRAY['id']);IF target IS NULL THEN CONTINUE;END IF;
   ids:=ids||to_jsonb(target_id);identities:=identities||jsonb_build_array(jsonb_build_object('id',target_id,'version',target->'recordVersion','policy',target->'policyVersion','source',target->'source'));
   references_json:=references_json||jsonb_build_array(jsonb_build_object('origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey','knowledge_entry','id',target_id,'fields',jsonb_build_array('id')));
  END LOOP;
  values_json:=jsonb_set(values_json,'{relatedIds}',ids);
 END IF;
 RETURN jsonb_build_object('values',values_json,'source',scope,'recordVersion',v,'sourceKind','knowledge_entry_revision','sourceId',revision.id,
  'sourceVersion','1','ownerId',NULL,'fieldIdentity',application_field_digest(jsonb_build_object('kind','knowledge-version-fields-v1','fields',fields,'hashes',hashes)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','knowledge-version-fields-v1','fields',fields,'catalog',catalog->'fingerprint','record',policy->'fingerprint','identities',identities)),
  'references',references_json);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION knowledge_version_field_state(uuid,uuid,text,text[]) FROM PUBLIC;
ALTER FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) RENAME TO application_field_projection_state_before_knowledge_versions;
REVOKE ALL ON FUNCTION application_field_projection_state_before_knowledge_versions(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION application_field_projection_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type='knowledge_entry' AND p_selection='history' THEN
  IF p_selected_version IS NULL THEN RETURN NULL;END IF;RETURN knowledge_version_field_state(w,p_id,p_selected_version,p_fields);
 END IF;
 RETURN application_field_projection_state_before_knowledge_versions(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);
END $$;
REVOKE ALL ON FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
-- A native history adapter may have a distinct immutable source ID. The original
-- source ID from its admitted state owns external discovery, as for other typed
-- source parents. Preserve every other envelope/field/retention guard verbatim.
DO $migration$ DECLARE definition text;before text;BEGIN
 SELECT pg_get_functiondef('public.application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure) INTO definition;
 before:='ARRAY[state->>''sourceKind''],ARRAY[p_id],ARRAY[state->>''sourceVersion'']';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical field source identity discovery changed';END IF;
 EXECUTE replace(definition,before,'ARRAY[state->>''sourceKind''],ARRAY[(state->>''sourceId'')::uuid],ARRAY[state->>''sourceVersion'']');
END $migration$;

CREATE FUNCTION knowledge_revision_publication_valid(w uuid,i uuid,v text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE revision knowledge_entry_scope_revisions;entry record;
BEGIN
 SELECT r.* INTO revision FROM knowledge_entry_revision_publications p JOIN knowledge_entry_scope_revisions r
  ON r.workspace_id=p.workspace_id AND r.id=p.revision_id WHERE p.workspace_id=w AND p.entry_id=i AND p.entry_version=v;
 IF NOT FOUND OR revision.scope_held OR revision.entry_id<>i THEN RETURN false;END IF;
 SELECT sensitivity,compartments,project_ids INTO entry FROM knowledge_entries WHERE workspace_id=w AND id=i AND scope_version::text=v;
 IF NOT FOUND OR (revision.sensitivity,revision.compartments,revision.project_ids) IS DISTINCT FROM(entry.sensitivity,entry.compartments,entry.project_ids) THEN RETURN false;END IF;
 IF revision.revision_kind='body' AND(NOT EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='knowledge_entry_revision' AND d.resource_id=revision.id AND d.resource_version='1')
  OR(SELECT count(*) FROM knowledge_entry_revision_fields f WHERE f.workspace_id=w AND f.revision_id=revision.id)<>cardinality(application_knowledge_field_keys())) THEN RETURN false;END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION knowledge_revision_publication_valid(uuid,uuid,text) FROM PUBLIC;
DO $migration$ DECLARE definition text;before text;BEGIN
 SELECT pg_get_functiondef('public.application_knowledge_field_state_before_related_identities(uuid,uuid,text[])'::regprocedure) INTO definition;
 before:='AND NOT EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind=''knowledge_entry'' AND d.resource_id=i AND d.resource_version=row_version) THEN RETURN NULL;END IF;';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Knowledge current version evidence guard changed';END IF;
 EXECUTE replace(definition,before,replace(before,' THEN RETURN NULL;',
  ' AND knowledge_revision_publication_valid(w,i,row_version) IS NOT TRUE THEN RETURN NULL;'));
END $migration$;

-- Source metadata grants no protected values. Its real native parent remains a
-- current scope/bounds obligation; selected values separately require masks.
CREATE FUNCTION knowledge_revision_scope_allowed(w uuid,i uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE revision knowledge_entry_scope_revisions;scope jsonb;
BEGIN
 SELECT r.* INTO revision FROM knowledge_entry_scope_revisions r JOIN knowledge_entry_revision_publications p
  ON p.workspace_id=r.workspace_id AND p.revision_id=r.id AND p.entry_id=r.entry_id WHERE r.workspace_id=w AND r.id=i;
 IF NOT FOUND OR revision.scope_held OR native_knowledge_version_fields_allowed(w,revision.entry_id,'{}') IS NOT TRUE THEN RETURN false;END IF;
 scope:=jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity',revision.sensitivity,'compartments',revision.compartments,'projectIds',revision.project_ids);
 RETURN workflow_evidence_envelope_visible(w,scope) IS TRUE;
END $$;
REVOKE ALL ON FUNCTION knowledge_revision_scope_allowed(uuid,uuid) FROM PUBLIC;
ALTER FUNCTION read_admitted_native_scope_snapshot(uuid,text,uuid) RENAME TO read_admitted_native_scope_snapshot_before_knowledge_versions;
REVOKE ALL ON FUNCTION read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_admitted_native_scope_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF k='knowledge_entry_revision' THEN
  IF knowledge_revision_scope_allowed(w,i) IS NOT TRUE THEN RETURN NULL;END IF;
  RETURN read_scope_source(w,k,i);
 END IF;
 RETURN read_admitted_native_scope_snapshot_before_knowledge_versions(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_admitted_native_scope_snapshot(uuid,text,uuid) FROM PUBLIC;
ALTER FUNCTION read_entity_derivation_source(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_knowledge_versions;
REVOKE ALL ON FUNCTION read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF k='knowledge_entry_revision' THEN RETURN read_admitted_native_scope_snapshot(w,k,i);END IF;
 RETURN read_entity_derivation_source_before_knowledge_versions(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_entity_derivation_source(uuid,text,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_admitted_native_scope_snapshot(uuid,text,uuid),read_entity_derivation_source(uuid,text,uuid) TO app_user;
END IF;END $$;

CREATE FUNCTION knowledge_current_evidence_state(w uuid,i uuid,v text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE retained boolean;current_native boolean;
BEGIN
 retained:=EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='knowledge_entry' AND d.resource_id=i)
  OR EXISTS(SELECT 1 FROM knowledge_entry_revision_publications p JOIN knowledge_entry_scope_revisions r ON r.workspace_id=p.workspace_id AND r.id=p.revision_id
   WHERE p.workspace_id=w AND p.entry_id=i AND r.revision_kind='body');
 current_native:=EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='knowledge_entry' AND d.resource_id=i AND d.resource_version=v);
 RETURN jsonb_build_object('requiresAuthority',retained,'current',NOT retained OR current_native OR knowledge_revision_publication_valid(w,i,v));
END $$;
REVOKE ALL ON FUNCTION knowledge_current_evidence_state(uuid,uuid,text) FROM PUBLIC;
CREATE FUNCTION read_admitted_knowledge_evidence_state(w uuid,i uuid,v text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF native_knowledge_version_fields_allowed(w,i,'{}') IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM knowledge_entries k WHERE k.workspace_id=w AND k.id=i AND k.scope_version::text=v) THEN RETURN NULL;END IF;
 RETURN knowledge_current_evidence_state(w,i,v);
END $$;
REVOKE ALL ON FUNCTION read_admitted_knowledge_evidence_state(uuid,uuid,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_admitted_knowledge_evidence_state(uuid,uuid,text) TO app_user;
END IF;END $$;
ALTER FUNCTION application_knowledge_field_state(uuid,uuid,text[]) RENAME TO application_knowledge_field_state_before_version_evidence;
REVOKE ALL ON FUNCTION application_knowledge_field_state_before_version_evidence(uuid,uuid,text[]) FROM PUBLIC;
CREATE FUNCTION application_knowledge_field_state(w uuid,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v text;
BEGIN
 SELECT scope_version::text INTO v FROM knowledge_entries WHERE workspace_id=w AND id=i;
 IF NOT FOUND OR knowledge_current_evidence_state(w,i,v)->>'current' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 RETURN application_knowledge_field_state_before_version_evidence(w,i,fields);
END $$;
REVOKE ALL ON FUNCTION application_knowledge_field_state(uuid,uuid,text[]) FROM PUBLIC;

CREATE OR REPLACE FUNCTION read_native_knowledge_point_projection(w uuid,i uuid,expected_version text,legacy_only boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE version text;fields text[];captured jsonb;native_source jsonb;revision uuid;dependency record;admitted jsonb;complete_sources jsonb;
BEGIN
 IF expected_version IS NULL OR legacy_only IS NULL THEN RETURN NULL;END IF;
 SELECT scope_version::text INTO version FROM knowledge_entries WHERE workspace_id=w AND id=i;
 IF NOT FOUND OR version IS DISTINCT FROM expected_version OR legacy_only AND(EXISTS(
  SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='knowledge_entry' AND d.resource_id=i)
  OR EXISTS(SELECT 1 FROM knowledge_entry_revision_publications p JOIN knowledge_entry_scope_revisions r ON r.workspace_id=p.workspace_id AND r.id=p.revision_id
   WHERE p.workspace_id=w AND p.entry_id=i AND r.revision_kind='body')) THEN RETURN NULL;END IF;
 IF knowledge_current_evidence_state(w,i,version)->>'current' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='knowledge_entry' AND d.resource_id=i)
  AND NOT EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='knowledge_entry' AND d.resource_id=i AND d.resource_version=version)
  AND knowledge_revision_publication_valid(w,i,version) IS NOT TRUE THEN RETURN NULL;END IF;
 fields:=ARRAY(SELECT field FROM unnest(application_knowledge_field_keys()) field ORDER BY field);
 revision:=capture_native_knowledge_version(w,i,version,fields);
 IF revision IS NULL THEN RETURN NULL;END IF;
 captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry',i,version,'history',version,fields);
 IF captured IS NULL THEN RETURN NULL;END IF;
 complete_sources:=captured->'sources';
 FOR dependency IN SELECT * FROM read_application_field_dependencies(w,ARRAY['knowledge_entry'],ARRAY[i],ARRAY[version]) LOOP
  IF dependency.source IS NULL OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  admitted:=read_admitted_application_field_snapshot(w,(dependency.source->>'resourceId')::uuid,dependency.node_version);
  IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM dependency.node_version THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  complete_sources:=complete_sources||jsonb_build_array(dependency.source);
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO complete_sources FROM(SELECT DISTINCT value FROM jsonb_array_elements(complete_sources)) unique_sources;
 captured:=jsonb_set(captured,'{sources}',complete_sources);
 native_source:=read_admitted_native_scope_snapshot(w,'knowledge_entry',i);
 IF native_source IS NULL OR native_source->>'held' IS DISTINCT FROM 'false' OR native_source->>'version' IS DISTINCT FROM version THEN RETURN NULL;END IF;
 native_source:=jsonb_build_object('workspaceId',w,'userId',native_source->'userId','assistantId',native_source->'assistantId',
  'sensitivity',native_source->'sensitivity','compartments',native_source->'compartments','projectIds',native_source->'projectIds','resourceKind','knowledge_entry','resourceId',i,'version',version);
 RETURN captured||jsonb_build_object('nativeSources',jsonb_build_array(native_source)||coalesce((
  SELECT jsonb_agg(DISTINCT observation.source_scope||jsonb_build_object('resourceKind','knowledge_entry','resourceId',observation.source_id,'version',observation.source_version))
  FROM jsonb_array_elements(captured->'sources') source
  JOIN application_field_observations observation ON observation.workspace_id=w AND observation.resource_id=(source->>'resourceId')::uuid AND observation.version=source->>'version'
  WHERE source->>'resourceKind'='application_field' AND observation.source_kind='knowledge_entry'),'[]'::jsonb),'recordVersion',version);
END $$;

CREATE FUNCTION guard_knowledge_revision_value() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE digest text;
BEGIN
 IF TG_OP='DELETE' AND(NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
  OR EXISTS(SELECT 1 FROM knowledge_entry_scope_revisions r WHERE r.workspace_id=OLD.workspace_id AND r.id=OLD.revision_id AND r.scope_held)) THEN RETURN OLD;END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 SELECT f.value_sha256 INTO digest FROM knowledge_entry_revision_fields f WHERE f.workspace_id=NEW.workspace_id AND f.revision_id=NEW.revision_id AND f.field_key=NEW.field_key;
 IF digest IS NULL OR digest IS DISTINCT FROM application_field_digest(NEW.value) THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_knowledge_revision_value() FROM PUBLIC;
CREATE TRIGGER knowledge_revision_value_guard BEFORE INSERT OR UPDATE OR DELETE ON knowledge_entry_revision_values FOR EACH ROW EXECUTE FUNCTION guard_knowledge_revision_value();

-- History observations retain the same live related-target discovery as point reads.
-- Discovery remains metadata-only; the original fresh source/field validators decide use.
DO $migration$ DECLARE definition text;before text;BEGIN
 SELECT pg_get_functiondef('public.read_native_knowledge_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure) INTO definition;
 before:='resource.selection IN(''read'',''query'',''identity'')';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Knowledge point cohort selection changed';END IF;
 EXECUTE replace(definition,before,'resource.selection IN(''read'',''query'',''identity'',''history'')');
END $migration$;

CREATE FUNCTION archive_native_knowledge_version(w uuid,i uuid,v text,revision uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE field text;value jsonb;digest text;source record;
BEGIN
 IF native_knowledge_version_fields_allowed(w,i,application_knowledge_field_keys()) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM knowledge_entry_revision_publications p WHERE p.workspace_id=w AND p.entry_id=i AND p.entry_version=v AND p.revision_id=revision) THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 FOR source IN SELECT * FROM read_external_source_dependencies(w,ARRAY['knowledge_entry'],ARRAY[i],ARRAY[v]) LOOP
  IF source.source IS NULL OR source.source->>'version' IS DISTINCT FROM source.node_version
   OR external_source_retention_allowed(w,(source.source->>'resourceId')::uuid,source.node_version) IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 FOREACH field IN ARRAY application_knowledge_field_keys() LOOP
  EXECUTE format('SELECT coalesce(to_jsonb(%I),''null''::jsonb) FROM public.knowledge_entries WHERE workspace_id=$1 AND id=$2 AND scope_version::text=$3',
   CASE field WHEN 'relatedIds' THEN 'related_ids' WHEN 'sourceId' THEN 'source_id' WHEN 'sourceSha' THEN 'source_sha'
    WHEN 'createdBy' THEN 'created_by' WHEN 'createdAt' THEN 'created_at' WHEN 'updatedAt' THEN 'updated_at' ELSE field END) INTO value USING w,i,v;
  IF value IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  SELECT f.value_sha256 INTO digest FROM knowledge_entry_revision_fields f WHERE f.workspace_id=w AND f.revision_id=revision AND f.field_key=field;
  IF digest IS NULL OR digest IS DISTINCT FROM application_field_digest(value) THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  INSERT INTO knowledge_entry_revision_values(workspace_id,revision_id,field_key,value) VALUES(w,revision,field,value) ON CONFLICT DO NOTHING;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION archive_native_knowledge_version(uuid,uuid,text,uuid) FROM PUBLIC;

-- The typed effect is the sole caller: current masks and actual R1 retain proof
-- have passed before it populates this new revision from the exact RETURNING row.
CREATE FUNCTION publish_native_knowledge_body_revision(w uuid,i uuid,v text,revision uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE field text;value jsonb;entry record;root knowledge_entry_scope_revisions;
BEGIN
 SELECT sensitivity,compartments,project_ids INTO entry FROM knowledge_entries WHERE workspace_id=w AND id=i AND scope_version::text=v;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 SELECT * INTO root FROM knowledge_entry_scope_revisions r WHERE r.workspace_id=w AND r.id=revision AND r.entry_id=i AND r.revision_kind='body';
 IF NOT FOUND OR root.scope_held OR(root.sensitivity,root.compartments,root.project_ids) IS DISTINCT FROM(entry.sensitivity,entry.compartments,entry.project_ids) THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOREACH field IN ARRAY application_knowledge_field_keys() LOOP
  EXECUTE format('SELECT coalesce(to_jsonb(%I),''null''::jsonb) FROM public.knowledge_entries WHERE workspace_id=$1 AND id=$2 AND scope_version::text=$3',
   CASE field WHEN 'relatedIds' THEN 'related_ids' WHEN 'sourceId' THEN 'source_id' WHEN 'sourceSha' THEN 'source_sha'
    WHEN 'createdBy' THEN 'created_by' WHEN 'createdAt' THEN 'created_at' WHEN 'updatedAt' THEN 'updated_at' ELSE field END) INTO value USING w,i,v;
  IF value IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  INSERT INTO knowledge_entry_revision_fields(workspace_id,revision_id,field_key,value_sha256) VALUES(w,revision,field,application_field_digest(value));
  INSERT INTO knowledge_entry_revision_values(workspace_id,revision_id,field_key,value) VALUES(w,revision,field,value);
 END LOOP;
 INSERT INTO knowledge_entry_revision_publications(workspace_id,revision_id,entry_id,entry_version) VALUES(w,revision,i,v);
 -- Canonical admission needs the complete publication, including on successive edits.
 -- A denial here rolls back both the typed body effect and this entire pair.
 IF native_knowledge_version_fields_allowed(w,i,application_knowledge_field_keys()) IS NOT TRUE THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION publish_native_knowledge_body_revision(uuid,uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION validate_knowledge_revision_pair() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE revision uuid:=coalesce((to_jsonb(NEW)->>'revision_id')::uuid,(to_jsonb(NEW)->>'id')::uuid);root knowledge_entry_scope_revisions;publication knowledge_entry_revision_publications;
BEGIN
 SELECT * INTO root FROM knowledge_entry_scope_revisions r WHERE r.workspace_id=NEW.workspace_id AND r.id=revision;
 SELECT * INTO publication FROM knowledge_entry_revision_publications p WHERE p.workspace_id=NEW.workspace_id AND p.revision_id=revision;
 IF root.id IS NULL OR publication.revision_id IS NULL OR publication.entry_id<>root.entry_id
  OR NOT EXISTS(SELECT 1 FROM knowledge_entries k WHERE k.workspace_id=NEW.workspace_id AND k.id=root.entry_id AND k.scope_version::text=publication.entry_version
   AND(k.sensitivity,k.compartments,k.project_ids) IS NOT DISTINCT FROM(root.sensitivity,root.compartments,root.project_ids))
  OR root.revision_kind='body' AND(NOT EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=NEW.workspace_id AND d.resource_kind='knowledge_entry_revision' AND d.resource_id=revision AND d.resource_version='1')
   OR(SELECT count(*) FROM knowledge_entry_revision_fields f WHERE f.workspace_id=NEW.workspace_id AND f.revision_id=revision)<>cardinality(application_knowledge_field_keys())
   OR(SELECT count(*) FROM knowledge_entry_revision_values p WHERE p.workspace_id=NEW.workspace_id AND p.revision_id=revision)<>cardinality(application_knowledge_field_keys())) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION validate_knowledge_revision_pair() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER knowledge_scope_revision_pair AFTER INSERT ON knowledge_entry_scope_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_knowledge_revision_pair();
CREATE CONSTRAINT TRIGGER knowledge_revision_publication_pair AFTER INSERT ON knowledge_entry_revision_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_knowledge_revision_pair();

CREATE FUNCTION update_admitted_knowledge_entry_body(w uuid,i uuid,expected_version text,body text,producer text,sources jsonb,teams text[],projects uuid[])
RETURNS SETOF knowledge_entries LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;output knowledge_entries;
 context jsonb;mask jsonb;source jsonb;current jsonb;derivation uuid;prior_revision uuid;next_revision uuid;
BEGIN
 IF actor IS NULL OR body IS NULL OR expected_version IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL OR current_setting('app.system_bypass',true)='true'
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS DISTINCT FROM w::text
  OR nullif(current_setting('app.agent_actor_id',true),'') IS DISTINCT FROM actor::text
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.knowledge_entries'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  OR jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 1000
  OR length(btrim(producer)) NOT BETWEEN 1 AND 256 OR teams IS NULL OR projects IS NULL
  OR array_position(teams,NULL) IS NOT NULL OR array_position(projects,NULL) IS NOT NULL
  OR (SELECT count(DISTINCT (s->>'resourceKind',s->>'resourceId')) FROM jsonb_array_elements(sources) s)<>jsonb_array_length(sources) THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 context:=application_knowledge_query_context(w);IF context IS NULL THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 IF native_knowledge_version_fields_allowed(w,i,application_knowledge_field_keys()) IS NOT TRUE THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 SELECT k.* INTO output FROM knowledge_entries k WHERE k.workspace_id=w AND k.id=i AND k.scope_version::text=expected_version FOR UPDATE;
 IF NOT FOUND OR output.scope_held OR output.source_id IS NOT NULL OR output.source_sha IS NOT NULL
  OR member_operation_scope_allows(w,output.sensitivity,output.compartments,true) IS NOT TRUE
  OR agent_mutation_scope_allows(output.compartments) IS NOT TRUE
  OR agent_read_scope_allows(output.sensitivity,output.compartments,output.project_ids) IS NOT TRUE
  OR application_canonical_ancestry_allowed(w,'knowledge_entry',i,expected_version,true) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 IF context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' THEN
  mask:=read_native_application_field_catalog(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry');
  IF mask IS NULL OR NOT coalesce(mask->'writeFields' ? 'content',false) THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
  mask:=read_native_application_field_mask(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry',i::text,expected_version);
  IF mask IS NULL OR NOT coalesce(mask->'writeFields' ? 'content',false) THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 END IF;
 SELECT ARRAY(SELECT DISTINCT unnest(output.compartments||teams) ORDER BY 1),ARRAY(SELECT DISTINCT unnest(output.project_ids||projects) ORDER BY 1)
  INTO output.compartments,output.project_ids;
 IF member_operation_scope_allows(w,output.sensitivity,output.compartments,true) IS NOT TRUE
  OR agent_mutation_scope_allows(output.compartments) IS NOT TRUE
  OR agent_read_scope_allows(output.sensitivity,output.compartments,output.project_ids) IS NOT TRUE THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 -- Every exact original observation is validated before its own canonical body changes.
 -- No source edge, selected field or same-destination guard is removed.
 FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  IF source->>'resourceKind'='external_source' THEN
   IF external_source_retention_allowed(w,(source->>'resourceId')::uuid,source->>'version') IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   current:=external_source_snapshot(w,(source->>'resourceId')::uuid);
  ELSE current:=read_entity_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);END IF;
  IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR current->>'version' IS DISTINCT FROM source->>'version'
   OR current->>'validTo' IS NOT NULL OR current->>'retractedAt' IS NOT NULL
   OR (current->'workspaceId',current->'userId',current->'assistantId',current->'sensitivity') IS DISTINCT FROM (source->'workspaceId',source->'userId',source->'assistantId',source->'sensitivity')
   OR NOT (current->'compartments')@>(source->'compartments') OR NOT (source->'compartments')@>(current->'compartments')
   OR NOT (current->'projectIds')@>(source->'projectIds') OR NOT (source->'projectIds')@>(current->'projectIds') THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text OR sensitivity_rank(source->>'sensitivity')>sensitivity_rank(output.sensitivity)
   OR NOT to_jsonb(output.compartments)@>(source->'compartments') OR NOT to_jsonb(output.project_ids)@>(source->'projectIds') THEN RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
 END LOOP;
 prior_revision:=capture_native_knowledge_version(w,i,expected_version,application_knowledge_field_keys());
 PERFORM archive_native_knowledge_version(w,i,expected_version,prior_revision);
 INSERT INTO knowledge_entry_scope_revisions(workspace_id,entry_id,sensitivity,compartments,project_ids,revision_kind)
  VALUES(w,i,output.sensitivity,output.compartments,output.project_ids,'body') RETURNING id INTO next_revision;
 INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'knowledge_entry_revision',next_revision,'1',producer,NULL,NULL,output.sensitivity,output.compartments,output.project_ids,p.revision
  FROM workspace_access_policies p WHERE p.workspace_id=w RETURNING id INTO derivation;
 INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,derivation,s->>'resourceKind',(s->>'resourceId')::uuid,s->>'version' FROM jsonb_array_elements(sources) s ORDER BY s->>'resourceKind',s->>'resourceId';
 -- Validate the complete original input graph before its carrier is changed.
 -- New publication/value pairing remains deferred until the actual result exists.
 SET CONSTRAINTS application_field_derivation_dependencies,page_derivation_dependencies,workflow_derivation_dependencies IMMEDIATE;
 SET CONSTRAINTS application_field_derivation_dependencies,page_derivation_dependencies,workflow_derivation_dependencies DEFERRED;
 UPDATE knowledge_entries k SET content=body,compartments=output.compartments,project_ids=output.project_ids,updated_at=now()
  WHERE k.workspace_id=w AND k.id=i AND k.scope_version::text=expected_version RETURNING k.* INTO output;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' THEN
  mask:=read_native_application_field_mask(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry',i::text,output.scope_version::text);
  IF mask IS NULL OR NOT coalesce(mask->'writeFields' ? 'content',false) THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 END IF;
 PERFORM publish_native_knowledge_body_revision(w,i,output.scope_version::text,next_revision);
 RETURN NEXT output;
END $$;
REVOKE ALL ON FUNCTION update_admitted_knowledge_entry_body(uuid,uuid,text,text,text,jsonb,text[],uuid[]) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION update_admitted_knowledge_entry_body(uuid,uuid,text,text,text,jsonb,text[],uuid[]) TO app_user;
END IF;END $$;

-- Reviewed Knowledge wrappers preserve native metadata leaf equivalence. Every
-- wrapper, private dispatcher and original delegate remains fingerprinted;
-- an unknown extension still falls back to the complete canonical lineage.
DO $knowledge_leaf$
DECLARE kernel record;routine record;definition text;values_sql text:='';semantic_hash text;old_values text;
BEGIN
 FOR kernel IN SELECT * FROM (VALUES
  ('public.application_scope_source_edges(uuid,text,uuid,text)','14535b6ea617c43c10f030e519d61bfc558f649876530f9d9f03cc019f7d6be3'),
  ('public.application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','20d8c359a6b77c9c96aed3be9e31719e60868fb55e34aaedc2714494e6a8e974'),
  ('public.knowledge_version_source_edges(uuid,text,uuid,text)','f4deb0d7b7ef41db5dc1d2fedabcef545c836b9f8a78f48d55a2c7413e62f1cf'),
  ('public.scope_source_ancestors(uuid,text,uuid)','d8e33fb3a66e4318ed159e288c797b6d55759481e1339d4e53c372cb6907e0e8'),
  ('public.scope_source_ancestors_before_workflow_run(uuid,text,uuid)','36bdb461a66fb00b81a5f0f6672b48dcc150858328b035b1ba1da0c3ed3715c8'),
  ('public.scope_source_ancestors_before_browser_session(uuid,text,uuid)','c5a684292738319265321ce21b76ea01ba775eb216af66ae992c190d39eedc5c'),
  ('public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)','401b62c0bf792041938e92d7ea4207f4a3f7bb9f070bfb6a4bea3aa0ee5cb957'),
  ('public.scope_source_table(text)','adc507baa12e1e269887ce7734b66abfce202cb44baf64aea866f2ff82343984'),
  ('public.scope_source_table_before_knowledge_versions(text)','50b1e162e95c2cb9e01300d2ed70041cf89350004e11476352463eeba1e9d3d6'),
  ('public.scope_source_table_before_persistent_context(text)','77ae7215cf985148bc013cd5afd14cac03776580e347bf548c67b6d1ca7f40da'),
  ('public.scope_source_table_before_media(text)','93ff1be795bfbee59a38c43da3425018072c18007fe39e99ecd4d7e8731eba15')
 ) reviewed(signature,body_sha256) LOOP
  SELECT p.* INTO routine FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure(kernel.signature);
  IF NOT FOUND OR encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex') IS DISTINCT FROM kernel.body_sha256 THEN
   RAISE EXCEPTION 'Canonical Knowledge metadata prerequisite changed: %',kernel.signature;END IF;
  semantic_hash:=application_field_digest(jsonb_build_object('name',routine.proname,'namespace',routine.pronamespace,'body',routine.prosrc,
   'config',routine.proconfig,'language',routine.prolang,'securityDefiner',routine.prosecdef,'volatility',routine.provolatile,'strict',routine.proisstrict,'parallel',routine.proparallel));
  values_sql:=values_sql||CASE WHEN values_sql='' THEN '' ELSE ',' END||format('(%s::oid,%L::text)',routine.oid,semantic_hash);
 END LOOP;
 SELECT pg_get_functiondef('public.application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure) INTO definition;
 SELECT substring(definition FROM 'FROM [(]VALUES ([^;]+)[)] pin[(]function_oid,fingerprint[)]') INTO old_values;
 IF old_values IS NULL OR position('count(*)=8 AND coalesce(bool_and' IN definition)=0
  OR position('R2 canonical entity leaf transport' IN definition)=0
  OR position('kinds[1] IN(''entity'',''memory'')' IN definition)=0 THEN
  RAISE EXCEPTION 'Canonical native leaf transport changed';END IF;
 definition:=replace(definition,'FROM (VALUES '||old_values||') pin(function_oid,fingerprint)', 'FROM (VALUES '||values_sql||') pin(function_oid,fingerprint)');
 definition:=replace(definition,'count(*)=8 AND coalesce(bool_and','count(*)=11 AND coalesce(bool_and');
 EXECUTE definition;
END $knowledge_leaf$;

COMMIT;
