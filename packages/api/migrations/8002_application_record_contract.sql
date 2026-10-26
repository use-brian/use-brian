-- Shared application canonical generic record contract; no broader app admission.
BEGIN;

ALTER TABLE entity_instances ADD COLUMN record_version bigint NOT NULL DEFAULT 1 CHECK (record_version > 0);

-- The older context policy checks a pinned agent clearance instead of intersecting
-- the current member floor. Reuse the kernel's existing operation-floor function.
CREATE POLICY application_generic_current_member_read ON entity_instances AS RESTRICTIVE FOR SELECT
  USING (member_operation_scope_allows(workspace_id,sensitivity,compartments,false));
CREATE POLICY application_generic_current_member_insert ON entity_instances AS RESTRICTIVE FOR INSERT
  WITH CHECK (member_operation_scope_allows(workspace_id,sensitivity,compartments,true));
CREATE POLICY application_generic_current_member_update ON entity_instances AS RESTRICTIVE FOR UPDATE
  USING (member_operation_scope_allows(workspace_id,sensitivity,compartments,true))
  WITH CHECK (member_operation_scope_allows(workspace_id,sensitivity,compartments,true));
CREATE POLICY application_generic_current_member_delete ON entity_instances AS RESTRICTIVE FOR DELETE
  USING (member_operation_scope_allows(workspace_id,sensitivity,compartments,true));

CREATE TABLE application_schema_versions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type_id uuid NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  properties jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type_id, schema_version)
);
CREATE TABLE application_record_revisions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_instance_id uuid NOT NULL REFERENCES entity_instances(id) ON DELETE CASCADE,
  record_version bigint NOT NULL CHECK (record_version > 0),
  schema_version integer NOT NULL,
  data jsonb NOT NULL,
  sensitivity text NOT NULL,
  compartments text[] NOT NULL,
  project_ids uuid[] NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_instance_id, record_version)
);
CREATE TABLE application_unique_values (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type_id uuid NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE,
  field_key text NOT NULL,
  normalized_value text NOT NULL,
  entity_instance_id uuid NOT NULL REFERENCES entity_instances(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, entity_type_id, field_key, normalized_value),
  UNIQUE (entity_instance_id, field_key)
);
ALTER TABLE application_schema_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_record_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_unique_values ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_schema_versions_current_source ON application_schema_versions FOR SELECT
  USING (EXISTS (SELECT 1 FROM entity_types t WHERE t.id=entity_type_id AND t.workspace_id=application_schema_versions.workspace_id));
CREATE POLICY application_record_revisions_current_source ON application_record_revisions FOR SELECT
  USING (EXISTS (SELECT 1 FROM entity_instances r WHERE r.id=entity_instance_id AND r.workspace_id=application_record_revisions.workspace_id)
    AND context_scope_allows_current_principal(workspace_id,sensitivity,compartments,project_ids));
-- Unique values can expose protected fields. There is intentionally no app-role policy.

CREATE FUNCTION application_validate_generic_schema() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE property jsonb; config jsonb; option_ids text[]; property_names text[] := '{}';
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id
    OR NEW.created_at<>OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by) THEN
    RAISE EXCEPTION 'invalid_schema: immutable schema identity' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(NEW.properties)<>'array' OR jsonb_array_length(NEW.properties)>128 THEN
    RAISE EXCEPTION 'invalid_schema: invalid property catalog' USING ERRCODE='22023';
  END IF;
  FOR property IN SELECT value FROM jsonb_array_elements(NEW.properties) LOOP
    config := property->'config';
    IF jsonb_typeof(property)<>'object' OR jsonb_typeof(property->'name')<>'string'
      OR length(property->>'name') NOT BETWEEN 1 AND 128 OR property->>'name'=ANY(property_names)
      OR property->>'name' IN ('__proto__','constructor','prototype') OR jsonb_typeof(config)<>'object'
      OR coalesce(config->>'kind','') NOT IN ('text','number','select','multi_select','status','date','person','relation','files','checkbox','url','email','phone','created_time','created_by','last_edited_time','last_edited_by')
      OR (property ? 'required' AND jsonb_typeof(property->'required')<>'boolean')
      OR (property ? 'unique' AND jsonb_typeof(property->'unique')<>'boolean') THEN
      RAISE EXCEPTION 'invalid_schema: invalid or duplicate property' USING ERRCODE='22023';
    END IF;
    property_names := array_append(property_names,property->>'name');
    IF config->>'kind'='number' AND (
      config ? 'minimum' AND jsonb_typeof(config->'minimum')<>'number'
      OR config ? 'maximum' AND jsonb_typeof(config->'maximum')<>'number'
      OR (config->>'minimum')::numeric > (config->>'maximum')::numeric) THEN
      RAISE EXCEPTION 'invalid_schema: invalid numeric bounds' USING ERRCODE='22023';
    END IF;
    IF config->>'kind' IN ('select','multi_select','status') THEN
      IF config->>'kind'='status' THEN
        IF jsonb_typeof(config->'groups') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'invalid_schema: status groups required' USING ERRCODE='22023';
        END IF;
        SELECT array_agg(o->>'id') INTO option_ids FROM jsonb_array_elements(config->'groups') g,
          LATERAL jsonb_array_elements(g->'options') o;
      ELSE
        IF jsonb_typeof(config->'options') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'invalid_schema: enum options required' USING ERRCODE='22023';
        END IF;
        SELECT array_agg(o->>'id') INTO option_ids FROM jsonb_array_elements(config->'options') o;
      END IF;
      IF array_position(option_ids,NULL) IS NOT NULL OR cardinality(option_ids)<>(SELECT count(DISTINCT x) FROM unnest(option_ids) x) THEN
        RAISE EXCEPTION 'invalid_schema: duplicate enum options' USING ERRCODE='22023';
      END IF;
    END IF;
    IF coalesce((property->>'unique')::boolean,false) AND config->>'kind' NOT IN ('text','number','select','status','email','phone','url','person','relation') THEN
      RAISE EXCEPTION 'invalid_schema: uniqueness requires scalar values' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF TG_OP='UPDATE' THEN
    NEW.schema_version := OLD.schema_version + CASE WHEN NEW.properties IS DISTINCT FROM OLD.properties THEN 1 ELSE 0 END;
  ELSE
    NEW.schema_version := greatest(NEW.schema_version,1);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER application_schema_contract BEFORE INSERT OR UPDATE ON entity_types
FOR EACH ROW EXECUTE FUNCTION application_validate_generic_schema();

CREATE FUNCTION application_check_generic_values(p_row entity_instances, p_old_data jsonb DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE properties jsonb; property jsonb; cell jsonb; value jsonb; config jsonb; field_name text;
  allowed_options text[]; selected text; target text; target_id uuid; admitted boolean; file_ref jsonb;
  date_start timestamptz; date_end timestamptz;
BEGIN
  SELECT t.properties INTO properties FROM entity_types t
    WHERE t.id=p_row.entity_type_id AND t.workspace_id=p_row.workspace_id FOR SHARE;
  IF properties IS NULL OR jsonb_typeof(p_row.data)<>'object' THEN
    RAISE EXCEPTION 'invalid_value: schema or record unavailable' USING ERRCODE='22023';
  END IF;
  FOR field_name IN SELECT jsonb_object_keys(p_row.data) LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(properties) p WHERE p->>'name'=field_name) THEN
      RAISE EXCEPTION 'invalid_value: undeclared field' USING ERRCODE='22023';
    END IF;
  END LOOP;
  FOR property IN SELECT element.value FROM jsonb_array_elements(properties) AS element(value) LOOP
    field_name := property->>'name'; config := property->'config'; cell := p_row.data->field_name; value := cell->'value';
    IF coalesce((property->>'required')::boolean,false) AND config->>'kind' NOT IN ('created_time','created_by','last_edited_time','last_edited_by')
      AND (value IS NULL OR value='null'::jsonb OR value='""'::jsonb OR value='[]'::jsonb) THEN
      RAISE EXCEPTION 'invalid_value: required value missing' USING ERRCODE='22023';
    END IF;
    IF cell IS NULL THEN CONTINUE; END IF;
    IF jsonb_typeof(cell)<>'object' OR cell->>'kind' IS DISTINCT FROM config->>'kind' OR NOT cell ? 'value'
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(cell) k WHERE k NOT IN ('kind','value')) THEN
      RAISE EXCEPTION 'invalid_value: cell kind mismatch' USING ERRCODE='22023';
    END IF;
    IF config->>'kind' IN ('created_time','created_by','last_edited_time','last_edited_by')
      AND cell IS DISTINCT FROM p_old_data->field_name THEN
      RAISE EXCEPTION 'invalid_value: immutable system field' USING ERRCODE='22023';
    END IF;
    IF value='null'::jsonb THEN CONTINUE; END IF;
    CASE config->>'kind'
    WHEN 'number' THEN
      IF jsonb_typeof(value)<>'number' THEN RAISE EXCEPTION 'invalid_value: numeric value required' USING ERRCODE='22023'; END IF;
      IF (config->>'format'='int' AND (value::text)::numeric<>trunc((value::text)::numeric))
        OR (value::text)::numeric < (config->>'minimum')::numeric OR (value::text)::numeric > (config->>'maximum')::numeric THEN
        RAISE EXCEPTION 'invalid_value: numeric bounds' USING ERRCODE='22023';
      END IF;
    WHEN 'checkbox' THEN
      IF jsonb_typeof(value)<>'boolean' THEN RAISE EXCEPTION 'invalid_value: boolean required' USING ERRCODE='22023'; END IF;
    WHEN 'select','multi_select','status' THEN
      IF config->>'kind'='status' THEN
        SELECT array_agg(o->>'id') INTO allowed_options FROM jsonb_array_elements(config->'groups') g,
          LATERAL jsonb_array_elements(g->'options') o;
      ELSE SELECT array_agg(o->>'id') INTO allowed_options FROM jsonb_array_elements(config->'options') o; END IF;
      IF config->>'kind'='multi_select' THEN
        IF jsonb_typeof(value)<>'array' THEN RAISE EXCEPTION 'invalid_value: enum array required' USING ERRCODE='22023'; END IF;
        IF jsonb_array_length(value)<>(SELECT count(DISTINCT x) FROM jsonb_array_elements_text(value) x) THEN
          RAISE EXCEPTION 'invalid_value: duplicate enum selection' USING ERRCODE='22023';
        END IF;
        FOR selected IN SELECT jsonb_array_elements_text(value) LOOP
          IF NOT coalesce(selected=ANY(allowed_options),false) THEN RAISE EXCEPTION 'invalid_value: enum option' USING ERRCODE='22023'; END IF;
        END LOOP;
      ELSIF jsonb_typeof(value)<>'string' OR NOT coalesce((value#>>'{}')=ANY(allowed_options),false) THEN
        RAISE EXCEPTION 'invalid_value: enum option' USING ERRCODE='22023';
      END IF;
    WHEN 'date' THEN
      IF jsonb_typeof(value)<>'object' OR jsonb_typeof(value->'start') IS DISTINCT FROM 'string'
        OR coalesce(value->>'start','') !~ '^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$'
        OR value ? 'end' AND NOT coalesce((config->>'supportRange')::boolean,false)
        OR coalesce((value->>'time')::boolean,false) AND NOT coalesce((config->>'includeTime')::boolean,false) THEN
        RAISE EXCEPTION 'invalid_value: date range' USING ERRCODE='22023';
      END IF;
      BEGIN
        date_start := (value->>'start')::timestamptz; date_end := (value->>'end')::timestamptz;
      EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid_value: date range' USING ERRCODE='22023'; END;
      IF date_end < date_start THEN RAISE EXCEPTION 'invalid_value: reversed date range' USING ERRCODE='22023'; END IF;
    WHEN 'relation' THEN
      IF jsonb_typeof(value)<>'string' THEN RAISE EXCEPTION 'invalid_value: reference required' USING ERRCODE='22023'; END IF;
      BEGIN target_id := (value#>>'{}')::uuid;
      EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid_value: reference unavailable' USING ERRCODE='22023'; END;
      target := config->'targetEntityTypeRef'->>'kind';
      IF target='user_defined' THEN
        SELECT EXISTS(SELECT 1 FROM entity_instances r WHERE r.id=target_id AND r.workspace_id=p_row.workspace_id
          AND r.entity_type_id=(config->'targetEntityTypeRef'->>'entityTypeId')::uuid) INTO admitted;
      ELSIF target='builtin' AND config->'targetEntityTypeRef'->>'name' IN ('contact','company','deal') THEN
        SELECT EXISTS(SELECT 1 FROM entities e WHERE e.id=target_id AND e.workspace_id=p_row.workspace_id
          AND e.kind=CASE config->'targetEntityTypeRef'->>'name' WHEN 'contact' THEN 'person' ELSE config->'targetEntityTypeRef'->>'name' END) INTO admitted;
      ELSIF target='builtin' AND config->'targetEntityTypeRef'->>'name'='task' THEN
        SELECT EXISTS(SELECT 1 FROM tasks t WHERE t.id=target_id AND t.workspace_id=p_row.workspace_id) INTO admitted;
      ELSIF target='builtin' AND config->'targetEntityTypeRef'->>'name'='workflow_run' THEN
        SELECT EXISTS(SELECT 1 FROM workflow_runs r WHERE r.id=target_id AND r.workspace_id=p_row.workspace_id) INTO admitted;
      ELSE admitted := false; END IF;
      IF NOT admitted THEN RAISE EXCEPTION 'invalid_value: reference unavailable' USING ERRCODE='22023'; END IF;
    WHEN 'person' THEN
      SELECT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=p_row.workspace_id AND m.user_id::text=value#>>'{}') INTO admitted;
      IF jsonb_typeof(value)<>'string' OR NOT admitted THEN RAISE EXCEPTION 'invalid_value: person unavailable' USING ERRCODE='22023'; END IF;
    WHEN 'files' THEN
      IF jsonb_typeof(value)<>'array' THEN RAISE EXCEPTION 'invalid_value: file array required' USING ERRCODE='22023'; END IF;
      FOR file_ref IN SELECT jsonb_array_elements(value) LOOP
        SELECT EXISTS(SELECT 1 FROM workspace_files f WHERE f.workspace_id=p_row.workspace_id
          AND f.storage_uri='gs://' || (file_ref->>'bucket') || '/' || (file_ref->>'path')) INTO admitted;
        IF NOT admitted OR jsonb_typeof(file_ref->'sizeBytes') IS DISTINCT FROM 'number'
          OR (file_ref->>'sizeBytes')::numeric < 0 OR (file_ref->>'sizeBytes')::numeric<>trunc((file_ref->>'sizeBytes')::numeric) THEN
          RAISE EXCEPTION 'invalid_value: file unavailable' USING ERRCODE='22023';
        END IF;
      END LOOP;
    WHEN 'text' THEN NULL;
    ELSE
      IF jsonb_typeof(value)<>'string' THEN RAISE EXCEPTION 'invalid_value: text reference required' USING ERRCODE='22023'; END IF;
    END CASE;
  END LOOP;
END;
$$;

CREATE FUNCTION application_validate_generic_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE current_row entity_instances;
BEGIN
  SELECT * INTO current_row FROM entity_instances WHERE id=NEW.id AND workspace_id=NEW.workspace_id;
  IF FOUND THEN PERFORM application_check_generic_values(current_row,CASE WHEN TG_OP='UPDATE' THEN OLD.data ELSE NULL END); END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER application_record_value_valid AFTER INSERT OR UPDATE ON entity_instances
DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION application_validate_generic_record();

-- The caller supplies its RLS-visible IDs. The definer only answers completeness,
-- never returns a hidden ID/value or executes a mutation on the caller's behalf.
CREATE FUNCTION application_generic_schema_rows_visible(p_type uuid,p_workspace uuid,p_visible uuid[]) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM entity_types t JOIN workspace_members m ON m.workspace_id=t.workspace_id
      WHERE t.id=p_type AND t.workspace_id=p_workspace AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
    AND NOT EXISTS(SELECT 1 FROM entity_instances r WHERE r.entity_type_id=p_type AND r.workspace_id=p_workspace
    AND NOT r.id=ANY(p_visible));
$$;

CREATE FUNCTION application_validate_schema_rows() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE current_row entity_instances;
BEGIN
  IF TG_OP='INSERT' THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' AND NEW.properties IS NOT DISTINCT FROM OLD.properties THEN RETURN NULL; END IF;
  IF NOT application_generic_schema_rows_visible(NEW.id,NEW.workspace_id,
    ARRAY(SELECT id FROM entity_instances WHERE entity_type_id=NEW.id AND workspace_id=NEW.workspace_id)) THEN
    RAISE EXCEPTION 'access_unavailable: schema change requires access to every affected record' USING ERRCODE='42501';
  END IF;
  FOR current_row IN SELECT * FROM entity_instances WHERE entity_type_id=NEW.id AND workspace_id=NEW.workspace_id LOOP
    PERFORM application_check_generic_values(current_row,current_row.data);
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER application_schema_value_valid AFTER INSERT OR UPDATE ON entity_types
DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION application_validate_schema_rows();

CREATE FUNCTION application_version_generic_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.entity_type_id<>OLD.entity_type_id
      OR NEW.created_at<>OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'invalid_value: immutable record identity' USING ERRCODE='22023';
    END IF;
    NEW.record_version := OLD.record_version+1;
  ELSE NEW.record_version := 1; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER application_record_version BEFORE INSERT OR UPDATE ON entity_instances
FOR EACH ROW EXECUTE FUNCTION application_version_generic_record();

CREATE FUNCTION application_capture_generic_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE properties jsonb; property jsonb; value jsonb; normalized text; schema_revision integer;
BEGIN
  SELECT t.properties,t.schema_version INTO properties,schema_revision FROM entity_types t WHERE t.id=NEW.entity_type_id AND t.workspace_id=NEW.workspace_id;
  INSERT INTO application_record_revisions(workspace_id,entity_instance_id,record_version,schema_version,data,sensitivity,compartments,project_ids,actor_user_id)
    VALUES(NEW.workspace_id,NEW.id,NEW.record_version,schema_revision,NEW.data,NEW.sensitivity,NEW.compartments,NEW.project_ids,NEW.last_edited_by);
  DELETE FROM application_unique_values WHERE entity_instance_id=NEW.id;
  FOR property IN SELECT p FROM jsonb_array_elements(properties) p WHERE coalesce((p->>'unique')::boolean,false) LOOP
    value := NEW.data->(property->>'name')->'value';
    IF value IS NULL OR value IN ('null'::jsonb,'""'::jsonb) THEN CONTINUE; END IF;
    normalized := CASE WHEN jsonb_typeof(value)='number' THEN trim_scale((value::text)::numeric)::text
      ELSE lower(normalize(btrim(value#>>'{}'),NFC)) END;
    INSERT INTO application_unique_values(workspace_id,entity_type_id,field_key,normalized_value,entity_instance_id)
      VALUES(NEW.workspace_id,NEW.entity_type_id,property->>'name',normalized,NEW.id);
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION application_capture_generic_record() FROM PUBLIC;
CREATE TRIGGER application_record_capture AFTER INSERT OR UPDATE ON entity_instances
FOR EACH ROW EXECUTE FUNCTION application_capture_generic_record();

CREATE FUNCTION application_capture_generic_schema() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE property jsonb;
BEGIN
  INSERT INTO application_schema_versions(workspace_id,entity_type_id,schema_version,properties)
    VALUES(NEW.workspace_id,NEW.id,NEW.schema_version,NEW.properties) ON CONFLICT DO NOTHING;
  IF TG_OP='INSERT' OR NEW.properties IS NOT DISTINCT FROM OLD.properties THEN RETURN NULL; END IF;
  DELETE FROM application_unique_values WHERE entity_type_id=NEW.id;
  FOR property IN SELECT p FROM jsonb_array_elements(NEW.properties) p WHERE coalesce((p->>'unique')::boolean,false) LOOP
    INSERT INTO application_unique_values(workspace_id,entity_type_id,field_key,normalized_value,entity_instance_id)
      SELECT r.workspace_id,r.entity_type_id,property->>'name',CASE WHEN jsonb_typeof(r.data->(property->>'name')->'value')='number'
        THEN trim_scale((r.data->(property->>'name')->>'value')::numeric)::text
        ELSE lower(normalize(btrim(r.data->(property->>'name')->>'value'),NFC)) END,r.id
      FROM entity_instances r WHERE r.entity_type_id=NEW.id AND r.workspace_id=NEW.workspace_id
        AND r.data->(property->>'name')->'value' IS NOT NULL AND r.data->(property->>'name')->'value' NOT IN ('null'::jsonb,'""'::jsonb);
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION application_capture_generic_schema() FROM PUBLIC;
CREATE TRIGGER application_schema_capture AFTER INSERT OR UPDATE ON entity_types
FOR EACH ROW EXECUTE FUNCTION application_capture_generic_schema();

CREATE TABLE application_operation_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  module_key text NOT NULL,
  operation_key text NOT NULL,
  actor_key text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  resources jsonb NOT NULL CHECK (jsonb_typeof(resources)='array'),
  correlation_key text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,module_key,operation_key,actor_key,idempotency_key)
);
CREATE TABLE application_committed_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES application_operation_receipts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  module_key text NOT NULL,
  event_key text NOT NULL,
  resources jsonb NOT NULL CHECK (jsonb_typeof(resources)='array'),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE application_command_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES application_operation_receipts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  module_key text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE application_command_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_audit_actor ON application_command_audit
  USING (EXISTS(SELECT 1 FROM application_operation_receipts r WHERE r.id=receipt_id AND r.workspace_id=application_command_audit.workspace_id
    AND r.actor_user_id=application_command_audit.actor_user_id AND r.module_key=application_command_audit.module_key AND r.operation_key=application_command_audit.operation_key))
  WITH CHECK (EXISTS(SELECT 1 FROM application_operation_receipts r WHERE r.id=receipt_id AND r.workspace_id=application_command_audit.workspace_id
    AND r.actor_user_id=application_command_audit.actor_user_id AND r.module_key=application_command_audit.module_key AND r.operation_key=application_command_audit.operation_key));

ALTER TABLE application_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_committed_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_receipt_actor ON application_operation_receipts
  USING (actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
    AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=application_operation_receipts.workspace_id AND m.user_id=actor_user_id))
  WITH CHECK (actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
    AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=application_operation_receipts.workspace_id AND m.user_id=actor_user_id));
CREATE POLICY application_event_actor ON application_committed_events
  USING (EXISTS(SELECT 1 FROM application_operation_receipts r WHERE r.id=receipt_id AND r.workspace_id=application_committed_events.workspace_id))
  WITH CHECK (EXISTS(SELECT 1 FROM application_operation_receipts r WHERE r.id=receipt_id AND r.workspace_id=application_committed_events.workspace_id));

CREATE FUNCTION application_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'invalid_value: immutable command evidence' USING ERRCODE='22023'; END;
$$;
CREATE TRIGGER application_receipt_immutable BEFORE UPDATE ON application_operation_receipts
FOR EACH ROW EXECUTE FUNCTION application_receipt_immutable();
CREATE TRIGGER application_audit_immutable BEFORE UPDATE ON application_command_audit
FOR EACH ROW EXECUTE FUNCTION application_receipt_immutable();
CREATE TRIGGER application_event_immutable BEFORE UPDATE ON application_committed_events
FOR EACH ROW EXECUTE FUNCTION application_receipt_immutable();

CREATE TABLE application_schema_change_reviews (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type_id uuid NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_key text NOT NULL,
  expected_schema_version integer NOT NULL,
  proposed_properties jsonb NOT NULL,
  record_set_hash text NOT NULL,
  invalid_records integer NOT NULL CHECK(invalid_records>=0),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
  applied_version integer,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE application_schema_change_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_schema_review_actor ON application_schema_change_reviews
  USING (actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
    AND EXISTS(SELECT 1 FROM entity_types t WHERE t.id=entity_type_id AND t.workspace_id=application_schema_change_reviews.workspace_id))
  WITH CHECK (actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
    AND EXISTS(SELECT 1 FROM entity_types t WHERE t.id=entity_type_id AND t.workspace_id=application_schema_change_reviews.workspace_id));
CREATE FUNCTION application_schema_review_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'applied_version') IS DISTINCT FROM (to_jsonb(OLD)-'applied_version')
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='application_schema_change_reviews'::regclass
      WHERE r.rolname=current_user AND c.relowner=r.oid) THEN
    RAISE EXCEPTION 'invalid_value: immutable schema review' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER application_schema_review_immutable BEFORE UPDATE ON application_schema_change_reviews
FOR EACH ROW EXECUTE FUNCTION application_schema_review_immutable();
CREATE FUNCTION application_finish_schema_review(p_id uuid,p_version integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE application_schema_change_reviews r SET applied_version=p_version
    WHERE r.id=p_id AND r.actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
      AND r.applied_version IS NULL AND r.invalid_records=0 AND r.expires_at>now()
      AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=r.actor_user_id)
      AND EXISTS(SELECT 1 FROM entity_types t WHERE t.id=r.entity_type_id AND t.workspace_id=r.workspace_id
        AND t.properties=r.proposed_properties AND t.schema_version=p_version);
  IF NOT FOUND THEN RAISE EXCEPTION 'schema_version_conflict' USING ERRCODE='22023'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION application_finish_schema_review(uuid,integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='app_user') THEN
    GRANT SELECT ON application_schema_versions,application_record_revisions TO app_user;
    GRANT SELECT,INSERT ON application_operation_receipts,application_command_audit,application_committed_events,application_schema_change_reviews TO app_user;
    GRANT EXECUTE ON FUNCTION application_finish_schema_review(uuid,integer) TO app_user;
  END IF;
END $$;

-- Existing live rows are preserved; no invented history, value rewrite or broader grant.
COMMIT;
