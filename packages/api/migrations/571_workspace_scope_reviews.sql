BEGIN;

CREATE TABLE workspace_scope_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resource_kind text NOT NULL CHECK(scope_source_table(resource_kind) IS NOT NULL),
  action text NOT NULL CHECK(action IN('confirm_general','assign_team','hold')),
  target_team_id uuid,
  target_compartment text,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  policy_revision bigint NOT NULL CHECK(policy_revision>0),
  selection_revision bigint NOT NULL CHECK(selection_revision>0),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  status text NOT NULL DEFAULT 'preview' CHECK(status IN('preview','running','complete','stale','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  CHECK((action='assign_team' AND target_team_id IS NOT NULL AND target_compartment IS NOT NULL)
    OR(action<>'assign_team' AND target_team_id IS NULL AND target_compartment IS NULL))
);
CREATE INDEX workspace_scope_reviews_history ON workspace_scope_reviews(workspace_id,created_at DESC,id);

CREATE TABLE workspace_scope_review_items (
  workspace_id uuid NOT NULL,
  review_id uuid NOT NULL,
  resource_kind text NOT NULL,
  resource_id uuid NOT NULL,
  resource_version text NOT NULL,
  source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','applied','stale','cancelled')),
  result_version text,
  error_code text,
  PRIMARY KEY(review_id,resource_kind,resource_id),
  FOREIGN KEY(workspace_id,review_id) REFERENCES workspace_scope_reviews(workspace_id,id) ON DELETE CASCADE,
  CHECK((status='applied')=(result_version IS NOT NULL))
);
CREATE INDEX workspace_scope_review_items_pending ON workspace_scope_review_items(review_id,status,resource_id);

CREATE FUNCTION guard_scope_review_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.action='assign_team' AND NOT EXISTS(SELECT 1 FROM workspace_groups WHERE id=NEW.target_team_id AND workspace_id=NEW.workspace_id AND kind='team' AND status='active' AND compartment_key=NEW.target_compartment) THEN
      RAISE EXCEPTION 'scope_review_reference_invalid';
    END IF;
  ELSIF ROW(NEW.workspace_id,NEW.resource_kind,NEW.action,NEW.target_team_id,NEW.target_compartment,NEW.reason,NEW.payload_hash,NEW.selection_revision)
    IS DISTINCT FROM ROW(OLD.workspace_id,OLD.resource_kind,OLD.action,OLD.target_team_id,OLD.target_compartment,OLD.reason,OLD.payload_hash,OLD.selection_revision) THEN
    RAISE EXCEPTION 'scope_review_proposal_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_scope_review_immutable BEFORE INSERT OR UPDATE ON workspace_scope_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_scope_review_proposal();

CREATE FUNCTION guard_scope_review_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE snapshot jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.workspace_id,NEW.review_id,NEW.resource_kind,NEW.resource_id,NEW.resource_version,NEW.source_snapshot)
      IS DISTINCT FROM ROW(OLD.workspace_id,OLD.review_id,OLD.resource_kind,OLD.resource_id,OLD.resource_version,OLD.source_snapshot) THEN
      RAISE EXCEPTION 'scope_review_proposal_immutable';
    END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM workspace_scope_reviews WHERE id=NEW.review_id AND workspace_id=NEW.workspace_id AND resource_kind=NEW.resource_kind AND status='preview') THEN
      RAISE EXCEPTION 'scope_review_reference_invalid';
    END IF;
    snapshot=read_scope_source(NEW.workspace_id,NEW.resource_kind,NEW.resource_id);
    IF snapshot IS NULL OR snapshot->>'version' IS DISTINCT FROM NEW.resource_version OR snapshot IS DISTINCT FROM NEW.source_snapshot THEN
      RAISE EXCEPTION 'scope_source_changed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_scope_review_item_guard BEFORE INSERT OR UPDATE ON workspace_scope_review_items
  FOR EACH ROW EXECUTE FUNCTION guard_scope_review_item();

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['workspace_scope_reviews','workspace_scope_review_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING(workspace_id IN(SELECT workspace_id FROM workspace_members WHERE user_id=nullif(current_setting(''app.current_user_id'',true),'''')::uuid AND role IN(''owner'',''admin'')))',tab||'_admin_read',tab);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING(current_setting(''app.system_bypass'',true)=''true'') WITH CHECK(current_setting(''app.system_bypass'',true)=''true'')',tab||'_system',tab);
  END LOOP;
END $$;

COMMIT;
