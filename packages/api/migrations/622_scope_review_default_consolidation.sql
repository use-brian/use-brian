-- Separately reviewed source broadening only. No mode activation or data migration.
BEGIN;
ALTER TABLE workspace_scope_reviews ADD COLUMN expires_at timestamptz;
ALTER TABLE workspace_scope_reviews DROP CONSTRAINT workspace_scope_reviews_action_check;
ALTER TABLE workspace_scope_reviews ADD CONSTRAINT workspace_scope_reviews_action_check
  CHECK(action IN('confirm_general','assign_team','consolidate_default','hold'));
ALTER TABLE workspace_scope_reviews DROP CONSTRAINT workspace_scope_reviews_check;
ALTER TABLE workspace_scope_reviews ADD CONSTRAINT workspace_scope_reviews_target_check CHECK(
  (action IN('assign_team','consolidate_default') AND target_team_id IS NOT NULL AND target_compartment IS NOT NULL)
  OR (action NOT IN('assign_team','consolidate_default') AND target_team_id IS NULL AND target_compartment IS NULL));
ALTER TABLE workspace_scope_reviews ADD CONSTRAINT workspace_scope_reviews_consolidation_check CHECK(
  action<>'consolidate_default' OR (expires_at IS NOT NULL AND expires_at>created_at AND expires_at<=created_at+interval '15 minutes'
    AND resource_kind IN('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk')));
CREATE FUNCTION guard_scope_default_consolidation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'scope_review_proposal_immutable';
  END IF;
  IF TG_OP='INSERT' AND NEW.action='consolidate_default' AND NOT EXISTS(
    SELECT 1 FROM workspace_access_policies p JOIN workspace_groups g ON g.workspace_id=p.workspace_id AND g.id=p.default_department_id
    WHERE p.workspace_id=NEW.workspace_id AND g.id=NEW.target_team_id AND g.compartment_key=NEW.target_compartment
      AND g.kind='team' AND g.status='active' AND NOT g.read_all
      AND NOT EXISTS(SELECT 1 FROM workspace_group_compartment_grants b WHERE b.group_id=g.id AND b.compartment_key<>g.compartment_key)
  ) THEN RAISE EXCEPTION 'scope_review_default_invalid'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_scope_default_consolidation BEFORE INSERT OR UPDATE ON workspace_scope_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_scope_default_consolidation();
-- Existing guards freeze source/content/impact snapshots. Require new-action
-- evidence at insertion too; legacy reviews retain their original contract.
CREATE FUNCTION guard_scope_consolidation_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job workspace_scope_reviews; proposal jsonb;
BEGIN
  SELECT * INTO job FROM workspace_scope_reviews WHERE id=NEW.review_id AND workspace_id=NEW.workspace_id;
  IF job.action='consolidate_default' THEN
    proposal=NEW.impact_snapshot->'consolidation';
    IF NOT coalesce(proposal->>'version'='1'
      AND proposal->'before'=NEW.source_snapshot
      AND proposal->'after'=jsonb_set(NEW.source_snapshot,'{compartments}',jsonb_build_array(job.target_compartment))
      AND jsonb_typeof(proposal->'audiences')='array'
      AND jsonb_typeof(proposal->'visibility')='object'
      AND length(proposal->>'futureDefaultMembersWarning')>0
      AND NEW.source_snapshot->>'held'='false'
      AND NEW.source_snapshot->>'validTo' IS NULL
      AND NEW.source_snapshot->>'retractedAt' IS NULL
      AND jsonb_array_length(NEW.source_snapshot->'compartments')>0
      AND NEW.content_snapshot IS NOT NULL,false) THEN
      RAISE EXCEPTION 'scope_review_reference_invalid';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.source_snapshot->'compartments') label
      WHERE NOT EXISTS(SELECT 1 FROM workspace_groups g WHERE g.workspace_id=NEW.workspace_id
        AND g.kind='team' AND g.status='active' AND g.compartment_key=label)) THEN
      RAISE EXCEPTION 'scope_review_labels_unsupported';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_scope_consolidation_item BEFORE INSERT ON workspace_scope_review_items
  FOR EACH ROW EXECUTE FUNCTION guard_scope_consolidation_item();
COMMIT;
