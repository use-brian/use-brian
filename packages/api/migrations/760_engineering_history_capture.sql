BEGIN;
ALTER TABLE programmatic_capture_profiles ADD COLUMN processing_mode text NOT NULL DEFAULT 'extract' CHECK(processing_mode IN ('extract','archive_only'));
ALTER TABLE programmatic_capture_profiles ADD COLUMN revision bigint NOT NULL DEFAULT 1;
ALTER TABLE workspace_files ADD COLUMN purpose text NOT NULL DEFAULT 'operational' CHECK(purpose IN ('operational','engineering_archive'));
ALTER TABLE pending_ingest_batches ADD COLUMN processing_purpose text NOT NULL DEFAULT 'extract' CHECK(processing_purpose IN ('extract','archive_only'));
ALTER TABLE pending_ingest_batches ADD COLUMN archive_claim_until timestamptz;
ALTER TABLE pending_ingest_batches ADD COLUMN archive_claim_token uuid;
ALTER TABLE pending_ingest_batches ADD COLUMN purpose_held boolean NOT NULL DEFAULT false;
ALTER TABLE programmatic_capture_receipts ADD COLUMN processing_purpose text NOT NULL DEFAULT 'extract' CHECK(processing_purpose IN ('extract','archive_only'));
ALTER TABLE programmatic_capture_receipts ADD COLUMN payload_digest text;
ALTER TABLE programmatic_capture_receipts ADD COLUMN archive_id uuid;
ALTER TABLE programmatic_capture_receipts ADD COLUMN archive_actor_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE programmatic_archive_events (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 principal_kind text NOT NULL CHECK(principal_kind IN ('api_key','oauth_token','home_app')),
 principal_id uuid NOT NULL,
 event_id text NOT NULL,
 actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
 profile_id uuid REFERENCES programmatic_capture_profiles(id) ON DELETE SET NULL,
 profile_revision bigint NOT NULL,
 rule_id uuid REFERENCES ingest_rules(id) ON DELETE SET NULL,
 source_provider text NOT NULL,
 source_session text,
 source_turn text,
 event_kind text NOT NULL CHECK(event_kind IN ('user','assistant')),
 claimed_subject text,
 attribution_quality text NOT NULL DEFAULT 'reported_unverified',
 occurred_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY,
 content_digest text NOT NULL,
 file_id uuid REFERENCES workspace_files(id) ON DELETE SET NULL,
 file_version bigint,
 delivery_status text NOT NULL CHECK(delivery_status IN ('archived','excluded','deleted')),
 index_text text NOT NULL DEFAULT '',
 search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple',index_text)) STORED,
 annotations jsonb NOT NULL DEFAULT '[]',
 UNIQUE(workspace_id,principal_kind,principal_id,event_id)
);
CREATE INDEX engineering_history_search ON programmatic_archive_events USING gin(search_vector);
CREATE INDEX engineering_history_sequence ON programmatic_archive_events(workspace_id,sequence);
ALTER TABLE programmatic_archive_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY engineering_history_file_read ON programmatic_archive_events FOR SELECT USING (
 file_id IN (SELECT id FROM workspace_files WHERE purpose='engineering_archive' AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held)
);
CREATE POLICY engineering_history_actor_insert ON programmatic_archive_events FOR INSERT WITH CHECK (
 actor_id=nullif(current_setting('app.current_user_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=programmatic_archive_events.workspace_id AND user_id=actor_id)
);
CREATE POLICY engineering_history_file_update ON programmatic_archive_events FOR UPDATE USING (
 file_id IN (SELECT id FROM workspace_files WHERE purpose='engineering_archive' AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held
  AND member_operation_scope_allows(workspace_id,sensitivity,compartments,true))
) WITH CHECK (
 file_id IN (SELECT id FROM workspace_files WHERE purpose='engineering_archive' AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held
  AND member_operation_scope_allows(workspace_id,sensitivity,compartments,true))
);
CREATE POLICY engineering_archive_receipt_actor ON programmatic_capture_receipts USING (
 processing_purpose='archive_only' AND archive_actor_id=nullif(current_setting('app.current_user_id',true),'')::uuid
) WITH CHECK (
 processing_purpose='archive_only' AND archive_actor_id=nullif(current_setting('app.current_user_id',true),'')::uuid
);

CREATE FUNCTION engineering_capture_current(w uuid,a uuid,r uuid,ev jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k brain_keys; p programmatic_capture_profiles; rule ingest_rules; actor uuid;
BEGIN
 SELECT * INTO rule FROM ingest_rules WHERE id=r AND source='programmatic';
 SELECT * INTO p FROM programmatic_capture_profiles WHERE id=rule.capture_profile_id AND workspace_id=w AND enabled AND processing_mode='archive_only';
 actor:=(ev->>'actingUserId')::uuid;
 IF p.id IS NULL OR p.revision::text IS DISTINCT FROM ev->>'profileRevision' OR rule.scope_binding_origin='held'
 OR ev->>'processingPurpose' IS DISTINCT FROM 'archive_only' OR ev->>'principalKind'<>'api_key'
 OR ev->'ruleSnapshot' IS DISTINCT FROM to_jsonb(rule) THEN RETURN false; END IF;
 SELECT * INTO k FROM brain_keys WHERE id=(ev->>'principalId')::uuid AND workspace_id=w AND status='active' AND scope='read_write' FOR SHARE;
 IF k.id IS NULL OR k.capture_intake_revision::text IS DISTINCT FROM ev->>'keyRevision'
 OR coalesce(k.issuer_user_id,(SELECT owner_user_id FROM workspaces WHERE id=w)) IS DISTINCT FROM actor
 OR k.capture_assistant_id IS DISTINCT FROM a
 OR coalesce(k.capture_profile_id,(SELECT capture_profile_id FROM assistants WHERE id=a AND workspace_id=w)) IS DISTINCT FROM p.id
 OR external_brain_key_current(k.id) IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
 OR NOT EXISTS(SELECT 1 FROM assistants WHERE id=a AND workspace_id=w AND context_binding_origin<>'held'
   AND sensitivity_rank(clearance)>=sensitivity_rank(ev->>'sensitivity'))
 OR (k.max_clearance IS NOT NULL AND sensitivity_rank(k.max_clearance)<sensitivity_rank(ev->>'sensitivity'))
 THEN RETURN false; END IF;
 IF p.intake_binding IS NOT NULL AND programmatic_intake_current(w,a,r,ev) IS NOT TRUE THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;

CREATE POLICY engineering_archive_batch_actor ON pending_ingest_batches USING (
 processing_purpose='archive_only' AND jsonb_array_length(events)=1
 AND events->0->>'actingUserId'=current_setting('app.current_user_id',true)
) WITH CHECK (
 processing_purpose='archive_only' AND jsonb_array_length(events)=1
 AND events->0->>'actingUserId'=current_setting('app.current_user_id',true)
 AND engineering_capture_current(workspace_id,assistant_id,rule_id,events->0)
);

-- The existing extraction-only decoder cannot defeat a hold. Archive workers
-- use the explicit purpose claimant and never clear this compatibility fence.
DROP TRIGGER programmatic_batch_binding_guard ON pending_ingest_batches;
CREATE TRIGGER programmatic_batch_binding_guard BEFORE INSERT OR UPDATE ON pending_ingest_batches
 FOR EACH ROW WHEN (NEW.processing_purpose='extract') EXECUTE FUNCTION guard_programmatic_batch_binding();
CREATE FUNCTION guard_engineering_archive_batch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ev jsonb;
BEGIN
 IF TG_OP='UPDATE' AND NEW.processing_purpose IS DISTINCT FROM OLD.processing_purpose THEN RAISE EXCEPTION 'capture_purpose_immutable'; END IF;
 IF NEW.processing_purpose<>'archive_only' THEN RETURN NEW; END IF;
 IF NEW.source<>'programmatic' OR NOT NEW.scope_held THEN RAISE EXCEPTION 'capture_archive_worker_fence'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'processed_at'-'purpose_held'-'archive_claim_until'-'archive_claim_token') IS DISTINCT FROM (to_jsonb(OLD)-'processed_at'-'purpose_held'-'archive_claim_until'-'archive_claim_token') THEN RAISE EXCEPTION 'capture_payload_immutable'; END IF;
  RETURN NEW;
 END IF;
 FOR ev IN SELECT value FROM jsonb_array_elements(NEW.events) LOOP
  IF engineering_capture_current(NEW.workspace_id,NEW.assistant_id,NEW.rule_id,ev) IS NOT TRUE THEN RAISE EXCEPTION 'capture_target_unavailable'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER engineering_archive_batch_guard BEFORE INSERT OR UPDATE ON pending_ingest_batches FOR EACH ROW EXECUTE FUNCTION guard_engineering_archive_batch();

CREATE FUNCTION version_engineering_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'revision'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'revision'-'updated_at') THEN
  NEW.revision:=OLD.revision+1;
  UPDATE pending_ingest_batches SET purpose_held=true,scope_held=true WHERE processed_at IS NULL AND source='programmatic'
    AND rule_id IN (SELECT id FROM ingest_rules WHERE capture_profile_id=OLD.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER engineering_profile_revision BEFORE UPDATE ON programmatic_capture_profiles FOR EACH ROW EXECUTE FUNCTION version_engineering_profile();

CREATE FUNCTION guard_engineering_file_purpose() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.purpose='engineering_archive'
 AND current_setting('app.engineering_archive_publication',true) IS DISTINCT FROM NEW.id::text
 THEN RAISE EXCEPTION 'archive_publication_required' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND OLD.purpose='engineering_archive' AND
 (to_jsonb(NEW)-'scope_held'-'retracted_at'-'retracted_reason'-'retracted_by'-'updated_at'-'scope_version') IS DISTINCT FROM
 (to_jsonb(OLD)-'scope_held'-'retracted_at'-'retracted_reason'-'retracted_by'-'updated_at'-'scope_version')
 THEN RAISE EXCEPTION 'archive_original_immutable' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND NEW.purpose IS DISTINCT FROM OLD.purpose THEN RAISE EXCEPTION 'archive_purpose_immutable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER engineering_file_purpose BEFORE INSERT OR UPDATE ON workspace_files FOR EACH ROW EXECUTE FUNCTION guard_engineering_file_purpose();
CREATE FUNCTION erase_engineering_archive_projection() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE programmatic_archive_events SET delivery_status='deleted',index_text='',annotations='[]',source_session=NULL,source_turn=NULL,claimed_subject=NULL,
  file_id=NULL,file_version=NULL WHERE file_id=OLD.id;
 RETURN OLD;
END $$;
CREATE TRIGGER engineering_archive_file_erasure BEFORE DELETE ON workspace_files FOR EACH ROW EXECUTE FUNCTION erase_engineering_archive_projection();
COMMIT;
