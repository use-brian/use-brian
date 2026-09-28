-- Canonical conversation and whole-turn feedback evidence.
-- Spec: docs/architecture/context-engine/{scoped-context,memory-consolidation,session-messages}.md
BEGIN;

ALTER TABLE session_messages
  ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN assistant_id uuid REFERENCES assistants(id) ON DELETE RESTRICT,
  ADD COLUMN sensitivity text CHECK (sensitivity IN ('public','internal','confidential')),
  ADD COLUMN compartments text[],
  ADD COLUMN project_ids uuid[],
  ADD COLUMN scope_version bigint CHECK (scope_version > 0),
  ADD COLUMN scope_held boolean;
ALTER TABLE session_messages ADD CONSTRAINT session_messages_scope_complete CHECK (
  (workspace_id IS NULL AND user_id IS NULL AND assistant_id IS NULL
    AND sensitivity IS NULL AND compartments IS NULL AND project_ids IS NULL
    AND scope_version IS NULL AND scope_held IS NULL)
  OR
  (workspace_id IS NOT NULL AND assistant_id IS NOT NULL
    AND sensitivity IS NOT NULL AND compartments IS NOT NULL AND project_ids IS NOT NULL
    AND scope_version IS NOT NULL AND scope_held IS NOT NULL)
);

ALTER TABLE analytics_events
  ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD COLUMN sensitivity text CHECK (sensitivity IN ('public','internal','confidential')),
  ADD COLUMN compartments text[],
  ADD COLUMN project_ids uuid[],
  ADD COLUMN scope_version bigint CHECK (scope_version > 0),
  ADD COLUMN scope_held boolean;
ALTER TABLE analytics_events ADD CONSTRAINT analytics_events_scope_complete CHECK (
  (workspace_id IS NULL AND sensitivity IS NULL AND compartments IS NULL
    AND project_ids IS NULL AND scope_version IS NULL AND scope_held IS NULL)
  OR
  (workspace_id IS NOT NULL AND assistant_id IS NOT NULL
    AND sensitivity IS NOT NULL AND compartments IS NOT NULL AND project_ids IS NOT NULL
    AND scope_version IS NOT NULL AND scope_held IS NOT NULL)
);

ALTER TABLE scope_derivations DROP CONSTRAINT scope_derivations_resource_kind_check;
ALTER TABLE scope_derivations ADD CONSTRAINT scope_derivations_resource_kind_check
  CHECK (resource_kind IN ('memory','session_message','feedback_event'));
ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check
  CHECK (source_kind IN ('memory','entity','entity_link','task','workspace_file','episode',
    'knowledge_entry','kb_chunk','crm_event','memory_verification','brain_verification',
    'correction_audit','session_message','feedback_event'));
ALTER TABLE scope_resource_states DROP CONSTRAINT scope_resource_states_resource_kind_check;
ALTER TABLE scope_resource_states ADD CONSTRAINT scope_resource_states_resource_kind_check
  CHECK (resource_kind IN ('memory','entity','entity_link','task','workspace_file','episode',
    'knowledge_entry','kb_chunk','session_message','feedback_event'));

CREATE OR REPLACE FUNCTION scope_source_table(p_kind text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind WHEN 'memory' THEN 'memories' WHEN 'entity' THEN 'entities'
    WHEN 'entity_link' THEN 'entity_links' WHEN 'task' THEN 'tasks'
    WHEN 'workspace_file' THEN 'workspace_files' WHEN 'episode' THEN 'episodes'
    WHEN 'knowledge_entry' THEN 'knowledge_entries' WHEN 'kb_chunk' THEN 'kb_chunks'
    WHEN 'session_message' THEN 'session_messages'
    WHEN 'feedback_event' THEN 'analytics_events' END
$$;
REVOKE ALL ON FUNCTION scope_source_table(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION read_scope_source(p_workspace uuid,p_kind text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tab text; row_json jsonb; ev crm_domain_event_outbox;
BEGIN
  IF p_kind IN('memory_verification','brain_verification','correction_audit') THEN
    RETURN read_verification_scope(p_workspace,p_kind,p_id);
  END IF;
  IF p_kind='crm_event' THEN
    SELECT * INTO ev FROM crm_domain_event_outbox WHERE workspace_id=p_workspace AND id=p_id FOR SHARE;
    IF ev.id IS NULL OR ev.scope_origin<>'captured' OR ev.scope_held OR ev.status='retired'
      OR ev.scope_source IS NULL OR ev.scope_source->>'held' IS DISTINCT FROM 'false'
      OR ev.scope_source->>'validTo' IS NOT NULL OR ev.scope_source->>'retractedAt' IS NOT NULL
      OR crm_event_entity_source(ev.workspace_id,ev.subject_kind,ev.subject_id,true)
        IS DISTINCT FROM (ev.scope_source->>'resourceId')::uuid THEN RETURN NULL; END IF;
    RETURN ev.scope_source || jsonb_build_object('resourceKind','crm_event','resourceId',ev.id,
      'causalEntityId',ev.scope_source->>'resourceId',
      'version',ev.scope_version::text||':'||(extract(epoch FROM ev.created_at)*1000000)::numeric::text,
      'held',false,'validTo',NULL,'retractedAt',NULL);
  END IF;
  tab=scope_source_table(p_kind);
  IF tab IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE workspace_id=$1 AND id=$2 FOR SHARE',tab)
    INTO row_json USING p_workspace,p_id;
  IF row_json IS NULL THEN RETURN NULL; END IF;
  IF p_kind='feedback_event' AND row_json->>'event_name'<>'feedback_negative' THEN RETURN NULL; END IF;
  IF NOT (row_json ?& ARRAY['workspace_id','sensitivity','compartments','project_ids','scope_version','scope_held'])
    OR (p_kind<>'knowledge_entry' AND NOT(row_json ?& ARRAY['user_id','assistant_id'])) THEN
    RAISE EXCEPTION 'scope_evidence_missing';
  END IF;
  -- Held sources remain readable to the canonical validator so holding-state
  -- rows can reference their exact version. Application validators reject the
  -- returned `held:true`; only legacy rows with no version are unprovable.
  IF row_json->>'scope_version' IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('workspaceId',row_json->'workspace_id','userId',row_json->'user_id',
    'assistantId',row_json->'assistant_id','sensitivity',row_json->'sensitivity',
    'compartments',row_json->'compartments','projectIds',row_json->'project_ids',
    'resourceKind',p_kind,'resourceId',p_id,'version',row_json->>'scope_version',
    'held',row_json->'scope_held','validTo',row_json->'valid_to','retractedAt',row_json->'retracted_at');
END;
$$;
REVOKE ALL ON FUNCTION read_scope_source(uuid,text,uuid) FROM PUBLIC;

CREATE TRIGGER canonical_scope_version BEFORE UPDATE OR DELETE ON session_messages
  FOR EACH ROW EXECUTE FUNCTION advance_canonical_scope_version('session_message');
CREATE TRIGGER canonical_scope_version BEFORE UPDATE OR DELETE ON analytics_events
  FOR EACH ROW EXECUTE FUNCTION advance_canonical_scope_version('feedback_event');
CREATE POLICY session_messages_scope_holding ON session_messages AS RESTRICTIVE FOR SELECT
  USING (scope_held IS DISTINCT FROM true);
CREATE POLICY analytics_events_scope_holding ON analytics_events AS RESTRICTIVE FOR SELECT
  USING (scope_held IS DISTINCT FROM true);

-- The generic graph now has non-memory intermediate outputs. Hold those nodes
-- as well as final memories so they cannot be reused as fresh evidence after
-- an upstream message or canonical source changes.
CREATE OR REPLACE FUNCTION hold_scope_descendants(target_workspace uuid,target_kind text,target_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE memory_ids uuid[]; message_ids uuid[]; feedback_ids uuid[]; policy_revision bigint;
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
           array_agg(DISTINCT id) FILTER(WHERE kind='feedback_event')
      INTO message_ids,feedback_ids FROM descendants;
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
