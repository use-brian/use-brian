BEGIN;
ALTER TABLE engineering_history_commands ADD COLUMN command_kind text NOT NULL DEFAULT 'event' CHECK(command_kind IN ('event','pending_discard'));
ALTER TABLE engineering_history_commands ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE engineering_history_commands ADD CONSTRAINT engineering_command_selection CHECK((command_kind='event')=(event_id IS NOT NULL));
-- Keep accepted WIP and completed replay identity across parent cascades.
CREATE FUNCTION guard_engineering_batch_erasure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.processing_purpose<>'archive_only' THEN RETURN OLD; END IF;
 IF OLD.processed_at IS NULL
  AND EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
  AND EXISTS(SELECT 1 FROM users WHERE id=(OLD.events->0->>'actingUserId')::uuid)
 THEN RAISE EXCEPTION 'capture_pending_archive_review_required' USING ERRCODE='23503'; END IF;
 UPDATE programmatic_capture_receipts SET batch_id=NULL WHERE batch_id=OLD.id AND processing_purpose='archive_only';
 RETURN OLD;
END $$;
CREATE TRIGGER engineering_archive_batch_erasure BEFORE DELETE ON pending_ingest_batches
 FOR EACH ROW EXECUTE FUNCTION guard_engineering_batch_erasure();
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
      AND archive_delivery_status IN ('archived','excluded','deleted','dropped')))) THEN RAISE EXCEPTION 'capture_payload_immutable'; END IF;
  IF (to_jsonb(NEW)-'events'-'processed_at'-'purpose_held'-'archive_claim_until'-'archive_claim_token') IS DISTINCT FROM
    (to_jsonb(OLD)-'events'-'processed_at'-'purpose_held'-'archive_claim_until'-'archive_claim_token') THEN RAISE EXCEPTION 'capture_payload_immutable'; END IF;
  RETURN NEW;
 END IF;
 FOR ev IN SELECT value FROM jsonb_array_elements(NEW.events) LOOP
  IF engineering_capture_current(NEW.workspace_id,NEW.assistant_id,NEW.rule_id,ev) IS NOT TRUE THEN RAISE EXCEPTION 'capture_target_unavailable'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION check_programmatic_publication_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE batch pending_ingest_batches; ev jsonb;
BEGIN
 IF TG_TABLE_NAME='pending_ingest_batches' AND to_jsonb(NEW)->>'processing_purpose'='archive_only' THEN
  IF NEW.processed_at IS NULL THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.events) event WHERE NOT EXISTS(
    SELECT 1 FROM programmatic_capture_receipts receipt WHERE receipt.batch_id=NEW.id AND receipt.status IN ('completed','dropped')
      AND ((receipt.status='dropped')=(receipt.archive_delivery_status='dropped'))
      AND receipt.processing_purpose='archive_only' AND receipt.archive_id=(event->>'archiveId')::uuid
      AND receipt.archive_delivery_status IN ('archived','excluded','deleted','dropped')))
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
