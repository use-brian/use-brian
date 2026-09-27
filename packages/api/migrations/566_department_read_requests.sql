BEGIN;
CREATE TABLE workspace_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requester_user_id uuid NOT NULL REFERENCES users(id),
  beneficiary_kind text NOT NULL CHECK (beneficiary_kind IN ('member','team')),
  beneficiary_id uuid NOT NULL,
  target_team_id uuid NOT NULL REFERENCES workspace_groups(id),
  operation text NOT NULL DEFAULT 'read' CHECK (operation='read'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  request_expires_at timestamptz NOT NULL DEFAULT (now()+interval '14 days'),
  version bigint NOT NULL DEFAULT 1 CHECK (version=1),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  policy_revision bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled','expired','superseded')),
  approval_id uuid UNIQUE REFERENCES pending_approvals(id),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_reason text CHECK (length(decision_reason)<=1000),
  UNIQUE(workspace_id,id),
  CHECK (expires_at IS NULL OR expires_at>starts_at),
  CHECK (status<>'approved' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (request_expires_at>created_at AND request_expires_at<=created_at+interval '14 days')
);
CREATE INDEX workspace_access_requests_queue ON workspace_access_requests(workspace_id,status,created_at DESC);
CREATE TABLE workspace_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id uuid NOT NULL UNIQUE,
  beneficiary_kind text NOT NULL CHECK (beneficiary_kind IN ('member','team')),
  beneficiary_id uuid NOT NULL,
  target_team_id uuid NOT NULL REFERENCES workspace_groups(id),
  operation text NOT NULL DEFAULT 'read' CHECK (operation='read'),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz,
  approved_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  revocation_reason text CHECK (length(revocation_reason)<=1000),
  FOREIGN KEY(workspace_id,request_id) REFERENCES workspace_access_requests(workspace_id,id),
  CHECK (expires_at IS NULL OR expires_at>starts_at),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX workspace_access_grants_resolution ON workspace_access_grants(workspace_id,beneficiary_kind,beneficiary_id,expires_at) WHERE revoked_at IS NULL;
CREATE INDEX workspace_access_grants_target ON workspace_access_grants(workspace_id,target_team_id) WHERE revoked_at IS NULL;

CREATE FUNCTION validate_department_read_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source_request workspace_access_requests%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.workspace_id,NEW.beneficiary_kind,NEW.beneficiary_id,NEW.target_team_id,NEW.operation,NEW.starts_at,NEW.expires_at)
      IS DISTINCT FROM ROW(OLD.workspace_id,OLD.beneficiary_kind,OLD.beneficiary_id,OLD.target_team_id,OLD.operation,OLD.starts_at,OLD.expires_at) THEN
      RAISE EXCEPTION 'access_payload_immutable';
    END IF;
    IF TG_TABLE_NAME='workspace_access_requests' THEN
      IF ROW(NEW.requester_user_id,NEW.reason,NEW.created_at,NEW.request_expires_at,NEW.version,NEW.payload_hash,NEW.policy_revision)
        IS DISTINCT FROM ROW(OLD.requester_user_id,OLD.reason,OLD.created_at,OLD.request_expires_at,OLD.version,OLD.payload_hash,OLD.policy_revision) THEN
        RAISE EXCEPTION 'access_payload_immutable';
      END IF;
      IF OLD.status<>'pending' AND ROW(NEW.status,NEW.decided_by,NEW.decided_at,NEW.decision_reason,NEW.approval_id)
        IS DISTINCT FROM ROW(OLD.status,OLD.decided_by,OLD.decided_at,OLD.decision_reason,OLD.approval_id) THEN RAISE EXCEPTION 'access_decision_immutable'; END IF;
    ELSE
      IF ROW(NEW.request_id,NEW.approved_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.request_id,OLD.approved_by,OLD.created_at) THEN RAISE EXCEPTION 'access_payload_immutable'; END IF;
      IF OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at,NEW.revoked_by,NEW.revocation_reason) IS DISTINCT FROM ROW(OLD.revoked_at,OLD.revoked_by,OLD.revocation_reason) THEN RAISE EXCEPTION 'access_revocation_immutable'; END IF;
    END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM workspace_groups WHERE id=NEW.target_team_id AND workspace_id=NEW.workspace_id AND kind='team' AND status='active')
      OR (NEW.beneficiary_kind='member' AND NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.beneficiary_id))
      OR (NEW.beneficiary_kind='team' AND NOT EXISTS(SELECT 1 FROM workspace_groups WHERE id=NEW.beneficiary_id AND workspace_id=NEW.workspace_id AND kind='team' AND status='active')) THEN
      RAISE EXCEPTION 'access_reference_invalid';
    END IF;
    IF TG_TABLE_NAME='workspace_access_requests' THEN
      IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.requester_user_id) THEN RAISE EXCEPTION 'access_reference_invalid'; END IF;
    ELSE
      SELECT * INTO source_request FROM workspace_access_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id FOR SHARE;
      IF NOT FOUND OR source_request.status<>'approved'
        OR ROW(NEW.beneficiary_kind,NEW.beneficiary_id,NEW.target_team_id,NEW.starts_at,NEW.expires_at,NEW.approved_by)
          IS DISTINCT FROM ROW(source_request.beneficiary_kind,source_request.beneficiary_id,source_request.target_team_id,source_request.starts_at,source_request.expires_at,source_request.decided_by)
        OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.approved_by) THEN
        RAISE EXCEPTION 'access_reference_invalid';
      END IF;
      IF NEW.approved_by=source_request.requester_user_id
        OR (NEW.beneficiary_kind='member' AND NEW.approved_by=NEW.beneficiary_id)
        OR (NEW.beneficiary_kind='team' AND EXISTS(SELECT 1 FROM workspace_group_members WHERE group_id=NEW.beneficiary_id AND user_id=NEW.approved_by)) THEN
        RAISE EXCEPTION 'independent_approver_required';
      END IF;
    END IF;
  END IF;
  IF TG_TABLE_NAME='workspace_access_requests' THEN
    IF NEW.approval_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pending_approvals WHERE id=NEW.approval_id AND workspace_id=NEW.workspace_id AND kind='department_access' AND approval_payload->>'requestId'=NEW.id::text AND approval_payload->>'payloadHash'=NEW.payload_hash AND approval_payload->>'requestVersion'=NEW.version::text) THEN RAISE EXCEPTION 'access_reference_invalid'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_access_requests_validate BEFORE INSERT OR UPDATE ON workspace_access_requests FOR EACH ROW EXECUTE FUNCTION validate_department_read_record();
CREATE TRIGGER workspace_access_grants_validate BEFORE INSERT OR UPDATE ON workspace_access_grants FOR EACH ROW EXECUTE FUNCTION validate_department_read_record();

-- Existing membership reach remains the MUTATION envelope. This separate READ
-- function grants only target compartments, never another Team's read bundle.
CREATE FUNCTION effective_member_read_compartments(p_user_id uuid,p_workspace_id uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE base text[]; result text[];
BEGIN
  IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=p_workspace_id AND user_id=p_user_id) THEN RETURN ARRAY[]::text[]; END IF;
  base=effective_member_team_compartments(p_user_id,p_workspace_id);
  IF base IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(array_agg(DISTINCT key ORDER BY key),ARRAY[]::text[]) INTO result FROM (
    SELECT unnest(base) AS key
    UNION
    SELECT target.compartment_key FROM workspace_access_grants grant_row
      JOIN workspace_groups target ON target.id=grant_row.target_team_id AND target.workspace_id=grant_row.workspace_id AND target.status='active'
      WHERE grant_row.workspace_id=p_workspace_id AND grant_row.revoked_at IS NULL
        AND grant_row.starts_at<=now() AND (grant_row.expires_at IS NULL OR grant_row.expires_at>now())
        AND ((grant_row.beneficiary_kind='member' AND grant_row.beneficiary_id=p_user_id)
          OR (grant_row.beneficiary_kind='team' AND EXISTS(
            SELECT 1 FROM workspace_group_members gm JOIN workspace_groups beneficiary ON beneficiary.id=gm.group_id
             WHERE gm.group_id=grant_row.beneficiary_id AND gm.user_id=p_user_id AND beneficiary.workspace_id=p_workspace_id AND beneficiary.status='active'
          )))
  ) keys;
  RETURN result;
END;
$$;

ALTER TABLE workspace_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_access_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY access_requests_system ON workspace_access_requests FOR ALL USING(current_setting('app.system_bypass',true)='true') WITH CHECK(current_setting('app.system_bypass',true)='true');
CREATE POLICY access_grants_system ON workspace_access_grants FOR ALL USING(current_setting('app.system_bypass',true)='true') WITH CHECK(current_setting('app.system_bypass',true)='true');
-- Member-facing reads use the canonical service's safe projection. Raw metadata
-- is restricted to administrators, including approval reasons and beneficiaries.
CREATE POLICY access_requests_admin ON workspace_access_requests FOR SELECT USING(workspace_id IN(SELECT workspace_id FROM workspace_members WHERE user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND role IN('owner','admin')));
CREATE POLICY access_grants_admin ON workspace_access_grants FOR SELECT USING(workspace_id IN(SELECT workspace_id FROM workspace_members WHERE user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND role IN('owner','admin')));

-- Authority changes through existing routes and raw writes share the same lock
-- and revision as a request decision. The notification contains no directory data.
CREATE FUNCTION advance_workspace_access_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target_workspace uuid; row_json jsonb;
BEGIN
  row_json=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME IN ('workspace_group_members','workspace_group_compartment_grants','workspace_group_assistants') THEN
    SELECT workspace_id INTO target_workspace FROM workspace_groups WHERE id=(row_json->>'group_id')::uuid;
  ELSE target_workspace=(row_json->>'workspace_id')::uuid;
  END IF;
  IF target_workspace IS NOT NULL AND EXISTS(SELECT 1 FROM workspaces WHERE id=target_workspace) THEN
    PERFORM 1 FROM workspaces WHERE id=target_workspace FOR UPDATE;
    INSERT INTO workspace_access_policies(workspace_id) VALUES(target_workspace)
      ON CONFLICT(workspace_id) DO UPDATE SET revision=workspace_access_policies.revision+1;
    PERFORM pg_notify('brain_events',json_build_object('workspaceId',target_workspace,'primitive','workspace_config','action','update')::text);
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['workspace_members','workspace_groups','workspace_group_members','workspace_group_compartment_grants','workspace_group_assistants','workspace_team_managers','workspace_access_grants'] LOOP
    EXECUTE format('CREATE TRIGGER workspace_access_revision BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION advance_workspace_access_policy()',table_name);
  END LOOP;
END $$;
-- The shared queue must not expose departmental reasons or beneficiaries to
-- every workspace member. Membership and delegated authority are checked live.
CREATE FUNCTION can_view_department_request(p_request_id uuid,p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM workspace_access_requests r
    JOIN workspace_members m ON m.workspace_id=r.workspace_id AND m.user_id=p_user_id
    WHERE r.id=p_request_id AND (m.role IN('owner','admin') OR r.requester_user_id=p_user_id
      OR (r.beneficiary_kind='member' AND r.beneficiary_id=p_user_id)
      OR (r.beneficiary_kind='team' AND EXISTS(SELECT 1 FROM workspace_group_members gm WHERE gm.group_id=r.beneficiary_id AND gm.user_id=p_user_id))
      OR EXISTS(SELECT 1 FROM workspace_team_managers manager WHERE manager.workspace_id=r.workspace_id AND manager.team_id=r.target_team_id AND manager.user_id=p_user_id AND manager.revoked_at IS NULL AND 'approve_read_requests'=ANY(manager.capabilities))))
$$;
CREATE POLICY department_approval_privacy ON pending_approvals AS RESTRICTIVE FOR SELECT
USING(kind<>'department_access' OR current_setting('app.system_bypass',true)='true'
  OR can_view_department_request(nullif(approval_payload->>'requestId','')::uuid,nullif(current_setting('app.current_user_id',true),'')::uuid));
CREATE OR REPLACE FUNCTION can_view_department_directory(p_workspace_id uuid,p_team_id uuid) RETURNS boolean
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
  reach=effective_member_read_compartments(viewer,p_workspace_id);
  RETURN EXISTS(SELECT 1 FROM workspace_groups g WHERE g.id=p_team_id AND g.workspace_id=p_workspace_id AND (
    g.kind<>'team' OR g.directory_visibility='workspace' OR reach IS NULL OR g.compartment_key=ANY(reach)
    OR EXISTS(SELECT 1 FROM workspace_team_managers m WHERE m.workspace_id=p_workspace_id AND m.team_id=p_team_id AND m.user_id=viewer AND m.revoked_at IS NULL)
  ));
END;
$$;
COMMIT;
