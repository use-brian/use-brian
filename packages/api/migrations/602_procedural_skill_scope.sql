-- Immutable procedural-skill revision receipts and derivation lineage.
-- Spec: docs/architecture/context-engine/memory-consolidation.md
BEGIN;

CREATE TABLE workspace_skill_scope_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES workspace_skills(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  assistant_id uuid REFERENCES assistants(id) ON DELETE RESTRICT,
  sensitivity text NOT NULL CHECK (sensitivity IN ('public','internal','confidential')),
  compartments text[] NOT NULL,
  project_ids uuid[] NOT NULL,
  scope_version bigint NOT NULL DEFAULT 1 CHECK (scope_version > 0),
  scope_held boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(skill_id,revision)
);
ALTER TABLE workspace_skills
  ADD COLUMN scope_revision_id uuid REFERENCES workspace_skill_scope_revisions(id) ON DELETE RESTRICT;
CREATE INDEX workspace_skill_scope_revisions_workspace_skill
  ON workspace_skill_scope_revisions(workspace_id,skill_id,revision DESC);

ALTER TABLE workspace_skill_scope_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_skill_scope_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_skill_scope_revision_member_read ON workspace_skill_scope_revisions
  FOR SELECT USING (
    COALESCE(current_setting('app.system_bypass',true),'true')='true'
    OR workspace_id IN (
      SELECT wm.workspace_id FROM workspace_members wm
       WHERE wm.user_id=current_setting('app.current_user_id',true)::uuid
    )
  );
CREATE POLICY workspace_skill_scope_revision_system_write ON workspace_skill_scope_revisions
  FOR ALL USING (current_setting('app.system_bypass',true)='true')
  WITH CHECK (current_setting('app.system_bypass',true)='true');
CREATE POLICY workspace_skill_scope_revision_holding ON workspace_skill_scope_revisions
  AS RESTRICTIVE FOR SELECT USING (scope_held IS DISTINCT FROM true);
CREATE POLICY workspace_skills_scope_holding ON workspace_skills AS RESTRICTIVE FOR SELECT
  USING (scope_revision_id IS NULL OR EXISTS (
    SELECT 1 FROM workspace_skill_scope_revisions sr
     WHERE sr.id=scope_revision_id AND NOT sr.scope_held
  ));

CREATE FUNCTION protect_workspace_skill_scope_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
      PERFORM hold_scope_descendants(OLD.workspace_id,'workspace_skill_revision',OLD.id);
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['scope_version','scope_held'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['scope_version','scope_held'])
    OR (OLD.scope_held AND NOT NEW.scope_held) THEN
    RAISE EXCEPTION 'workspace_skill_scope_revision_immutable';
  END IF;
  IF NEW.scope_held IS DISTINCT FROM OLD.scope_held THEN
    -- The canonical hold_scope_descendants caller already updates the full
    -- transitive set. Advancing versions here avoids recursive overlapping
    -- UPDATEs while making every saved source snapshot stale immediately.
    NEW.scope_version=OLD.scope_version+1;
  ELSE
    NEW.scope_version=OLD.scope_version;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION protect_workspace_skill_scope_revision() FROM PUBLIC;
CREATE TRIGGER protect_workspace_skill_scope_revision
  BEFORE UPDATE OR DELETE ON workspace_skill_scope_revisions
  FOR EACH ROW EXECUTE FUNCTION protect_workspace_skill_scope_revision();

ALTER TABLE scope_derivations DROP CONSTRAINT scope_derivations_resource_kind_check;
ALTER TABLE scope_derivations ADD CONSTRAINT scope_derivations_resource_kind_check
  CHECK (resource_kind IN ('memory','session_message','feedback_event','workspace_skill_revision'));
ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check
  CHECK (source_kind IN ('memory','entity','entity_link','task','workspace_file','episode',
    'knowledge_entry','kb_chunk','crm_event','memory_verification','brain_verification',
    'correction_audit','session_message','feedback_event','workspace_skill_revision'));
ALTER TABLE scope_resource_states DROP CONSTRAINT scope_resource_states_resource_kind_check;
ALTER TABLE scope_resource_states ADD CONSTRAINT scope_resource_states_resource_kind_check
  CHECK (resource_kind IN ('memory','entity','entity_link','task','workspace_file','episode',
    'knowledge_entry','kb_chunk','session_message','feedback_event','workspace_skill_revision'));

CREATE OR REPLACE FUNCTION scope_source_table(p_kind text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind WHEN 'memory' THEN 'memories' WHEN 'entity' THEN 'entities'
    WHEN 'entity_link' THEN 'entity_links' WHEN 'task' THEN 'tasks'
    WHEN 'workspace_file' THEN 'workspace_files' WHEN 'episode' THEN 'episodes'
    WHEN 'knowledge_entry' THEN 'knowledge_entries' WHEN 'kb_chunk' THEN 'kb_chunks'
    WHEN 'session_message' THEN 'session_messages'
    WHEN 'feedback_event' THEN 'analytics_events'
    WHEN 'workspace_skill_revision' THEN 'workspace_skill_scope_revisions' END
$$;
REVOKE ALL ON FUNCTION scope_source_table(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION hold_scope_descendants(target_workspace uuid,target_kind text,target_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE memory_ids uuid[]; message_ids uuid[]; feedback_ids uuid[]; skill_revision_ids uuid[]; policy_revision bigint;
BEGIN
  SELECT array_agg(resource_id) INTO memory_ids
    FROM scope_descendant_memories(target_workspace,target_kind,target_id);
  WITH RECURSIVE descendants(kind,id) AS (
    SELECT d.resource_kind,d.resource_id FROM scope_derivation_sources s
      JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id
      WHERE s.workspace_id=target_workspace AND s.source_kind=target_kind
        AND s.source_id IN(SELECT resource_id FROM scope_source_ancestors(target_workspace,target_kind,target_id))
    UNION
    SELECT d.resource_kind,d.resource_id FROM descendants p
      JOIN scope_derivation_sources s ON s.source_kind=p.kind AND s.source_id=p.id AND s.workspace_id=target_workspace
      JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id
  ) SELECT array_agg(DISTINCT id) FILTER(WHERE kind='session_message'),
           array_agg(DISTINCT id) FILTER(WHERE kind='feedback_event'),
           array_agg(DISTINCT id) FILTER(WHERE kind='workspace_skill_revision')
      INTO message_ids,feedback_ids,skill_revision_ids FROM descendants;
  INSERT INTO workspace_access_policies(workspace_id,revision) VALUES(target_workspace,2)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=workspace_access_policies.revision+1,updated_at=now()
    RETURNING revision INTO policy_revision;
  IF message_ids IS NOT NULL THEN
    UPDATE session_messages SET scope_held=true
      WHERE workspace_id=target_workspace AND id=ANY(message_ids) AND NOT scope_held;
  END IF;
  IF feedback_ids IS NOT NULL THEN
    UPDATE analytics_events SET scope_held=true
      WHERE workspace_id=target_workspace AND id=ANY(feedback_ids) AND NOT scope_held;
  END IF;
  IF skill_revision_ids IS NOT NULL THEN
    UPDATE workspace_skill_scope_revisions SET scope_held=true
      WHERE workspace_id=target_workspace AND id=ANY(skill_revision_ids) AND NOT scope_held;
    INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
      SELECT workspace_id,'workspace_skill_revision',id,scope_version::text,'held',policy_revision,'source_changed'
        FROM workspace_skill_scope_revisions WHERE workspace_id=target_workspace AND id=ANY(skill_revision_ids)
      ON CONFLICT(workspace_id,resource_kind,resource_id,resource_version) DO UPDATE
        SET review_state='held',classification_revision=EXCLUDED.classification_revision,
            holding_reason='source_changed',updated_at=now();
  END IF;
  IF memory_ids IS NULL THEN RETURN; END IF;
  UPDATE memories SET scope_held=true
    WHERE workspace_id=target_workspace AND id=ANY(memory_ids) AND NOT scope_held;
  INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
    SELECT workspace_id,'memory',id,scope_version::text,'held',policy_revision,'source_changed'
      FROM memories WHERE workspace_id=target_workspace AND id=ANY(memory_ids)
    ON CONFLICT(workspace_id,resource_kind,resource_id,resource_version) DO UPDATE
      SET review_state='held',classification_revision=EXCLUDED.classification_revision,
          holding_reason='source_changed',updated_at=now();
END;
$$;
REVOKE ALL ON FUNCTION hold_scope_descendants(uuid,text,uuid) FROM PUBLIC;

COMMIT;
