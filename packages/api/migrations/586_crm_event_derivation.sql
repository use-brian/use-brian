BEGIN;

ALTER TABLE crm_domain_event_outbox ADD COLUMN scope_version bigint NOT NULL DEFAULT 1 CHECK(scope_version>0);
ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check
  CHECK(source_kind IN('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','crm_event'));

CREATE OR REPLACE FUNCTION read_scope_source(p_workspace uuid,p_kind text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tab text; row_json jsonb; ev crm_domain_event_outbox;
BEGIN
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
REVOKE ALL ON FUNCTION read_scope_source(uuid,text,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION scope_source_ancestors(p_workspace uuid,p_kind text,p_id uuid)
RETURNS TABLE(resource_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tab text;
BEGIN
  IF p_kind='crm_event' THEN RETURN QUERY SELECT p_id; RETURN; END IF;
  tab=scope_source_table(p_kind);
  IF tab IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  RETURN QUERY EXECUTE format('WITH RECURSIVE ancestry(id) AS (
    SELECT id FROM %I WHERE workspace_id=$2 AND id=$1
    UNION SELECT r.id FROM %I r JOIN ancestry a ON nullif(to_jsonb(r)->>''superseded_by'','''')::uuid=a.id WHERE r.workspace_id=$2)
    SELECT id FROM ancestry',tab,tab) USING p_id,p_workspace;
END;
$$;
REVOKE ALL ON FUNCTION scope_source_ancestors(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION advance_crm_event_scope_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
      PERFORM hold_scope_descendants(OLD.workspace_id,'crm_event',OLD.id);
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.payload,NEW.scope_held,NEW.scope_source,NEW.status='retired',NEW.created_at,NEW.occurred_at,NEW.actor_kind,NEW.event_key)
    IS DISTINCT FROM ROW(OLD.payload,OLD.scope_held,OLD.scope_source,OLD.status='retired',OLD.created_at,OLD.occurred_at,OLD.actor_kind,OLD.event_key) THEN
    NEW.scope_version=OLD.scope_version+1;
    PERFORM hold_scope_descendants(OLD.workspace_id,'crm_event',OLD.id);
  ELSE NEW.scope_version=OLD.scope_version;
  END IF;
  RETURN NEW;
END;
$$;
-- Run after the event privacy/scope guards so canonical retirement is observed.
CREATE TRIGGER zz_crm_event_scope_version BEFORE UPDATE OR DELETE ON crm_domain_event_outbox
  FOR EACH ROW EXECUTE FUNCTION advance_crm_event_scope_version();

CREATE FUNCTION hold_rebound_crm_event_derivations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)->TG_ARGV[1]) IS NOT DISTINCT FROM (to_jsonb(OLD)->TG_ARGV[1])
    AND NEW.workspace_id=OLD.workspace_id AND NEW.id=OLD.id THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
    -- Permanently invalidate the old binding. Changing it back later cannot
    -- revive an in-flight source snapshot; the event guard forbids unholding.
    UPDATE crm_domain_event_outbox SET scope_held=true
      WHERE workspace_id=OLD.workspace_id AND subject_kind=TG_ARGV[0]
        AND subject_id=OLD.id AND NOT scope_held;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_event_source_rebound BEFORE UPDATE OR DELETE ON association_enquiries
  FOR EACH ROW EXECUTE FUNCTION hold_rebound_crm_event_derivations('submission','contact_id');
CREATE TRIGGER crm_event_source_rebound BEFORE UPDATE OR DELETE ON association_memberships
  FOR EACH ROW EXECUTE FUNCTION hold_rebound_crm_event_derivations('entitlement','contact_id');
CREATE TRIGGER crm_event_source_rebound BEFORE UPDATE OR DELETE ON association_registrations
  FOR EACH ROW EXECUTE FUNCTION hold_rebound_crm_event_derivations('participation','attendee_contact_id');

COMMIT;
