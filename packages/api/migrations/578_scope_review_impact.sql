BEGIN;

ALTER TABLE workspace_scope_review_items ADD COLUMN impact_snapshot jsonb
  CHECK(impact_snapshot IS NULL OR coalesce(jsonb_typeof(impact_snapshot)='object'
    AND impact_snapshot->>'version'='1' AND jsonb_typeof(impact_snapshot->'descendants')='array',false));

CREATE FUNCTION guard_scope_review_impact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item jsonb; current_version text; current_held boolean;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.impact_snapshot IS DISTINCT FROM OLD.impact_snapshot THEN
      RAISE EXCEPTION 'scope_review_proposal_immutable';
    END IF;
  ELSIF NEW.impact_snapshot IS NOT NULL THEN
    IF jsonb_array_length(NEW.impact_snapshot->'descendants')>500
      OR (SELECT count(*)<>count(DISTINCT value->>'resourceId') FROM jsonb_array_elements(NEW.impact_snapshot->'descendants')) THEN
      RAISE EXCEPTION 'scope_review_reference_invalid';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.impact_snapshot->'descendants') LOOP
      IF NOT coalesce(jsonb_typeof(item)='object' AND item ?& ARRAY['resourceId','version','held']
        AND jsonb_typeof(item->'held')='boolean' AND jsonb_typeof(item->'version')='string'
        AND item-ARRAY['resourceId','version','held']='{}'::jsonb,false) THEN
        RAISE EXCEPTION 'scope_review_reference_invalid';
      END IF;
      SELECT scope_version::text,scope_held INTO current_version,current_held
        FROM memories WHERE workspace_id=NEW.workspace_id AND id=(item->>'resourceId')::uuid FOR SHARE;
      IF NOT FOUND OR current_version IS DISTINCT FROM item->>'version'
        OR current_held IS DISTINCT FROM (item->>'held')::boolean THEN
        RAISE EXCEPTION 'scope_review_reference_invalid';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_scope_review_impact_immutable BEFORE INSERT OR UPDATE ON workspace_scope_review_items
  FOR EACH ROW EXECUTE FUNCTION guard_scope_review_impact();

CREATE FUNCTION scope_source_ancestors(p_workspace uuid,p_kind text,p_id uuid)
RETURNS TABLE(resource_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tab text;
BEGIN
  tab=scope_source_table(p_kind);
  IF tab IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  RETURN QUERY EXECUTE format('WITH RECURSIVE ancestry(id) AS (
    SELECT id FROM %I WHERE workspace_id=$2 AND id=$1
    UNION SELECT r.id FROM %I r JOIN ancestry a ON nullif(to_jsonb(r)->>''superseded_by'','''')::uuid=a.id WHERE r.workspace_id=$2)
    SELECT id FROM ancestry',tab,tab) USING p_id,p_workspace;
END;
$$;
REVOKE ALL ON FUNCTION scope_source_ancestors(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION scope_descendant_memories(p_workspace uuid,p_kind text,p_id uuid)
RETURNS TABLE(resource_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH RECURSIVE descendants(kind,id) AS (
    SELECT d.resource_kind,d.resource_id FROM scope_derivation_sources s
      JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id
      WHERE s.workspace_id=p_workspace AND s.source_kind=p_kind
        AND s.source_id IN(SELECT resource_id FROM scope_source_ancestors(p_workspace,p_kind,p_id))
    UNION
    SELECT d.resource_kind,d.resource_id FROM descendants p
      JOIN scope_derivation_sources s ON s.source_kind=p.kind AND s.source_id=p.id AND s.workspace_id=p_workspace
      JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id
  ) SELECT id FROM descendants WHERE kind='memory'
$$;
REVOKE ALL ON FUNCTION scope_descendant_memories(uuid,text,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION hold_scope_descendants(target_workspace uuid,target_kind text,target_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE affected uuid[]; policy_revision bigint;
BEGIN
  SELECT array_agg(resource_id) INTO affected FROM scope_descendant_memories(target_workspace,target_kind,target_id);
  INSERT INTO workspace_access_policies(workspace_id,revision) VALUES(target_workspace,2)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=workspace_access_policies.revision+1,updated_at=now()
    RETURNING revision INTO policy_revision;
  IF affected IS NULL THEN RETURN; END IF;
  UPDATE memories SET scope_held=true WHERE workspace_id=target_workspace AND id=ANY(affected);
  INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
    SELECT workspace_id,'memory',id,scope_version::text,'held',policy_revision,'source_changed'
      FROM memories WHERE workspace_id=target_workspace AND id=ANY(affected)
    ON CONFLICT(workspace_id,resource_kind,resource_id,resource_version) DO UPDATE
      SET review_state='held',classification_revision=EXCLUDED.classification_revision,holding_reason='source_changed',updated_at=now();
END;
$$;

COMMIT;
