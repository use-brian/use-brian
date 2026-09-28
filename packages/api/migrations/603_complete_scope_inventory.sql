-- Complete review adapters and strict intake binding provenance.
-- Spec: docs/architecture/context-engine/scoped-context.md
BEGIN;

-- Existing bindings stay legacy. Fresh rows default explicit; runtime edit paths
-- also stamp explicit when an administrator deliberately re-saves a selection.
ALTER TABLE assistants ADD COLUMN context_binding_origin text NOT NULL DEFAULT 'legacy'
  CHECK(context_binding_origin IN('legacy','explicit','reviewed','held'));
ALTER TABLE assistants ALTER COLUMN context_binding_origin SET DEFAULT 'explicit';
ALTER TABLE sessions ADD COLUMN context_binding_origin text NOT NULL DEFAULT 'legacy'
  CHECK(context_binding_origin IN('legacy','explicit','reviewed','held'));
ALTER TABLE sessions ALTER COLUMN context_binding_origin SET DEFAULT 'explicit';
ALTER TABLE brain_keys ADD COLUMN context_binding_origin text NOT NULL DEFAULT 'legacy'
  CHECK(context_binding_origin IN('legacy','explicit','reviewed','held'));
ALTER TABLE brain_keys ALTER COLUMN context_binding_origin SET DEFAULT 'explicit';
ALTER TABLE connector_instance ADD COLUMN context_binding_origin text NOT NULL DEFAULT 'legacy'
  CHECK(context_binding_origin IN('legacy','explicit','reviewed','held'));
ALTER TABLE connector_instance ALTER COLUMN context_binding_origin SET DEFAULT 'explicit';
ALTER TABLE connector_grant ADD COLUMN context_binding_origin text NOT NULL DEFAULT 'legacy'
  CHECK(context_binding_origin IN('legacy','explicit','reviewed','held'));
ALTER TABLE connector_grant ALTER COLUMN context_binding_origin SET DEFAULT 'explicit';
ALTER TABLE ingest_rules
  ADD COLUMN scope_binding_origin text NOT NULL DEFAULT 'legacy'
    CHECK(scope_binding_origin IN('legacy','explicit','reviewed','held')),
  ADD COLUMN scope_binding_mode text NOT NULL DEFAULT 'inherit'
    CHECK(scope_binding_mode IN('inherit','explicit'));
ALTER TABLE ingest_rules ALTER COLUMN scope_binding_origin SET DEFAULT 'explicit';
ALTER TABLE pending_ingest_batches
  ADD COLUMN scope_binding_origin text NOT NULL DEFAULT 'legacy'
    CHECK(scope_binding_origin IN('legacy','explicit','reviewed','held')),
  ADD COLUMN scope_held boolean NOT NULL DEFAULT false;
ALTER TABLE pending_ingest_batches ALTER COLUMN scope_binding_origin SET DEFAULT 'explicit';

DROP INDEX pending_programmatic_batch_pool_key;
CREATE UNIQUE INDEX pending_programmatic_batch_pool_key
  ON pending_ingest_batches
    (rule_id,assistant_id,partition_key,fires_at,scope_binding_origin,scope_held)
  WHERE source='programmatic' AND processed_at IS NULL;

-- This table mapping is only for trusted review code. It includes immutable
-- provenance receipts that deliberately do not belong in scope_source_table().
CREATE FUNCTION scope_review_source_table(p_kind text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind
    WHEN 'memory' THEN 'memories' WHEN 'entity' THEN 'entities'
    WHEN 'entity_link' THEN 'entity_links' WHEN 'task' THEN 'tasks'
    WHEN 'workspace_file' THEN 'workspace_files' WHEN 'episode' THEN 'episodes'
    WHEN 'knowledge_entry' THEN 'knowledge_entries' WHEN 'kb_chunk' THEN 'kb_chunks'
    WHEN 'crm_event' THEN 'crm_domain_event_outbox'
    WHEN 'memory_verification' THEN 'memory_verifications'
    WHEN 'brain_verification' THEN 'brain_verifications'
    WHEN 'correction_audit' THEN 'correction_audit'
    WHEN 'session_message' THEN 'session_messages'
    WHEN 'feedback_event' THEN 'analytics_events'
    WHEN 'workspace_skill_revision' THEN 'workspace_skill_scope_revisions'
    WHEN 'file_cache' THEN 'file_cache' WHEN 'file_segment' THEN 'file_segments'
    WHEN 'recording' THEN 'recordings' WHEN 'transcript_segment' THEN 'transcript_segments'
    WHEN 'entity_instance' THEN 'entity_instances'
    WHEN 'blueprint_record' THEN 'blueprint_records'
    WHEN 'office_artifact' THEN 'office_artifacts'
  END
$$;
REVOKE ALL ON FUNCTION scope_review_source_table(text) FROM PUBLIC;

CREATE FUNCTION scope_review_registry_revision() RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$ SELECT 1::bigint $$;
REVOKE ALL ON FUNCTION scope_review_registry_revision() FROM PUBLIC;

-- Unlike read_scope_source(), review must be able to inspect already-held and
-- incomplete legacy rows without pretending their absent axes are General.
CREATE FUNCTION read_scope_review_source(p_workspace uuid,p_kind text,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE live jsonb; row_json jsonb; source jsonb; resolved_workspace uuid;
  version_value text; held_value boolean=false;
BEGIN
  IF p_kind IN('memory','entity','entity_link','task','workspace_file','episode',
      'knowledge_entry','kb_chunk') THEN
    live=read_scope_source(p_workspace,p_kind,p_id);
    IF live IS NOT NULL THEN RETURN live; END IF;
  END IF;

  IF p_kind='crm_event' THEN
    SELECT to_jsonb(r) INTO row_json FROM crm_domain_event_outbox r
      WHERE r.workspace_id=p_workspace AND r.id=p_id FOR SHARE;
    source=row_json->'scope_source';
    version_value=(row_json->>'scope_version')||':'||
      ((extract(epoch FROM (row_json->>'created_at')::timestamptz)*1000000)::numeric::text);
  ELSIF p_kind='memory_verification' THEN
    SELECT to_jsonb(r) INTO row_json FROM memory_verifications r
      WHERE r.workspace_id=p_workspace AND r.id=p_id FOR SHARE;
    source=row_json->'source_scope';
    version_value=(row_json->>'scope_version')||':'||(row_json->>'created_at');
  ELSIF p_kind='brain_verification' THEN
    SELECT to_jsonb(r) INTO row_json FROM brain_verifications r
      WHERE r.workspace_id=p_workspace AND r.id=p_id FOR SHARE;
    source=row_json->'source_scope';
    version_value=(row_json->>'scope_version')||':'||(row_json->>'created_at');
  ELSIF p_kind='correction_audit' THEN
    SELECT to_jsonb(r) INTO row_json FROM correction_audit r
      WHERE r.workspace_id=p_workspace AND r.id=p_id FOR SHARE;
    source=row_json->'source_scope';
    version_value=(row_json->>'scope_version')||':'||(row_json->>'created_at');
  ELSIF p_kind='session_message' THEN
    SELECT to_jsonb(m),coalesce(m.workspace_id,s.workspace_id) INTO row_json,resolved_workspace
      FROM session_messages m JOIN sessions s ON s.id=m.session_id
      WHERE coalesce(m.workspace_id,s.workspace_id)=p_workspace AND m.id=p_id FOR SHARE OF m;
    version_value=coalesce(row_json->>'scope_version','legacy:'||md5(row_json::text));
  ELSIF p_kind='feedback_event' THEN
    SELECT to_jsonb(e),coalesce(e.workspace_id,a.workspace_id) INTO row_json,resolved_workspace
      FROM analytics_events e LEFT JOIN assistants a ON a.id=e.assistant_id
      WHERE coalesce(e.workspace_id,a.workspace_id)=p_workspace AND e.id=p_id
        AND e.event_name='feedback_negative' FOR SHARE OF e;
    version_value=coalesce(row_json->>'scope_version','legacy:'||md5(row_json::text));
  ELSE
    IF scope_review_source_table(p_kind) IS NULL THEN RETURN NULL; END IF;
    EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE r.workspace_id=$1 AND r.id=$2 FOR SHARE',
      scope_review_source_table(p_kind)) INTO row_json USING p_workspace,p_id;
    version_value=coalesce(row_json->>'scope_version',row_json->>'updated_at',
      row_json->>'last_edited_at',row_json->>'created_at','legacy')||':'||md5(row_json::text);
  END IF;
  IF row_json IS NULL THEN RETURN NULL; END IF;
  held_value=coalesce((row_json->>'scope_held')::boolean,false) OR EXISTS(
    SELECT 1 FROM scope_resource_states s WHERE s.workspace_id=p_workspace
      AND s.resource_kind=p_kind AND s.resource_id=p_id AND s.review_state='held');
  RETURN jsonb_build_object(
    'workspaceId',p_workspace,'userId',coalesce(source->'userId',row_json->'user_id'),
    'assistantId',coalesce(source->'assistantId',row_json->'assistant_id'),
    'sensitivity',coalesce(source->'sensitivity',row_json->'sensitivity'),
    'compartments',coalesce(source->'compartments',row_json->'compartments'),
    'projectIds',coalesce(source->'projectIds',row_json->'project_ids'),
    'resourceKind',p_kind,'resourceId',p_id,'version',version_value,
    'held',held_value,'validTo',row_json->'valid_to','retractedAt',row_json->'retracted_at');
END;
$$;
REVOKE ALL ON FUNCTION read_scope_review_source(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION read_scope_review_content(p_workspace uuid,p_kind text,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tab text; row_json jsonb; title_value text; text_value text;
BEGIN
  IF p_kind='session_message' THEN
    SELECT to_jsonb(m) INTO row_json FROM session_messages m JOIN sessions s ON s.id=m.session_id
      WHERE coalesce(m.workspace_id,s.workspace_id)=p_workspace AND m.id=p_id FOR SHARE OF m;
  ELSIF p_kind='feedback_event' THEN
    SELECT to_jsonb(e) INTO row_json FROM analytics_events e LEFT JOIN assistants a ON a.id=e.assistant_id
      WHERE coalesce(e.workspace_id,a.workspace_id)=p_workspace AND e.id=p_id
        AND e.event_name='feedback_negative' FOR SHARE OF e;
  ELSIF p_kind='workspace_skill_revision' THEN
    SELECT jsonb_build_object('title',s.name,'content',s.content,'revision',r.revision)
      INTO row_json FROM workspace_skill_scope_revisions r JOIN workspace_skills s ON s.id=r.skill_id
      WHERE r.workspace_id=p_workspace AND r.id=p_id FOR SHARE OF r,s;
  ELSE
    tab=scope_review_source_table(p_kind);
    IF tab IS NULL THEN RETURN NULL; END IF;
    EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE r.workspace_id=$1 AND r.id=$2 FOR SHARE',tab)
      INTO row_json USING p_workspace,p_id;
  END IF;
  IF row_json IS NULL THEN RETURN NULL; END IF;
  title_value=coalesce(row_json->>'title',row_json->>'name',row_json->>'display_name',
    row_json->>'file_name',row_json->>'path',row_json->>'event_name',row_json->>'primitive',
    row_json->>'source_kind',p_kind);
  text_value=coalesce(row_json->>'summary',row_json->>'content',row_json->>'chunk_text',
    row_json->>'description',row_json->>'segment_text',row_json->>'payload',
    row_json->>'user_value',row_json->>'model_value',row_json->>'reason',
    row_json->>'metadata',row_json->>'fields',row_json->>'properties',
    row_json->>'attributes',row_json->>'detail',row_json->>'row_snapshot',
    row_json->>'source_ref',row_json->>'data',title_value);
  RETURN jsonb_build_object('title',left(title_value,500),'text',left(text_value,12000));
END;
$$;
REVOKE ALL ON FUNCTION read_scope_review_content(uuid,text,uuid) FROM PUBLIC;

ALTER TABLE scope_resource_states DROP CONSTRAINT scope_resource_states_resource_kind_check;
ALTER TABLE scope_resource_states ADD CONSTRAINT scope_resource_states_resource_kind_check
  CHECK(resource_kind IN('memory','entity','entity_link','task','workspace_file','episode',
    'knowledge_entry','kb_chunk','crm_event','memory_verification','brain_verification',
    'correction_audit','session_message','feedback_event','workspace_skill_revision',
    'file_cache','file_segment','recording','transcript_segment','entity_instance',
    'blueprint_record','office_artifact'));

CREATE OR REPLACE FUNCTION validate_scope_resource_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source_row jsonb; expected_id uuid; expected_version text; expected_kind text;
BEGIN
  IF TG_TABLE_NAME='scope_derivation_sources' THEN
    expected_id=NEW.source_id;expected_version=NEW.source_version;expected_kind=NEW.source_kind;
  ELSE expected_id=NEW.resource_id;expected_version=NEW.resource_version;expected_kind=NEW.resource_kind;
  END IF;
  source_row=CASE WHEN TG_TABLE_NAME='scope_resource_states'
    THEN read_scope_review_source(NEW.workspace_id,expected_kind,expected_id)
    ELSE read_scope_source(NEW.workspace_id,expected_kind,expected_id) END;
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

ALTER TABLE workspace_scope_reviews DROP CONSTRAINT workspace_scope_reviews_resource_kind_check;
ALTER TABLE workspace_scope_reviews ADD CONSTRAINT workspace_scope_reviews_resource_kind_check
  CHECK(scope_review_source_table(resource_kind) IS NOT NULL);
ALTER TABLE workspace_scope_review_items ADD COLUMN content_snapshot jsonb
  CHECK(content_snapshot IS NULL OR coalesce(jsonb_typeof(content_snapshot)='object'
    AND content_snapshot ?& ARRAY['title','text'] AND jsonb_typeof(content_snapshot->'title')='string'
    AND jsonb_typeof(content_snapshot->'text')='string'
    AND content_snapshot-ARRAY['title','text']='{}'::jsonb,false));

CREATE OR REPLACE FUNCTION guard_scope_review_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE snapshot jsonb; content jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.workspace_id,NEW.review_id,NEW.resource_kind,NEW.resource_id,
      NEW.resource_version,NEW.source_snapshot,NEW.content_snapshot)
      IS DISTINCT FROM ROW(OLD.workspace_id,OLD.review_id,OLD.resource_kind,OLD.resource_id,
      OLD.resource_version,OLD.source_snapshot,OLD.content_snapshot) THEN
      RAISE EXCEPTION 'scope_review_proposal_immutable';
    END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM workspace_scope_reviews WHERE id=NEW.review_id
      AND workspace_id=NEW.workspace_id AND resource_kind=NEW.resource_kind AND status='preview') THEN
      RAISE EXCEPTION 'scope_review_reference_invalid';
    END IF;
    snapshot=read_scope_review_source(NEW.workspace_id,NEW.resource_kind,NEW.resource_id);
    content=read_scope_review_content(NEW.workspace_id,NEW.resource_kind,NEW.resource_id);
    IF snapshot IS NULL OR snapshot->>'version' IS DISTINCT FROM NEW.resource_version
      OR snapshot IS DISTINCT FROM NEW.source_snapshot
      OR (NEW.content_snapshot IS NOT NULL AND content IS DISTINCT FROM NEW.content_snapshot) THEN
      RAISE EXCEPTION 'scope_source_changed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION scope_descendant_resources(p_workspace uuid,p_kind text,p_id uuid)
RETURNS TABLE(resource_kind text,resource_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH RECURSIVE descendants(kind,id) AS (
    SELECT d.resource_kind,d.resource_id FROM scope_derivation_sources s
      JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id
      WHERE s.workspace_id=p_workspace AND s.source_kind=p_kind
        AND s.source_id IN(SELECT resource_id FROM scope_source_ancestors(p_workspace,p_kind,p_id))
    UNION
    SELECT d.resource_kind,d.resource_id FROM descendants p
      JOIN scope_derivation_sources s ON s.source_kind=p.kind AND s.source_id=p.id
        AND s.workspace_id=p_workspace
      JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id
  ) SELECT DISTINCT kind,id FROM descendants
$$;
REVOKE ALL ON FUNCTION scope_descendant_resources(uuid,text,uuid) FROM PUBLIC;

ALTER TABLE workspace_scope_review_items DROP CONSTRAINT workspace_scope_review_items_impact_snapshot_check;
ALTER TABLE workspace_scope_review_items ADD CONSTRAINT workspace_scope_review_items_impact_snapshot_check
  CHECK(impact_snapshot IS NULL OR coalesce(jsonb_typeof(impact_snapshot)='object'
    AND impact_snapshot->>'version' IN('1','2')
    AND jsonb_typeof(impact_snapshot->'descendants')='array'
    AND (impact_snapshot->>'version'='1' OR jsonb_typeof(impact_snapshot->'dependents')='object'),false));

CREATE OR REPLACE FUNCTION guard_scope_review_impact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item jsonb; current_source jsonb; item_kind text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.impact_snapshot IS DISTINCT FROM OLD.impact_snapshot THEN
      RAISE EXCEPTION 'scope_review_proposal_immutable';
    END IF;
  ELSIF NEW.impact_snapshot IS NOT NULL THEN
    IF jsonb_array_length(NEW.impact_snapshot->'descendants')>500
      OR (SELECT count(*)<>count(DISTINCT coalesce(value->>'resourceKind','memory')||':'||(value->>'resourceId'))
            FROM jsonb_array_elements(NEW.impact_snapshot->'descendants')) THEN
      RAISE EXCEPTION 'scope_review_reference_invalid';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.impact_snapshot->'descendants') LOOP
      item_kind=coalesce(item->>'resourceKind','memory');
      IF NOT coalesce(jsonb_typeof(item)='object' AND item ?& ARRAY['resourceId','version','held']
        AND jsonb_typeof(item->'held')='boolean' AND jsonb_typeof(item->'version')='string'
        AND item-(CASE WHEN item ? 'resourceKind' THEN ARRAY['resourceKind','resourceId','version','held']
          ELSE ARRAY['resourceId','version','held'] END)='{}'::jsonb,false) THEN
        RAISE EXCEPTION 'scope_review_reference_invalid';
      END IF;
      current_source=read_scope_review_source(NEW.workspace_id,item_kind,(item->>'resourceId')::uuid);
      IF current_source IS NULL OR current_source->>'version' IS DISTINCT FROM item->>'version'
        OR (current_source->>'held')::boolean IS DISTINCT FROM (item->>'held')::boolean THEN
        RAISE EXCEPTION 'scope_review_reference_invalid';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

-- External review-state holds cover incomplete legacy conversation evidence,
-- whose nullable envelope columns cannot be rewritten into a classification.
CREATE FUNCTION scope_review_state_held(p_kind text,p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM scope_resource_states s
    WHERE s.resource_kind=p_kind AND s.resource_id=p_id AND s.review_state='held')
$$;
CREATE POLICY session_messages_scope_review_holding ON session_messages AS RESTRICTIVE FOR SELECT
  USING (NOT scope_review_state_held('session_message',id));
CREATE POLICY analytics_events_scope_review_holding ON analytics_events AS RESTRICTIVE FOR SELECT
  USING (NOT scope_review_state_held('feedback_event',id));
CREATE POLICY file_cache_scope_review_holding ON file_cache AS RESTRICTIVE FOR SELECT
  USING (NOT scope_review_state_held('file_cache',id));
CREATE POLICY file_segments_scope_review_holding ON file_segments AS RESTRICTIVE FOR SELECT
  USING (NOT scope_review_state_held('file_segment',id));
CREATE POLICY recordings_scope_review_holding ON recordings AS RESTRICTIVE FOR SELECT
  USING (NOT scope_review_state_held('recording',id));
CREATE POLICY transcript_segments_scope_review_holding ON transcript_segments AS RESTRICTIVE FOR SELECT
  USING (NOT scope_review_state_held('transcript_segment',id));
CREATE POLICY entity_instances_scope_review_holding ON entity_instances AS RESTRICTIVE FOR SELECT
  USING (NOT scope_review_state_held('entity_instance',id));
CREATE POLICY blueprint_records_scope_review_holding ON blueprint_records AS RESTRICTIVE FOR SELECT
  USING (NOT scope_review_state_held('blueprint_record',id));
CREATE POLICY office_artifacts_scope_review_holding ON office_artifacts AS RESTRICTIVE FOR SELECT
  USING (NOT scope_review_state_held('office_artifact',id));

COMMIT;
