-- Departmental derivation foundation. No grants or strict activation are enabled.
-- Spec: docs/architecture/context-engine/scoped-context.md.
BEGIN;

CREATE TABLE workspace_access_policies (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  classification_mode text NOT NULL DEFAULT 'legacy' CHECK (classification_mode IN ('legacy','review','strict')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  required_enforcement_version integer NOT NULL DEFAULT 2 CHECK (required_enforcement_version >= 2),
  reviewed_inventory_revision bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE memories
  ADD COLUMN scope_version bigint NOT NULL DEFAULT 1 CHECK (scope_version > 0),
  ADD COLUMN scope_held boolean NOT NULL DEFAULT false;
ALTER TABLE memories_shadow
  ADD COLUMN scope_version bigint NOT NULL DEFAULT 1,
  ADD COLUMN scope_held boolean NOT NULL DEFAULT false;

CREATE TABLE scope_resource_states (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_kind text NOT NULL CHECK (resource_kind = 'memory'),
  resource_id uuid NOT NULL,
  resource_version text NOT NULL CHECK (length(resource_version) > 0),
  review_state text NOT NULL CHECK (review_state IN ('needs_review','reviewed','held')),
  classification_revision bigint NOT NULL CHECK (classification_revision > 0),
  holding_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, resource_kind, resource_id, resource_version),
  CHECK (review_state <> 'held' OR length(btrim(holding_reason)) > 0)
);

CREATE TABLE scope_derivations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_kind text NOT NULL CHECK (resource_kind = 'memory'),
  resource_id uuid NOT NULL,
  resource_version text NOT NULL CHECK (length(resource_version) > 0),
  producer text NOT NULL CHECK (length(btrim(producer)) > 0),
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  assistant_id uuid REFERENCES assistants(id) ON DELETE RESTRICT,
  sensitivity text NOT NULL CHECK (sensitivity IN ('public','internal','confidential')),
  compartments text[] NOT NULL,
  project_ids uuid[] NOT NULL,
  source_policy_revision bigint NOT NULL CHECK (source_policy_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,id),
  UNIQUE (workspace_id,resource_kind,resource_id,resource_version)
);
CREATE TABLE scope_derivation_sources (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  derivation_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind = 'memory'),
  source_id uuid NOT NULL,
  source_version text NOT NULL CHECK (length(source_version) > 0),
  PRIMARY KEY (derivation_id,source_kind,source_id),
  FOREIGN KEY (workspace_id,derivation_id) REFERENCES scope_derivations(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX scope_derivation_sources_reverse ON scope_derivation_sources(workspace_id,source_kind,source_id);
CREATE INDEX scope_resource_states_review ON scope_resource_states(workspace_id,review_state,resource_id);

-- Validate polymorphic references on both inserts and updates. Kinds are a
-- deliberately closed registry; adding another primitive requires its validator.
CREATE FUNCTION validate_scope_resource_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE source_row memories; expected_id uuid; expected_version text;
BEGIN
  IF TG_TABLE_NAME = 'scope_derivation_sources' THEN
    expected_id := NEW.source_id; expected_version := NEW.source_version;
  ELSE
    expected_id := NEW.resource_id; expected_version := NEW.resource_version;
  END IF;
  SELECT * INTO source_row FROM memories WHERE id = expected_id FOR SHARE;
  IF source_row.id IS NULL OR source_row.workspace_id <> NEW.workspace_id
     OR source_row.scope_version::text <> expected_version THEN
    RAISE EXCEPTION 'scope_source_changed';
  END IF;
  IF TG_TABLE_NAME = 'scope_derivations' THEN
   IF (
    NEW.user_id IS DISTINCT FROM source_row.user_id OR
    NEW.assistant_id IS DISTINCT FROM source_row.assistant_id OR
    NEW.sensitivity <> source_row.sensitivity OR
    NOT (NEW.compartments @> source_row.compartments AND NEW.compartments <@ source_row.compartments) OR
    NOT (NEW.project_ids @> source_row.project_ids AND NEW.project_ids <@ source_row.project_ids)
   ) THEN RAISE EXCEPTION 'scope_envelope_mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scope_derivations_reference BEFORE INSERT OR UPDATE ON scope_derivations
  FOR EACH ROW EXECUTE FUNCTION validate_scope_resource_reference();
CREATE TRIGGER scope_derivation_sources_reference BEFORE INSERT OR UPDATE ON scope_derivation_sources
  FOR EACH ROW EXECUTE FUNCTION validate_scope_resource_reference();
CREATE TRIGGER scope_resource_states_reference BEFORE INSERT OR UPDATE ON scope_resource_states
  FOR EACH ROW EXECUTE FUNCTION validate_scope_resource_reference();

CREATE FUNCTION hold_scope_descendants(target_workspace uuid, target_kind text, target_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE affected uuid[]; policy_revision bigint;
BEGIN
  WITH RECURSIVE ancestry(id) AS (
    SELECT target_id
    UNION
    SELECT m.id FROM memories m JOIN ancestry a ON m.superseded_by = a.id
      WHERE m.workspace_id = target_workspace AND target_kind = 'memory'
  ), descendants(kind,id) AS (
    SELECT d.resource_kind,d.resource_id
      FROM scope_derivation_sources s JOIN scope_derivations d
        ON d.id = s.derivation_id AND d.workspace_id = s.workspace_id
      WHERE s.workspace_id = target_workspace AND s.source_kind = target_kind AND s.source_id IN (SELECT id FROM ancestry)
    UNION
    SELECT d.resource_kind,d.resource_id
      FROM descendants p JOIN scope_derivation_sources s
        ON s.source_kind = p.kind AND s.source_id = p.id AND s.workspace_id = target_workspace
      JOIN scope_derivations d ON d.id = s.derivation_id AND d.workspace_id = s.workspace_id
  ) SELECT array_agg(id) INTO affected FROM descendants WHERE kind = 'memory';
  INSERT INTO workspace_access_policies(workspace_id,revision) VALUES(target_workspace,2)
    ON CONFLICT(workspace_id) DO UPDATE SET revision = workspace_access_policies.revision + 1, updated_at = now()
    RETURNING revision INTO policy_revision;
  IF affected IS NULL THEN RETURN; END IF;
  UPDATE memories SET scope_held = true WHERE workspace_id = target_workspace AND id = ANY(affected);
  INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
    SELECT workspace_id,'memory',id,scope_version::text,'held',policy_revision,'source_changed'
      FROM memories WHERE workspace_id = target_workspace AND id = ANY(affected)
    ON CONFLICT(workspace_id,resource_kind,resource_id,resource_version)
    DO UPDATE SET review_state = 'held',classification_revision = EXCLUDED.classification_revision,
      holding_reason = 'source_changed',updated_at = now();
END;
$$;
-- Not a member-callable function: only canonical system transactions invalidate.
REVOKE ALL ON FUNCTION hold_scope_descendants(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION advance_memory_scope_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
      PERFORM hold_scope_descendants(OLD.workspace_id,'memory',OLD.id);
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.workspace_id,NEW.user_id,NEW.assistant_id,NEW.summary,NEW.detail,NEW.tags,
         NEW.sensitivity,NEW.compartments,NEW.project_ids,NEW.retracted_at)
    IS DISTINCT FROM
     ROW(OLD.workspace_id,OLD.user_id,OLD.assistant_id,OLD.summary,OLD.detail,OLD.tags,
         OLD.sensitivity,OLD.compartments,OLD.project_ids,OLD.retracted_at) THEN
    NEW.scope_version := OLD.scope_version + 1;
    PERFORM hold_scope_descendants(OLD.workspace_id,'memory',OLD.id);
  ELSE
    NEW.scope_version := OLD.scope_version;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memories_scope_version BEFORE UPDATE OR DELETE ON memories
  FOR EACH ROW EXECUTE FUNCTION advance_memory_scope_version();

-- A wildcard audience cannot turn a held memory into ordinary model context.
CREATE POLICY memories_scope_holding ON memories AS RESTRICTIVE FOR SELECT USING (NOT scope_held);

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['workspace_access_policies','scope_resource_states','scope_derivations','scope_derivation_sources'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = nullif(current_setting(''app.current_user_id'',true),'''')::uuid AND role IN (''owner'',''admin'')))',tab || '_admin_read',tab);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (current_setting(''app.system_bypass'',true) = ''true'') WITH CHECK (current_setting(''app.system_bypass'',true) = ''true'')',tab || '_system',tab);
  END LOOP;
END $$;
COMMIT;
