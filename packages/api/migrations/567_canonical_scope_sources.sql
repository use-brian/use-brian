BEGIN;
-- Workspace-scoped knowledge can legitimately derive a workspace-visible memory.
-- The workspace partition remains mandatory; both visibility dimensions may widen.
ALTER TABLE memories DROP CONSTRAINT memories_visibility_check;
ALTER TABLE memories ADD CONSTRAINT memories_visibility_check CHECK(workspace_id IS NOT NULL OR user_id IS NOT NULL OR assistant_id IS NOT NULL);
-- Closed kind/table mapping. Never interpolate an untrusted table name.
CREATE FUNCTION scope_source_table(p_kind text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind WHEN 'memory' THEN 'memories' WHEN 'entity' THEN 'entities'
    WHEN 'entity_link' THEN 'entity_links' WHEN 'task' THEN 'tasks'
    WHEN 'workspace_file' THEN 'workspace_files' WHEN 'episode' THEN 'episodes'
    WHEN 'knowledge_entry' THEN 'knowledge_entries' WHEN 'kb_chunk' THEN 'kb_chunks' END
$$;
REVOKE ALL ON FUNCTION scope_source_table(text) FROM PUBLIC;
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['entities','entity_links','tasks','workspace_files','episodes','knowledge_entries','kb_chunks'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN scope_version bigint NOT NULL DEFAULT 1 CHECK(scope_version>0), ADD COLUMN scope_held boolean NOT NULL DEFAULT false',tab);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR SELECT USING(NOT scope_held)',tab||'_scope_holding',tab);
  END LOOP;
END $$;
ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check CHECK(source_kind IN('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk'));
ALTER TABLE scope_resource_states DROP CONSTRAINT scope_resource_states_resource_kind_check;
ALTER TABLE scope_resource_states ADD CONSTRAINT scope_resource_states_resource_kind_check CHECK(resource_kind IN('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk'));

-- Owner-pool validation only: this function is not a member-readable metadata API.
CREATE FUNCTION read_scope_source(p_workspace uuid,p_kind text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tab text; row_json jsonb;
BEGIN
  tab=scope_source_table(p_kind);
  IF tab IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE workspace_id=$1 AND id=$2 FOR SHARE',tab)
    INTO row_json USING p_workspace,p_id;
  IF row_json IS NULL THEN RETURN NULL; END IF;
  IF NOT (row_json ?& ARRAY['workspace_id','sensitivity','compartments','project_ids','scope_version','scope_held'])
    OR (p_kind<>'knowledge_entry' AND NOT(row_json ?& ARRAY['user_id','assistant_id'])) THEN
    RAISE EXCEPTION 'scope_evidence_missing';
  END IF;
  RETURN jsonb_build_object('workspaceId',row_json->'workspace_id','userId',row_json->'user_id',
    'assistantId',row_json->'assistant_id','sensitivity',row_json->'sensitivity',
    'compartments',row_json->'compartments','projectIds',row_json->'project_ids',
    'resourceKind',p_kind,'resourceId',p_id,'version',row_json->>'scope_version',
    'held',row_json->'scope_held','validTo',row_json->'valid_to','retractedAt',row_json->'retracted_at');
END;
$$;
REVOKE ALL ON FUNCTION read_scope_source(uuid,text,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION validate_scope_resource_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source_row jsonb; expected_id uuid; expected_version text; expected_kind text;
BEGIN
  IF TG_TABLE_NAME='scope_derivation_sources' THEN
    expected_id=NEW.source_id;expected_version=NEW.source_version;expected_kind=NEW.source_kind;
  ELSE expected_id=NEW.resource_id;expected_version=NEW.resource_version;expected_kind=NEW.resource_kind;
  END IF;
  source_row=read_scope_source(NEW.workspace_id,expected_kind,expected_id);
  IF source_row IS NULL OR source_row->>'version'<>expected_version THEN RAISE EXCEPTION 'scope_source_changed'; END IF;
  IF TG_TABLE_NAME='scope_derivations' THEN
    IF NEW.user_id IS DISTINCT FROM (source_row->>'userId')::uuid
      OR NEW.assistant_id IS DISTINCT FROM (source_row->>'assistantId')::uuid
      OR NEW.sensitivity<>(source_row->>'sensitivity')
      OR NOT(to_jsonb(NEW.compartments) @> (source_row->'compartments') AND to_jsonb(NEW.compartments) <@ (source_row->'compartments'))
      OR NOT(to_jsonb(NEW.project_ids) @> (source_row->'projectIds') AND to_jsonb(NEW.project_ids) <@ (source_row->'projectIds')) THEN
      RAISE EXCEPTION 'scope_envelope_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hold_scope_descendants(target_workspace uuid,target_kind text,target_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE affected uuid[]; policy_revision bigint; ancestors uuid[]; tab text;
BEGIN
  tab=scope_source_table(target_kind);
  IF tab IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  EXECUTE format('WITH RECURSIVE ancestry(id) AS (SELECT $1::uuid UNION SELECT r.id FROM %I r JOIN ancestry a ON nullif(to_jsonb(r)->>''superseded_by'','''')::uuid=a.id WHERE r.workspace_id=$2) SELECT array_agg(id) FROM ancestry',tab)
    INTO ancestors USING target_id,target_workspace;
  WITH RECURSIVE descendants(kind,id) AS (
    SELECT d.resource_kind,d.resource_id FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id
      WHERE s.workspace_id=target_workspace AND s.source_kind=target_kind AND s.source_id=ANY(ancestors)
    UNION
    SELECT d.resource_kind,d.resource_id FROM descendants p JOIN scope_derivation_sources s ON s.source_kind=p.kind AND s.source_id=p.id AND s.workspace_id=target_workspace
      JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id
  ) SELECT array_agg(id) INTO affected FROM descendants WHERE kind='memory';
  INSERT INTO workspace_access_policies(workspace_id,revision) VALUES(target_workspace,2)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=workspace_access_policies.revision+1,updated_at=now()
    RETURNING revision INTO policy_revision;
  IF affected IS NULL THEN RETURN; END IF;
  UPDATE memories SET scope_held=true WHERE workspace_id=target_workspace AND id=ANY(affected);
  INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
    SELECT workspace_id,'memory',id,scope_version::text,'held',policy_revision,'source_changed' FROM memories WHERE workspace_id=target_workspace AND id=ANY(affected)
    ON CONFLICT(workspace_id,resource_kind,resource_id,resource_version) DO UPDATE SET review_state='held',classification_revision=EXCLUDED.classification_revision,holding_reason='source_changed',updated_at=now();
END;
$$;

CREATE FUNCTION advance_canonical_scope_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ignored text[]=ARRAY['scope_version','updated_at','embedding','embedding_model_id','content_hash','embedding_failed_at','embedding_failure_reason','embedding_updated_at','search_vector','recall_count','useful_recall_count','last_recalled_at','query_hashes','recall_days','centrality','centrality_computed_at','last_checkpoint_at','extraction_locked'];
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN PERFORM hold_scope_descendants(OLD.workspace_id,TG_ARGV[0],OLD.id); END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW)-ignored) IS DISTINCT FROM (to_jsonb(OLD)-ignored) THEN
    NEW.scope_version=OLD.scope_version+1;
    PERFORM hold_scope_descendants(OLD.workspace_id,TG_ARGV[0],OLD.id);
  ELSE NEW.scope_version=OLD.scope_version;
  END IF;
  RETURN NEW;
END;
$$;
DO $$ DECLARE kind text; tab text; BEGIN
  FOREACH kind IN ARRAY ARRAY['entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk'] LOOP
    tab=scope_source_table(kind);
    EXECUTE format('CREATE TRIGGER canonical_scope_version BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION advance_canonical_scope_version(%L)',tab,kind);
  END LOOP;
END $$;
COMMIT;
