BEGIN;

ALTER TABLE crm_activities
  ADD COLUMN user_id uuid,
  ADD COLUMN assistant_id uuid,
  ADD COLUMN sensitivity text NOT NULL DEFAULT 'internal' CHECK(sensitivity IN('public','internal','confidential')),
  ADD COLUMN compartments text[] NOT NULL DEFAULT '{}',
  ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN source_scope_version bigint NOT NULL DEFAULT 1 CHECK(source_scope_version>0),
  ADD COLUMN scope_origin text NOT NULL DEFAULT 'legacy' CHECK(scope_origin IN('legacy','captured')),
  ADD COLUMN scope_held boolean NOT NULL DEFAULT false;

-- A present source floor is useful protection, never evidence of the original
-- audience. Keep the legacy marker until an explicit history review exists.
UPDATE crm_activities a SET user_id=e.user_id,assistant_id=e.assistant_id,
  sensitivity=e.sensitivity,compartments=e.compartments,project_ids=e.project_ids,
  source_scope_version=e.scope_version,
  scope_held=e.scope_held OR e.valid_to IS NOT NULL OR e.retracted_at IS NOT NULL
    OR e.kind NOT IN('person','company','deal')
FROM entities e WHERE e.workspace_id=a.workspace_id AND e.id=a.entity_id;
ALTER TABLE crm_activities ALTER COLUMN scope_origin SET DEFAULT 'captured';

CREATE FUNCTION guard_crm_activity_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source entities;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT * INTO source FROM entities WHERE workspace_id=NEW.workspace_id
      AND id=NEW.entity_id AND kind IN('person','company','deal')
      AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held FOR SHARE;
    IF source.id IS NULL THEN RAISE EXCEPTION 'activity_source_unavailable' USING ERRCODE='23503'; END IF;
    NEW.user_id=source.user_id; NEW.assistant_id=source.assistant_id;
    NEW.sensitivity=source.sensitivity; NEW.compartments=source.compartments;
    NEW.project_ids=source.project_ids; NEW.source_scope_version=source.scope_version;
    NEW.scope_origin='captured'; NEW.scope_held=false;
  ELSE
    IF ROW(NEW.id,NEW.workspace_id,NEW.entity_id,NEW.user_id,NEW.assistant_id,NEW.sensitivity,
      NEW.compartments,NEW.project_ids,NEW.source_scope_version,NEW.scope_origin)
      IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.entity_id,OLD.user_id,OLD.assistant_id,OLD.sensitivity,
      OLD.compartments,OLD.project_ids,OLD.source_scope_version,OLD.scope_origin)
      OR (OLD.scope_held AND NOT NEW.scope_held) THEN
      RAISE EXCEPTION 'activity_scope_release_required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- Privacy admission must run before taking source locks.
CREATE TRIGGER crm_scope_activity_guard BEFORE INSERT OR UPDATE ON crm_activities
  FOR EACH ROW EXECUTE FUNCTION guard_crm_activity_scope();

CREATE FUNCTION crm_activity_scope_allows(a crm_activities,mutation boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT NOT a.scope_held
    AND (a.scope_origin='captured' OR NOT EXISTS(SELECT 1 FROM workspace_access_policies p
      WHERE p.workspace_id=a.workspace_id AND p.classification_mode='strict'))
    AND CASE WHEN current_setting('app.system_bypass',true)='true' THEN true ELSE EXISTS(
      SELECT 1 FROM entities e JOIN workspace_members m ON m.workspace_id=e.workspace_id
        AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
      WHERE e.id=a.entity_id AND e.workspace_id=a.workspace_id
        AND e.kind IN('person','company','deal') AND e.valid_to IS NULL AND e.retracted_at IS NULL AND NOT e.scope_held
        AND (a.user_id IS NULL OR a.user_id=m.user_id) AND (e.user_id IS NULL OR e.user_id=m.user_id)
        AND sensitivity_rank(a.sensitivity)<=sensitivity_rank(m.clearance)
        AND sensitivity_rank(e.sensitivity)<=sensitivity_rank(m.clearance)
        AND (effective_member_team_compartments(m.user_id,m.workspace_id) IS NULL OR
          (a.compartments <@ effective_member_team_compartments(m.user_id,m.workspace_id)
            AND e.compartments <@ effective_member_team_compartments(m.user_id,m.workspace_id)))
        AND context_scope_allows_current_principal(a.workspace_id,a.sensitivity,a.compartments,a.project_ids)
        AND context_scope_allows_current_principal(e.workspace_id,e.sensitivity,e.compartments,e.project_ids)
        AND agent_visibility_allows(a.workspace_id,a.user_id,a.assistant_id)
        AND agent_visibility_allows(e.workspace_id,e.user_id,e.assistant_id)
        AND (NOT mutation OR (agent_mutation_scope_allows(a.compartments) AND agent_mutation_scope_allows(e.compartments)))
    ) END
$$;

CREATE POLICY crm_activities_scope_read ON crm_activities AS RESTRICTIVE FOR SELECT
  USING(crm_activity_scope_allows(crm_activities,false));
CREATE POLICY crm_activities_scope_insert ON crm_activities AS RESTRICTIVE FOR INSERT
  WITH CHECK(crm_activity_scope_allows(crm_activities,true));
CREATE POLICY crm_activities_scope_update ON crm_activities AS RESTRICTIVE FOR UPDATE
  USING(crm_activity_scope_allows(crm_activities,true)) WITH CHECK(crm_activity_scope_allows(crm_activities,true));
CREATE POLICY crm_activities_scope_delete ON crm_activities AS RESTRICTIVE FOR DELETE
  USING(crm_activity_scope_allows(crm_activities,true));

COMMIT;
