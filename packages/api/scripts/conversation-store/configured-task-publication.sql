-- [COMP:api/configured-capture-authority]
-- Candidate source only. The authenticated successor renderer owns allocation,
-- predecessor authentication, routine enrollment and portable restore rosters.
-- No applied migration is changed by this source.
ALTER TABLE public.episode_extraction_items
 ADD COLUMN configured_txid xid8,
 ADD COLUMN configured_backend_pid integer,
 ADD COLUMN configured_source jsonb,
 ADD COLUMN configured_task jsonb,
 ADD CONSTRAINT configured_task_receipt_complete CHECK (
  num_nonnulls(configured_txid,configured_backend_pid,configured_source,configured_task) IN (0,4));
CREATE UNIQUE INDEX episode_extraction_items_configured_target
 ON public.episode_extraction_items(target_record_id) WHERE configured_txid IS NOT NULL;

-- SECURITY INVOKER is intentional: inspect the actual UPDATE role, rather than
-- upgrading a direct caller to the table owner before validating its seal.
CREATE FUNCTION public.protect_configured_task_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE owner_name name; proof jsonb; actual_task jsonb; actual_source jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  IF num_nonnulls(NEW.configured_txid,NEW.configured_backend_pid,NEW.configured_source,NEW.configured_task)<>0
   THEN RAISE EXCEPTION 'capture_receipt_not_caller_mintable' USING ERRCODE='42501';END IF;
  RETURN NEW;
 END IF;
 IF ROW(NEW.configured_txid,NEW.configured_backend_pid,NEW.configured_source,NEW.configured_task)
  IS DISTINCT FROM ROW(OLD.configured_txid,OLD.configured_backend_pid,OLD.configured_source,OLD.configured_task) THEN
  SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid='public.episode_extraction_items'::regclass;
  proof:=nullif(current_setting('app.programmatic_candidate_source',true),'')::jsonb;
  actual_source:=public.programmatic_candidate_source();
  SELECT to_jsonb(t) INTO actual_task FROM public.tasks t WHERE t.id=(NEW.target_record_id)::uuid;
  IF current_user<>owner_name OR pg_trigger_depth()<>2 OR OLD.configured_txid IS NOT NULL
   OR OLD.disposition<>'pending' OR NEW.disposition<>'pending' OR OLD.primitive_kind<>'task'
   OR NEW.configured_txid IS DISTINCT FROM pg_current_xact_id()
   OR NEW.configured_backend_pid IS DISTINCT FROM pg_backend_pid()
   OR proof IS NULL OR proof->>'kind' IS DISTINCT FROM 'task'
   OR proof->>'runId' IS DISTINCT FROM NEW.run_id::text
   OR proof->>'candidateId' IS DISTINCT FROM NEW.candidate_id
   OR proof->>'payloadHash' IS DISTINCT FROM NEW.payload_hash
   OR NEW.configured_source->>'batchId' IS DISTINCT FROM proof->>'batchId'
   OR NEW.configured_source->'source' IS DISTINCT FROM actual_source
   OR NEW.configured_task IS DISTINCT FROM actual_task
   OR NEW.configured_task->>'id' IS DISTINCT FROM NEW.target_record_id
   THEN RAISE EXCEPTION 'capture_receipt_not_caller_mintable' USING ERRCODE='42501';END IF;
 ELSIF OLD.configured_txid IS NOT NULL AND NEW.target_record_id IS DISTINCT FROM OLD.target_record_id THEN
  RAISE EXCEPTION 'capture_candidate_target_changed' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.protect_configured_task_receipt() FROM PUBLIC,app_user;
CREATE TRIGGER configured_task_receipt_guard BEFORE INSERT OR UPDATE ON public.episode_extraction_items
 FOR EACH ROW EXECUTE FUNCTION public.protect_configured_task_receipt();

CREATE FUNCTION public.seal_configured_task_candidate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof jsonb; source jsonb; candidate jsonb; content_hash text; source_ref_hash text; events_hash text; run public.episode_extraction_runs; item public.episode_extraction_items;
BEGIN
 IF TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' OR TG_RELID<>'public.tasks'::regclass THEN
  RAISE EXCEPTION 'capture_task_trigger_required' USING ERRCODE='42501';END IF;
 proof:=nullif(current_setting('app.programmatic_candidate_source',true),'')::jsonb;
 IF proof IS NULL OR proof->>'kind'<>'task' THEN RETURN NULL;END IF;
 source:=public.programmatic_candidate_source();
 SELECT * INTO run FROM public.episode_extraction_runs r
 WHERE r.id=(proof->>'runId')::uuid AND r.workspace_id=NEW.workspace_id AND r.episode_id=NEW.source_episode_id
  AND r.source_scope_version::text=source->>'version' AND r.application_state='not_started' AND NOT r.scope_held FOR SHARE;
 SELECT value INTO candidate FROM jsonb_array_elements(run.frozen_plan->'candidates') value
 WHERE value->>'candidateId'=proof->>'candidateId' AND value->>'payloadHash'=proof->>'payloadHash'
  AND value->>'primitiveKind'='task' AND value->'payload'->>'command'='task';
 SELECT * INTO item FROM public.episode_extraction_items i WHERE i.run_id=run.id AND i.candidate_id=proof->>'candidateId' FOR UPDATE;
 IF run.id IS NULL OR candidate IS NULL OR item.run_id IS NULL OR item.primitive_kind<>'task'
  OR item.payload_hash IS DISTINCT FROM candidate->>'payloadHash' OR item.disposition<>'pending'
  OR item.target_record_id IS NOT NULL OR item.configured_txid IS NOT NULL
  OR run.created_by_user_id::text IS DISTINCT FROM proof->>'actor'
  OR NEW.created_by_user_id::text IS DISTINCT FROM proof->>'actor'
  OR NEW.workspace_id::text IS DISTINCT FROM source->>'workspaceId'
  OR NEW.source_episode_id::text IS DISTINCT FROM source->>'resourceId'
  OR NEW.user_id IS NOT NULL OR NEW.assistant_id::text IS DISTINCT FROM source->>'assistantId'
  OR NEW.created_by_assistant_id::text IS DISTINCT FROM source->>'assistantId'
  OR NEW.source<>'extracted' OR NEW.title IS DISTINCT FROM candidate->'payload'->>'title'
  OR NEW.due IS DISTINCT FROM (candidate->'payload'->>'dueIso')::timestamptz
  OR NEW.sensitivity IS DISTINCT FROM source->>'sensitivity'
  OR to_jsonb(NEW.compartments) IS DISTINCT FROM source->'compartments'
  OR to_jsonb(NEW.project_ids) IS DISTINCT FROM source->'projectIds'
  OR jsonb_array_length(candidate#>'{payload,derivation,sources}')<>1
  OR candidate#>'{payload,derivation,sources,0}' IS DISTINCT FROM jsonb_build_object(
    'resourceKind','episode','resourceId',source->>'resourceId','version',source->>'version',
    'workspaceId',source->>'workspaceId','userId',source->'userId','assistantId',source->'assistantId',
    'sensitivity',source->>'sensitivity','compartments',source->'compartments','projectIds',source->'projectIds')
 THEN RAISE EXCEPTION 'capture_candidate_target_changed' USING ERRCODE='42501';END IF;
 SELECT encode(sha256(convert_to(e.content_ref::text,'UTF8')),'hex'),encode(sha256(convert_to(e.source_ref::text,'UTF8')),'hex'),
  encode(sha256(convert_to(b.events::text,'UTF8')),'hex') INTO content_hash,source_ref_hash,events_hash
 FROM public.episodes e JOIN public.pending_ingest_batches b ON b.id=e.programmatic_batch_id
 WHERE e.id=NEW.source_episode_id AND b.id=(proof->>'batchId')::uuid;
 UPDATE public.episode_extraction_items SET target_record_id=NEW.id::text,configured_txid=pg_current_xact_id(),
  configured_backend_pid=pg_backend_pid(),configured_source=jsonb_build_object(
   'batchId',proof->>'batchId','runId',run.id,'candidateId',item.candidate_id,'payloadHash',item.payload_hash,
   'actor',proof->>'actor','source',source,'episodeContentHash',content_hash,'episodeSourceRefHash',source_ref_hash,'batchEventsHash',events_hash),configured_task=to_jsonb(NEW)
 WHERE run_id=item.run_id AND candidate_id=item.candidate_id;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.seal_configured_task_candidate() FROM PUBLIC,app_user;
CREATE TRIGGER configured_task_candidate_seal AFTER INSERT ON public.tasks
 FOR EACH ROW EXECUTE FUNCTION public.seal_configured_task_candidate();

CREATE FUNCTION public.assert_programmatic_publication_current(batch_id uuid,required_run uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE batch public.pending_ingest_batches; ev jsonb;
BEGIN
 SELECT * INTO batch FROM public.pending_ingest_batches WHERE id=batch_id;
 IF batch.id IS NULL OR batch.scope_held OR batch.processed_at IS NULL
 OR NOT EXISTS(SELECT 1 FROM episodes e JOIN episode_extraction_runs r ON r.episode_id=e.id
  WHERE e.programmatic_batch_id=batch.id AND e.workspace_id=batch.workspace_id
  AND (required_run IS NULL OR r.id=required_run)
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
END $$;
REVOKE ALL ON FUNCTION public.assert_programmatic_publication_current(uuid,uuid) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.check_programmatic_publication_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE batch_id uuid; batch_rule_id uuid;
BEGIN
 -- Preserve the engineering archive-only completion and erasure contract.
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
  IF NEW.programmatic_batch_id IS NULL THEN RETURN NULL;END IF;
  batch_id:=NEW.programmatic_batch_id;
 ELSE
  IF NEW.source<>'programmatic' OR NEW.processed_at IS NULL THEN RETURN NULL;END IF;
  batch_id:=NEW.id;
  SELECT b.rule_id INTO batch_rule_id FROM public.pending_ingest_batches b WHERE b.id=batch_id;
  IF NOT EXISTS(SELECT 1 FROM public.ingest_rules r JOIN public.programmatic_capture_profiles p ON p.id=r.capture_profile_id
   WHERE r.id=batch_rule_id AND p.intake_binding IS NOT NULL) THEN RETURN NULL;END IF;
 END IF;
 PERFORM public.assert_programmatic_publication_current(batch_id,NULL);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.check_programmatic_publication_commit() FROM PUBLIC,app_user;

CREATE FUNCTION public.configured_task_source_commit_allowed(w uuid,target uuid,v text,inserted jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item public.episode_extraction_items; run public.episode_extraction_runs; ep public.episodes;
 task public.tasks; source jsonb; derivation public.scope_derivations;
BEGIN
 SELECT * INTO item FROM public.episode_extraction_items WHERE target_record_id=target::text AND configured_txid=pg_current_xact_id()
  AND configured_backend_pid=pg_backend_pid() AND primitive_kind='task' AND disposition='committed' AND receipt_id IS NOT NULL;
 IF item.run_id IS NULL THEN RETURN false;END IF;
 SELECT * INTO run FROM public.episode_extraction_runs WHERE id=item.run_id AND workspace_id=w;
 SELECT * INTO ep FROM public.episodes WHERE id=run.episode_id AND workspace_id=w AND programmatic_batch_id IS NOT NULL;
 SELECT * INTO task FROM public.tasks WHERE id=target AND workspace_id=w AND scope_version::text=v AND valid_to IS NULL AND retracted_at IS NULL;
 IF run.id IS NULL OR ep.id IS NULL OR task.id IS NULL OR task.scope_held
  OR item.configured_task IS DISTINCT FROM inserted OR to_jsonb(task) IS DISTINCT FROM item.configured_task
  OR public.application_task_live_id(w,task.logical_id) IS DISTINCT FROM target
 THEN RETURN false;END IF;
 PERFORM public.assert_programmatic_publication_current(ep.programmatic_batch_id,run.id);
 source:=public.read_scope_source(w,'episode',ep.id);
 IF item.configured_source->>'batchId' IS DISTINCT FROM ep.programmatic_batch_id::text
  OR item.configured_source->>'runId' IS DISTINCT FROM run.id::text
  OR item.configured_source->>'candidateId' IS DISTINCT FROM item.candidate_id
  OR item.configured_source->>'payloadHash' IS DISTINCT FROM item.payload_hash
  OR item.configured_source->>'actor' IS DISTINCT FROM run.created_by_user_id::text
  OR item.configured_source->>'episodeContentHash' IS DISTINCT FROM encode(sha256(convert_to(ep.content_ref::text,'UTF8')),'hex')
  OR item.configured_source->>'episodeSourceRefHash' IS DISTINCT FROM encode(sha256(convert_to(ep.source_ref::text,'UTF8')),'hex')
  OR item.configured_source->>'batchEventsHash' IS DISTINCT FROM (SELECT encode(sha256(convert_to(b.events::text,'UTF8')),'hex') FROM public.pending_ingest_batches b WHERE b.id=ep.programmatic_batch_id)
  OR source IS DISTINCT FROM item.configured_source->'source' OR source->>'held' IS DISTINCT FROM 'false'
  OR source->>'version' IS DISTINCT FROM run.source_scope_version::text THEN RETURN false;END IF;
 SELECT * INTO derivation FROM public.scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='task'
  AND d.resource_id=target AND d.resource_version=v AND d.producer='programmatic-capture';
 IF derivation.id IS NULL OR derivation.user_id IS NOT NULL OR derivation.assistant_id IS DISTINCT FROM task.assistant_id
  OR derivation.sensitivity IS DISTINCT FROM task.sensitivity OR derivation.compartments IS DISTINCT FROM task.compartments
  OR derivation.project_ids IS DISTINCT FROM task.project_ids
  OR (SELECT count(*) FROM public.scope_derivation_sources s WHERE s.derivation_id=derivation.id)<>1
  OR NOT EXISTS(SELECT 1 FROM public.scope_derivation_sources s WHERE s.derivation_id=derivation.id AND s.workspace_id=w
   AND s.source_kind='episode' AND s.source_id=ep.id AND s.source_version=source->>'version')
  -- This producer admits exactly its original Episode and recorded producer
  -- bindings. An added/changed ancestry is refused, never silently flattened.
  OR EXISTS(SELECT 1 FROM public.application_scope_lineage(w,ARRAY['task'],ARRAY[target],ARRAY[v]) n
    WHERE NOT(n.kind='task' AND n.id=target AND n.version=v)
      AND NOT(n.kind='episode' AND n.id=ep.id AND n.version=source->>'version'))
 THEN RETURN false;END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.configured_task_source_commit_allowed(uuid,uuid,text,jsonb) FROM PUBLIC,app_user;

DO $configured_task_commit_guard$
DECLARE definition text; before text;
BEGIN
 SELECT pg_get_functiondef('public.application_recheck_native_task_sources()'::regprocedure) INTO definition;
 before:='IF application_canonical_ancestry_allowed(NEW.workspace_id,''task'',physical,version,true) IS NOT TRUE THEN';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'configured_task_commit_predecessor_changed';END IF;
 EXECUTE replace(definition,before,
  'IF public.configured_task_source_commit_allowed(NEW.workspace_id,physical,version,to_jsonb(NEW)) THEN RETURN NULL;END IF; '||before);
END $configured_task_commit_guard$;
