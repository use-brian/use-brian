BEGIN;
ALTER TABLE programmatic_capture_receipts ADD COLUMN archive_delivery_status text CHECK(archive_delivery_status IN ('pending','archived','excluded','deleted','dropped','held'));
UPDATE programmatic_capture_receipts r SET archive_delivery_status=coalesce((SELECT delivery_status FROM programmatic_archive_events WHERE id=r.archive_id),'pending') WHERE processing_purpose='archive_only';
CREATE FUNCTION engineering_archive_receipt_delivery() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE programmatic_capture_receipts SET archive_delivery_status=NEW.delivery_status WHERE archive_id=NEW.id;
 RETURN NEW;
END $$;
CREATE TRIGGER engineering_archive_receipt_delivery AFTER INSERT OR UPDATE OF delivery_status ON programmatic_archive_events FOR EACH ROW EXECUTE FUNCTION engineering_archive_receipt_delivery();

-- Admission of an archive as an explicit readable File does not admit it as
-- a source for operational descendants in any native derived-resource writer.
ALTER FUNCTION read_entity_derivation_source(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_engineering_archive;
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN k='workspace_file' AND EXISTS(SELECT 1 FROM workspace_files WHERE id=i AND workspace_id=w AND purpose='engineering_archive')
 THEN NULL ELSE read_entity_derivation_source_before_engineering_archive(w,k,i) END
$$;
CREATE FUNCTION guard_engineering_operational_input() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE file uuid;
BEGIN
 file:=CASE WHEN TG_TABLE_NAME='research_artifact_links' THEN CASE WHEN to_jsonb(NEW)->>'kind'='file' THEN (to_jsonb(NEW)->>'artifact_id')::uuid ELSE NULL END ELSE (to_jsonb(NEW)->>'file_id')::uuid END;
 IF file IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_files WHERE id=file AND purpose='engineering_archive')
 THEN RAISE EXCEPTION 'engineering_archive_operational_input_denied' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER engineering_archive_ingest_guard BEFORE INSERT OR UPDATE ON file_ingest_jobs FOR EACH ROW EXECUTE FUNCTION guard_engineering_operational_input();
CREATE TRIGGER engineering_archive_segment_guard BEFORE INSERT OR UPDATE ON file_segments FOR EACH ROW EXECUTE FUNCTION guard_engineering_operational_input();
CREATE TRIGGER engineering_archive_research_guard BEFORE INSERT OR UPDATE ON research_artifact_links FOR EACH ROW EXECUTE FUNCTION guard_engineering_operational_input();
-- A File retraction/hold withholds its derived index immediately; erasure is
-- handled by the native File delete trigger in 760. Replay can never release it.
CREATE FUNCTION withhold_engineering_archive_projection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.purpose='engineering_archive' AND (NEW.retracted_at IS NOT NULL OR NEW.scope_held) THEN
  UPDATE programmatic_archive_events SET delivery_status='excluded',index_text='' WHERE file_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER engineering_archive_file_withheld AFTER UPDATE OF retracted_at,scope_held ON workspace_files FOR EACH ROW EXECUTE FUNCTION withhold_engineering_archive_projection();
CREATE OR REPLACE FUNCTION guard_engineering_archive_batch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ev jsonb; purged jsonb;
BEGIN
 IF TG_OP='UPDATE' AND NEW.processing_purpose IS DISTINCT FROM OLD.processing_purpose THEN RAISE EXCEPTION 'capture_purpose_immutable'; END IF;
 IF NEW.processing_purpose<>'archive_only' THEN RETURN NEW; END IF;
 IF NEW.source<>'programmatic' OR NOT NEW.scope_held THEN RAISE EXCEPTION 'capture_archive_worker_fence'; END IF;
 IF TG_OP='UPDATE' THEN
  SELECT jsonb_agg(value-'content') INTO purged FROM jsonb_array_elements(OLD.events);
  IF NEW.events IS DISTINCT FROM OLD.events AND (NEW.events IS DISTINCT FROM purged
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.events) e WHERE NOT EXISTS(
      SELECT 1 FROM programmatic_capture_receipts WHERE archive_id=(e->>'archiveId')::uuid
      AND archive_delivery_status IN ('archived','excluded','deleted')))) THEN RAISE EXCEPTION 'capture_payload_immutable'; END IF;
  IF (to_jsonb(NEW)-'events'-'processed_at'-'purpose_held'-'archive_claim_until'-'archive_claim_token') IS DISTINCT FROM
    (to_jsonb(OLD)-'events'-'processed_at'-'purpose_held'-'archive_claim_until'-'archive_claim_token') THEN RAISE EXCEPTION 'capture_payload_immutable'; END IF;
  RETURN NEW;
 END IF;
 FOR ev IN SELECT value FROM jsonb_array_elements(NEW.events) LOOP
  IF engineering_capture_current(NEW.workspace_id,NEW.assistant_id,NEW.rule_id,ev) IS NOT TRUE THEN RAISE EXCEPTION 'capture_target_unavailable'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION engineering_archive_receipt_delivery() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE programmatic_capture_receipts SET archive_delivery_status=NEW.delivery_status WHERE archive_id=NEW.id;
 UPDATE pending_ingest_batches SET events=jsonb_build_array((events->0)-'content')
  WHERE processing_purpose='archive_only' AND events->0->>'archiveId'=NEW.id::text AND events->0 ? 'content';
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION engineering_archive_source_current(event uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM programmatic_archive_events e JOIN workspace_files f ON f.id=e.file_id
  JOIN brain_keys k ON k.id=e.principal_id AND k.workspace_id=e.workspace_id
  JOIN workspaces w ON w.id=e.workspace_id JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=e.actor_id
  JOIN assistants a ON a.id=f.created_by_assistant_id AND a.workspace_id=w.id
  WHERE e.id=event AND e.principal_kind='api_key' AND k.status='active' AND k.scope='read_write'
   AND coalesce(k.issuer_user_id,w.owner_user_id)=e.actor_id AND external_brain_key_current(k.id)
   AND sensitivity_rank(coalesce(k.max_clearance,a.clearance))>=sensitivity_rank(f.sensitivity)
   AND sensitivity_rank(a.clearance)>=sensitivity_rank(f.sensitivity)
   AND CASE WHEN w.department_read_v2 THEN
    (f.user_id IS NULL OR f.user_id=m.user_id)
    AND NOT EXISTS(SELECT 1 FROM unnest(f.compartments) label WHERE
      CASE WHEN label LIKE 'team:%' THEN NOT EXISTS(SELECT 1 FROM department_edges edge
        JOIN workspace_groups dept ON dept.id=edge.department_id AND dept.workspace_id=edge.workspace_id
        WHERE edge.workspace_id=w.id AND dept.compartment_key=label AND dept.status='active' AND edge.user_id=m.user_id
          AND (edge.expires_at IS NULL OR edge.expires_at>now()) AND sensitivity_rank(edge.clearance)>=sensitivity_rank(f.sensitivity))
      WHEN label LIKE 'project:%' THEN NOT project_member_live(substr(label,9)::uuid,'user',m.user_id)
      ELSE true END)
    AND (EXISTS(SELECT 1 FROM unnest(f.compartments) label WHERE label LIKE 'team:%') OR sensitivity_rank(m.clearance)>=sensitivity_rank(f.sensitivity))
    ELSE sensitivity_rank(m.clearance)>=sensitivity_rank(f.sensitivity) AND (effective_member_read_compartments(m.user_id,w.id) IS NULL
      OR f.compartments<@effective_member_read_compartments(m.user_id,w.id)) END),false)
$$;
CREATE POLICY engineering_history_current_source ON programmatic_archive_events AS RESTRICTIVE FOR SELECT USING(engineering_archive_source_current(id));
CREATE POLICY engineering_file_current_source ON workspace_files AS RESTRICTIVE FOR SELECT USING(
 purpose<>'engineering_archive' OR current_setting('app.engineering_archive_publication',true)=id::text
 OR engineering_archive_source_current(id)
);
CREATE OR REPLACE FUNCTION guard_programmatic_rule_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p programmatic_capture_profiles;
BEGIN
 IF NEW.capture_profile_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO p FROM programmatic_capture_profiles WHERE id=NEW.capture_profile_id;
 PERFORM 1 FROM workspaces WHERE id=p.workspace_id FOR UPDATE NOWAIT;
 IF p.intake_binding IS NULL THEN
  IF EXISTS(SELECT 1 FROM workspace_access_policies WHERE workspace_id=p.workspace_id AND setup_state='ready')
   THEN RAISE EXCEPTION 'capture_configuration_required'; END IF;
  RETURN NEW;
 END IF;
 IF programmatic_configuration_actor(p.workspace_id,nullif(current_setting('app.current_user_id',true),'')::uuid,
    nullif(current_setting('app.capture_session',true),'')::uuid) IS NOT TRUE THEN RAISE EXCEPTION 'capture_configuration_denied'; END IF;
 IF p.processing_mode<>'archive_only' AND NEW.routing_mode NOT IN ('scheduled','drop') THEN RAISE EXCEPTION 'capture_ready_scheduled_required'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.capture_profile_id,NEW.compartments,NEW.project_ids,NEW.episode_sensitivity,NEW.scope_binding_mode,NEW.scope_binding_origin)
 IS DISTINCT FROM ROW(OLD.capture_profile_id,OLD.compartments,OLD.project_ids,OLD.episode_sensitivity,OLD.scope_binding_mode,OLD.scope_binding_origin)
 THEN RAISE EXCEPTION 'capture_binding_immutable'; END IF;
 IF NEW.compartments IS DISTINCT FROM ARRAY(SELECT jsonb_array_elements_text(p.intake_binding->'compartments'))
 OR NEW.project_ids IS DISTINCT FROM ARRAY(SELECT jsonb_array_elements_text(p.intake_binding->'projectIds')::uuid)
 OR NEW.episode_sensitivity IS DISTINCT FROM p.intake_binding->>'sensitivity'
 OR NEW.scope_binding_mode<>'explicit' OR NEW.scope_binding_origin NOT IN ('explicit','reviewed')
 THEN RAISE EXCEPTION 'capture_binding_mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION check_programmatic_publication_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE batch pending_ingest_batches; ev jsonb;
BEGIN
 IF TG_TABLE_NAME='pending_ingest_batches' AND to_jsonb(NEW)->>'processing_purpose'='archive_only' THEN
  IF NEW.processed_at IS NULL THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.events) event WHERE NOT EXISTS(
    SELECT 1 FROM programmatic_capture_receipts receipt WHERE receipt.batch_id=NEW.id AND receipt.status='completed'
      AND receipt.processing_purpose='archive_only' AND receipt.archive_id=(event->>'archiveId')::uuid
      AND receipt.archive_delivery_status IN ('archived','excluded','deleted')))
    THEN RAISE EXCEPTION 'capture_publication_incomplete'; END IF;
  RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='episodes' THEN
  IF NEW.programmatic_batch_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO batch FROM pending_ingest_batches WHERE id=NEW.programmatic_batch_id;
 ELSE
  IF NEW.source<>'programmatic' OR NEW.processed_at IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO batch FROM pending_ingest_batches WHERE id=NEW.id;
  IF NOT EXISTS(SELECT 1 FROM ingest_rules r JOIN programmatic_capture_profiles p ON p.id=r.capture_profile_id WHERE r.id=batch.rule_id AND p.intake_binding IS NOT NULL) THEN RETURN NULL; END IF;
 END IF;
 IF batch.id IS NULL OR batch.scope_held OR batch.processed_at IS NULL
 OR NOT EXISTS(SELECT 1 FROM episodes e JOIN episode_extraction_runs r ON r.episode_id=e.id
  WHERE e.programmatic_batch_id=batch.id AND e.workspace_id=batch.workspace_id
  AND e.status='archived' AND NOT e.scope_held AND NOT e.extraction_locked
  AND r.application_state='complete' AND r.extraction_state='succeeded' AND NOT r.scope_held
  AND r.source_scope_version=e.scope_version
  AND jsonb_array_length(r.frozen_plan->'candidates')>0
  AND jsonb_array_length(r.frozen_plan->'candidates')=(SELECT count(*) FROM episode_extraction_items i WHERE i.run_id=r.id)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.frozen_plan->'candidates') candidate
    WHERE NOT EXISTS(SELECT 1 FROM episode_extraction_items i WHERE i.run_id=r.id
      AND i.candidate_id=candidate->>'candidateId' AND i.payload_hash=candidate->>'payloadHash'
      AND i.primitive_kind=candidate->>'primitiveKind' AND i.disposition='committed'
      AND i.receipt_id IS NOT NULL AND i.target_record_id IS NOT NULL)))
 THEN RAISE EXCEPTION 'capture_publication_incomplete'; END IF;
 FOR ev IN SELECT value FROM jsonb_array_elements(batch.events) LOOP
  IF NOT ev ? 'producerBinding' OR programmatic_intake_current(batch.workspace_id,batch.assistant_id,batch.rule_id,ev) IS NOT TRUE
  THEN RAISE EXCEPTION 'capture_binding_unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM programmatic_capture_receipts receipt WHERE receipt.batch_id=batch.id
    AND receipt.workspace_id=batch.workspace_id AND receipt.rule_id=batch.rule_id AND receipt.status='completed'
    AND receipt.principal_kind=ev->>'principalKind' AND receipt.principal_id=(ev->>'principalId')::uuid
    AND receipt.event_id=ev->>'eventId') THEN RAISE EXCEPTION 'capture_publication_incomplete'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
COMMIT;
