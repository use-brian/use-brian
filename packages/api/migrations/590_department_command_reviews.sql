BEGIN;

CREATE TABLE workspace_access_command_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
  command jsonb NOT NULL CHECK(jsonb_typeof(command)='object'),
  policy_revision bigint NOT NULL CHECK(policy_revision>0),
  changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='array'),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK(expires_at>created_at),
  status text NOT NULL DEFAULT 'preview' CHECK(status IN('preview','applied')),
  applied_at timestamptz,
  receipt jsonb,
  UNIQUE(workspace_id,actor_user_id,idempotency_key),
  CHECK((status='applied')=(applied_at IS NOT NULL AND receipt IS NOT NULL)),
  CHECK(receipt IS NULL OR jsonb_typeof(receipt)='object')
);
CREATE INDEX workspace_access_command_reviews_actor ON workspace_access_command_reviews(workspace_id,actor_user_id,created_at DESC);

CREATE FUNCTION guard_department_command_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'preview' OR NEW.applied_at IS NOT NULL OR NEW.receipt IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.actor_user_id) THEN
      RAISE EXCEPTION 'access_review_reference_invalid';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['status','applied_at','receipt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','applied_at','receipt'])
      OR OLD.status<>'preview' OR NEW.status<>'applied' OR NEW.applied_at IS NULL OR NEW.receipt IS NULL THEN
      RAISE EXCEPTION 'access_review_immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_access_command_review_guard BEFORE INSERT OR UPDATE ON workspace_access_command_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_department_command_review();
ALTER TABLE workspace_access_command_reviews ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION can_read_department_command_review(review_workspace uuid,review_actor uuid,review_revision bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT review_actor=nullif(current_setting('app.current_user_id',true),'')::uuid
    AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=review_workspace AND user_id=review_actor)
    AND EXISTS(SELECT 1 FROM workspace_access_policies WHERE workspace_id=review_workspace AND revision=review_revision);
$$;
CREATE POLICY workspace_access_command_review_actor ON workspace_access_command_reviews FOR SELECT USING (
  can_read_department_command_review(workspace_id,actor_user_id,policy_revision)
);
CREATE POLICY workspace_access_command_review_system ON workspace_access_command_reviews FOR ALL
  USING(current_setting('app.system_bypass',true)='true') WITH CHECK(current_setting('app.system_bypass',true)='true');

COMMIT;
