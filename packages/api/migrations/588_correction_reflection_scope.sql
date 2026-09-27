BEGIN;

ALTER TABLE correction_audit ADD COLUMN source_scope jsonb,
  ADD COLUMN scope_version bigint NOT NULL DEFAULT 1 CHECK(scope_version>0),
  ADD COLUMN scope_held boolean NOT NULL DEFAULT false;
ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check
 CHECK(source_kind IN('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','crm_event','memory_verification','brain_verification','correction_audit'));

-- Historical rows stay unproven. Never manufacture an audience from a caller's
-- row_snapshot; only the canonical target at receipt insertion is evidence.
CREATE FUNCTION capture_correction_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE kind text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.source_scope IS NOT NULL THEN RAISE EXCEPTION 'correction_scope_server_owned'; END IF;
    kind=CASE WHEN NEW.primitive IN('contact','company','deal') THEN 'entity' ELSE NEW.primitive END;
    IF scope_source_table(kind) IS NOT NULL THEN NEW.source_scope=read_scope_source(NEW.workspace_id,kind,NEW.row_id); END IF;
  ELSE
    IF ROW(NEW.id,NEW.workspace_id,NEW.primitive,NEW.row_id,NEW.source_scope)
      IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.primitive,OLD.row_id,OLD.source_scope)
      OR (OLD.scope_held AND NOT NEW.scope_held) THEN RAISE EXCEPTION 'correction_scope_immutable'; END IF;
  END IF;
  IF NEW.row_snapshot @> '{"erased":true}'::jsonb OR NEW.detail @> '{"erased":true}'::jsonb THEN NEW.scope_held=true; END IF;
  RETURN NEW;
END;
$$;
-- Before the version trigger so erasure and protected metadata changes version
-- the exact receipt that readers will later see.
CREATE TRIGGER a_correction_scope BEFORE INSERT OR UPDATE ON correction_audit
 FOR EACH ROW EXECUTE FUNCTION capture_correction_scope();
CREATE TRIGGER canonical_scope_version BEFORE UPDATE OR DELETE ON correction_audit
 FOR EACH ROW EXECUTE FUNCTION advance_canonical_scope_version('correction_audit');
CREATE POLICY correction_scope_read ON correction_audit AS RESTRICTIVE FOR SELECT
 USING(NOT scope_held AND verification_scope_allows(workspace_id,source_scope));

CREATE OR REPLACE FUNCTION read_verification_scope(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tab text; receipt jsonb; target jsonb; envelope jsonb; target_tab text; target_id uuid;
  seen uuid[]=ARRAY[]::uuid[]; versions jsonb='[]'; next_id uuid;
BEGIN
  tab=CASE k WHEN 'memory_verification' THEN 'memory_verifications' WHEN 'brain_verification' THEN 'brain_verifications' WHEN 'correction_audit' THEN 'correction_audit' END;
  IF tab IS NULL THEN RETURN NULL; END IF;
  EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE workspace_id=$1 AND id=$2 FOR SHARE',tab) INTO receipt USING w,i;
  IF receipt IS NULL OR receipt->>'scope_held' IS DISTINCT FROM 'false' OR receipt->'source_scope' IS NULL OR receipt->'source_scope'='null' THEN RETURN NULL; END IF;
  IF k='correction_audit' AND (receipt->>'action' NOT IN('retract','soft_delete') OR receipt->'row_snapshot' @> '{"erased":true}'::jsonb OR receipt->'detail' @> '{"erased":true}'::jsonb) THEN RETURN NULL; END IF;
  envelope=receipt->'source_scope';
  IF envelope->>'workspaceId' IS DISTINCT FROM w::text OR envelope->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL; END IF;
  target_tab=scope_source_table(envelope->>'resourceKind');
  IF target_tab IS NULL THEN RETURN NULL; END IF;
  target_id=(envelope->>'resourceId')::uuid;
  LOOP
    IF target_id IS NULL OR target_id=ANY(seen) OR cardinality(seen)>=128 THEN RETURN NULL; END IF;
    seen=array_append(seen,target_id);
    EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE workspace_id=$1 AND id=$2 FOR SHARE',target_tab) INTO target USING w,target_id;
    IF target IS NULL OR target->>'scope_held' IS DISTINCT FROM 'false' THEN RETURN NULL; END IF;
    envelope=join_correction_scope(envelope,jsonb_build_object('workspaceId',target->'workspace_id',
      'userId',target->'user_id','assistantId',target->'assistant_id','sensitivity',target->'sensitivity',
      'compartments',target->'compartments','projectIds',target->'project_ids'));
    IF envelope IS NULL THEN RETURN NULL; END IF;
    versions=versions||jsonb_build_array(jsonb_build_array(target_id,target->>'scope_version'));
    next_id=nullif(target->>'superseded_by','')::uuid;
    EXIT WHEN next_id IS NULL;
    target_id=next_id;
  END LOOP;
  RETURN envelope||jsonb_build_object('resourceKind',k,'resourceId',i,
    'version',(receipt->>'scope_version')||':'||(receipt->>'created_at')||':'||versions::text,
    'held',false,'validTo',NULL,'retractedAt',NULL);
END;
$$;

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

CREATE OR REPLACE FUNCTION scope_source_ancestors(p_workspace uuid,p_kind text,p_id uuid)
RETURNS TABLE(resource_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tab text;
BEGIN
  IF p_kind IN('crm_event','memory_verification','brain_verification','correction_audit') THEN RETURN QUERY SELECT p_id; RETURN; END IF;
  tab=scope_source_table(p_kind);
  IF tab IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  RETURN QUERY EXECUTE format('WITH RECURSIVE ancestry(id) AS (
    SELECT id FROM %I WHERE workspace_id=$2 AND id=$1
    UNION SELECT r.id FROM %I r JOIN ancestry a ON nullif(to_jsonb(r)->>''superseded_by'','''')::uuid=a.id WHERE r.workspace_id=$2)
    SELECT id FROM ancestry',tab,tab) USING p_id,p_workspace;
END;
$$;

CREATE OR REPLACE FUNCTION scope_descendant_memories(p_workspace uuid,p_kind text,p_id uuid)
RETURNS TABLE(resource_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH RECURSIVE edges(source_kind,source_id,kind,id) AS (
   SELECT s.source_kind,s.source_id,d.resource_kind,d.resource_id FROM scope_derivation_sources s
     JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id WHERE s.workspace_id=p_workspace
   UNION ALL SELECT v.source_scope->>'resourceKind',(v.source_scope->>'resourceId')::uuid,'memory_verification',v.id
     FROM memory_verifications v WHERE v.workspace_id=p_workspace AND v.source_scope IS NOT NULL
   UNION ALL SELECT v.source_scope->>'resourceKind',(v.source_scope->>'resourceId')::uuid,'brain_verification',v.id
     FROM brain_verifications v WHERE v.workspace_id=p_workspace AND v.source_scope IS NOT NULL
   UNION ALL SELECT v.source_scope->>'resourceKind',(v.source_scope->>'resourceId')::uuid,'correction_audit',v.id
     FROM correction_audit v WHERE v.workspace_id=p_workspace AND v.source_scope IS NOT NULL
 ), descendants(kind,id,derived) AS (
   SELECT p_kind,resource_id,false FROM scope_source_ancestors(p_workspace,p_kind,p_id)
   UNION SELECT e.kind,e.id,true FROM descendants p JOIN edges e ON e.source_kind=p.kind AND e.source_id=p.id
 ) SELECT DISTINCT id FROM descendants WHERE kind='memory' AND derived

$$;

CREATE OR REPLACE FUNCTION hold_memory_verification_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE receipt record;
BEGIN
  FOR receipt IN
    SELECT DISTINCT v.workspace_id,v.id,v.kind FROM after_rows n JOIN before_rows o ON o.id=n.id
    CROSS JOIN LATERAL scope_source_ancestors(o.workspace_id,'memory',o.id) roots
    JOIN (SELECT workspace_id,id,source_scope,'memory_verification'::text AS kind FROM memory_verifications
      UNION ALL SELECT workspace_id,id,source_scope,'correction_audit' FROM correction_audit) v ON v.workspace_id=o.workspace_id AND v.source_scope->>'resourceKind'='memory'
      AND (v.source_scope->>'resourceId')::uuid=roots.resource_id
    WHERE ROW(n.scope_held,n.valid_to,n.superseded_by) IS DISTINCT FROM ROW(o.scope_held,o.valid_to,o.superseded_by)
  LOOP
    PERFORM hold_scope_descendants(receipt.workspace_id,receipt.kind,receipt.id);
  END LOOP;
  RETURN NULL;
END;
$$;

COMMIT;
