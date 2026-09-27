BEGIN;

ALTER TABLE workspace_groups ADD COLUMN directory_visibility text NOT NULL DEFAULT 'workspace'
  CHECK (directory_visibility IN ('members','workspace'));
ALTER TABLE workspace_groups ALTER COLUMN directory_visibility SET DEFAULT 'members';
ALTER TABLE workspace_groups ADD COLUMN requestable boolean NOT NULL DEFAULT false;

CREATE TABLE workspace_team_managers (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES workspace_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capabilities text[] NOT NULL CHECK (capabilities <@ ARRAY['manage_members','approve_read_requests']::text[]),
  granted_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id,team_id,user_id)
);

CREATE TABLE workspace_org_state (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1
);
CREATE TABLE workspace_org_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  position integer NOT NULL DEFAULT 0,
  team_id uuid REFERENCES workspace_groups(id) ON DELETE RESTRICT,
  directory_visibility text NOT NULL DEFAULT 'members' CHECK (directory_visibility IN ('members','workspace')),
  archived_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,team_id),
  FOREIGN KEY(workspace_id,parent_id) REFERENCES workspace_org_units(workspace_id,id),
  CHECK (parent_id IS DISTINCT FROM id)
);
CREATE INDEX workspace_org_units_parent ON workspace_org_units(workspace_id,parent_id);
CREATE TABLE workspace_org_placements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  assistant_id uuid REFERENCES assistants(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT true,
  reports_to_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  accountable_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  version bigint NOT NULL DEFAULT 1,
  FOREIGN KEY(workspace_id,unit_id) REFERENCES workspace_org_units(workspace_id,id),
  CHECK ((user_id IS NULL) <> (assistant_id IS NULL)),
  CHECK (reports_to_user_id IS NULL OR user_id IS DISTINCT FROM reports_to_user_id),
  CHECK (reports_to_user_id IS NULL OR (user_id IS NOT NULL AND is_primary)),
  CHECK (accountable_user_id IS NULL OR (assistant_id IS NOT NULL AND is_primary))
);
CREATE UNIQUE INDEX workspace_org_primary_member ON workspace_org_placements(workspace_id,user_id) WHERE is_primary;
CREATE UNIQUE INDEX workspace_org_primary_assistant ON workspace_org_placements(workspace_id,assistant_id) WHERE is_primary;
CREATE UNIQUE INDEX workspace_org_member_unit ON workspace_org_placements(workspace_id,unit_id,user_id);
CREATE UNIQUE INDEX workspace_org_assistant_unit ON workspace_org_placements(workspace_id,unit_id,assistant_id);

CREATE TABLE workspace_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL,
  subject_id uuid,
  policy_revision bigint NOT NULL,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_access_events_timeline ON workspace_access_events(workspace_id,created_at DESC,id);

-- Serialize graph edits even if a writer bypasses the application service.
CREATE FUNCTION validate_workspace_organization() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE has_cycle boolean;
BEGIN
  IF TG_OP='UPDATE' AND OLD.workspace_id<>NEW.workspace_id THEN
    RAISE EXCEPTION 'organization_workspace_mismatch';
  END IF;
  PERFORM 1 FROM workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  -- A real row update makes stale REPEATABLE READ writers serialize-fail too;
  -- an advisory/row lock alone cannot refresh their already established snapshot.
  INSERT INTO workspace_org_state(workspace_id) VALUES(NEW.workspace_id)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=workspace_org_state.revision;
  IF TG_TABLE_NAME='workspace_team_managers' THEN
    IF NOT EXISTS (SELECT 1 FROM workspace_groups WHERE id=NEW.team_id AND workspace_id=NEW.workspace_id AND kind='team' AND status='active')
      OR NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id)
      OR NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.granted_by AND role IN ('owner','admin')) THEN
      RAISE EXCEPTION 'organization_reference_invalid';
    END IF;
  ELSIF TG_TABLE_NAME='workspace_org_units' THEN
    IF NEW.team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_groups WHERE id=NEW.team_id AND workspace_id=NEW.workspace_id AND kind='team' AND status='active') THEN
      RAISE EXCEPTION 'organization_reference_invalid';
    END IF;
    IF NEW.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_org_units WHERE id=NEW.parent_id AND workspace_id=NEW.workspace_id AND archived_at IS NULL) THEN
      RAISE EXCEPTION 'organization_reference_invalid';
    END IF;
    WITH RECURSIVE ancestors AS (
      SELECT id,parent_id FROM workspace_org_units WHERE id=NEW.parent_id AND workspace_id=NEW.workspace_id
      UNION
      SELECT u.id,u.parent_id FROM workspace_org_units u JOIN ancestors a ON u.id=a.parent_id WHERE u.workspace_id=NEW.workspace_id
    ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=NEW.id) INTO has_cycle;
    IF has_cycle THEN RAISE EXCEPTION 'organization_cycle'; END IF;
    IF NEW.archived_at IS NOT NULL AND (
      EXISTS(SELECT 1 FROM workspace_org_units WHERE parent_id=NEW.id AND archived_at IS NULL)
      OR EXISTS(SELECT 1 FROM workspace_org_placements WHERE unit_id=NEW.id)
    ) THEN RAISE EXCEPTION 'organization_move_required'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM workspace_org_units WHERE id=NEW.unit_id AND workspace_id=NEW.workspace_id AND archived_at IS NULL)
      OR (NEW.user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id))
      OR (NEW.assistant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assistants WHERE workspace_id=NEW.workspace_id AND id=NEW.assistant_id))
      OR (NEW.reports_to_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.reports_to_user_id))
      OR (NEW.accountable_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.accountable_user_id)) THEN
      RAISE EXCEPTION 'organization_reference_invalid';
    END IF;
    IF NEW.is_primary AND NEW.user_id IS NOT NULL THEN
      WITH RECURSIVE managers AS (
        SELECT NEW.reports_to_user_id AS user_id
        UNION
        SELECT p.reports_to_user_id FROM workspace_org_placements p JOIN managers m ON p.user_id=m.user_id
          WHERE p.workspace_id=NEW.workspace_id AND p.is_primary AND p.id<>NEW.id AND p.reports_to_user_id IS NOT NULL
      ) SELECT EXISTS(SELECT 1 FROM managers WHERE user_id=NEW.user_id) INTO has_cycle;
      IF has_cycle THEN RAISE EXCEPTION 'organization_cycle'; END IF;
    END IF;
  END IF;
  IF TG_TABLE_NAME IN ('workspace_org_units','workspace_org_placements') THEN
    IF TG_OP='UPDATE' THEN NEW.version=OLD.version+1; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_team_managers_validate BEFORE INSERT OR UPDATE ON workspace_team_managers FOR EACH ROW EXECUTE FUNCTION validate_workspace_organization();
CREATE TRIGGER workspace_org_units_validate BEFORE INSERT OR UPDATE ON workspace_org_units FOR EACH ROW EXECUTE FUNCTION validate_workspace_organization();
CREATE TRIGGER workspace_org_placements_validate BEFORE INSERT OR UPDATE ON workspace_org_placements FOR EACH ROW EXECUTE FUNCTION validate_workspace_organization();

CREATE FUNCTION can_view_department_directory(p_workspace_id uuid,p_team_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE viewer uuid; reach text[];
BEGIN
  IF current_setting('app.system_bypass',true)='true' THEN RETURN true; END IF;
  viewer=nullif(current_setting('app.current_user_id',true),'')::uuid;
  IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=p_workspace_id AND user_id=viewer) THEN RETURN false; END IF;
  -- INSERT ... RETURNING evaluates SELECT policies before the inserted group
  -- is query-visible to a STABLE helper. Administrative authority is independent
  -- of group visibility and must not query the not-yet-visible group row.
  IF EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=p_workspace_id AND user_id=viewer AND role IN ('owner','admin')) THEN RETURN true; END IF;
  reach=effective_member_team_compartments(viewer,p_workspace_id);
  RETURN EXISTS(SELECT 1 FROM workspace_groups g WHERE g.id=p_team_id AND g.workspace_id=p_workspace_id AND (
    g.kind<>'team' OR g.directory_visibility='workspace' OR reach IS NULL OR g.compartment_key=ANY(reach)
    OR EXISTS(SELECT 1 FROM workspace_team_managers m WHERE m.workspace_id=p_workspace_id AND m.team_id=p_team_id AND m.user_id=viewer AND m.revoked_at IS NULL)
  ));
END;
$$;
CREATE POLICY workspace_groups_directory ON workspace_groups AS RESTRICTIVE FOR SELECT
  USING (can_view_department_directory(workspace_id,id));
CREATE POLICY workspace_compartments_directory ON workspace_compartments AS RESTRICTIVE FOR SELECT
  USING (managed_by IS DISTINCT FROM 'team' OR can_view_department_directory(workspace_id,managed_ref_id));

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['workspace_team_managers','workspace_org_state','workspace_org_units','workspace_org_placements','workspace_access_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY organization_admin_read ON %I FOR SELECT USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=nullif(current_setting(''app.current_user_id'',true),'''')::uuid AND role IN (''owner'',''admin'')))',table_name);
    EXECUTE format('CREATE POLICY organization_system ON %I FOR ALL USING (current_setting(''app.system_bypass'',true)=''true'') WITH CHECK (current_setting(''app.system_bypass'',true)=''true'')',table_name);
  END LOOP;
END $$;
COMMIT;
