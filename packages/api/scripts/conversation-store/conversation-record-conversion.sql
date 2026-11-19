-- [COMP:api/conversation-record-conversion] Bounded exact payload copies, with no authority materialized.
ALTER TYPE public.native_conversation_conversion_unit_kind ADD VALUE 'conversation_record';

-- A non-workspace personal conversation has a real null workspace binding.
-- The old run and queue protocol continues to see only its enumerated kinds.
DO $run_predecessor$
DECLARE constraint_name text;
BEGIN
 SELECT c.conname INTO STRICT constraint_name FROM pg_constraint c
 WHERE c.conrelid='public.native_conversation_conversion_runs'::regclass AND c.contype='u'
  AND pg_get_constraintdef(c.oid)='UNIQUE (workspace_id, compiler_digest)';
 EXECUTE format('ALTER TABLE public.native_conversation_conversion_runs DROP CONSTRAINT %I',constraint_name);
END $run_predecessor$;
ALTER TABLE public.native_conversation_conversion_runs
 ALTER COLUMN workspace_id DROP NOT NULL,
 ADD UNIQUE NULLS NOT DISTINCT(workspace_id,compiler_digest);
ALTER TABLE public.native_conversation_conversion_pending
 DROP CONSTRAINT native_conversation_conversion_pending_pkey,
 ALTER COLUMN workspace_id DROP NOT NULL,
 ADD UNIQUE NULLS NOT DISTINCT(workspace_id,kind,id,version),
 ADD COLUMN record_cursor integer NOT NULL DEFAULT 0 CHECK(record_cursor>=0),
 ADD COLUMN record_parameters jsonb;
CREATE INDEX conversation_record_conversion_work ON public.native_conversation_conversion_pending(generation,id,version DESC)
 WHERE version IN('record-v1','record-exact-v1');
ALTER TABLE public.conversation_envelopes
 ADD COLUMN record_conversion_generation bigint,
 ADD COLUMN record_conversion_revision bigint,
 ADD COLUMN record_conversion_through integer CHECK(record_conversion_through>=0),
 ADD COLUMN record_conversion_legacy boolean;
ALTER TABLE public.native_conversation_conversion_inputs
 DROP CONSTRAINT native_conversation_conversion_inputs_processing_mode_check,
 ADD CHECK(processing_mode IN('compiled_frame','original_adapter','compiled_record')),
 ADD COLUMN record_session_id uuid REFERENCES public.conversation_envelopes(session_id) ON DELETE CASCADE,
 ADD COLUMN record_epoch text,
 ADD COLUMN record_recipe text,
 ADD COLUMN record_after integer,
 ADD COLUMN record_through integer,
 ADD COLUMN record_topic_through integer,
 ADD COLUMN record_legacy boolean,
 ADD COLUMN record_starter boolean,
 ADD COLUMN record_payload jsonb,
 ADD CHECK((kind::text='conversation_record' AND processing_mode='compiled_record'
     AND id=record_session_id AND record_epoch ~ '^[0-9]+:[0-9]+$'
     AND record_recipe IN('visual_rows_v1','dialogue_text_v1')
     AND record_after>=0 AND record_through>=record_after
     AND (record_recipe='visual_rows_v1' AND record_topic_through IS NULL
        OR record_recipe='dialogue_text_v1' AND record_topic_through>=0)
     AND record_legacy IS NOT NULL AND record_starter IS NOT NULL
     AND jsonb_typeof(record_payload)='object') IS TRUE
  OR (kind::text<>'conversation_record' AND record_session_id IS NULL AND record_epoch IS NULL
     AND record_recipe IS NULL AND record_after IS NULL AND record_through IS NULL
     AND record_topic_through IS NULL AND record_legacy IS NULL AND record_starter IS NULL AND record_payload IS NULL));
CREATE INDEX native_conversation_record_copies ON public.native_conversation_conversion_inputs(
 record_session_id,record_epoch,record_recipe,record_legacy,record_starter,record_after,record_through,record_topic_through)
 WHERE record_session_id IS NOT NULL;

CREATE FUNCTION public.protect_compiled_conversation_payload() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $protect$
BEGIN
 IF TG_OP='UPDATE' AND OLD.kind::text='conversation_record' THEN
  RAISE EXCEPTION 'compiled_conversation_payload_immutable';
 END IF;
 RETURN NEW;
END $protect$;
CREATE TRIGGER protect_compiled_conversation_payload BEFORE UPDATE ON public.native_conversation_conversion_inputs
 FOR EACH ROW EXECUTE FUNCTION public.protect_compiled_conversation_payload();

CREATE FUNCTION public.conversation_record_conversion_compiler() RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $compiler$
 SELECT encode(sha256(convert_to('native-conversation-record-conversion-v1','UTF8')),'hex')
$compiler$;

CREATE FUNCTION public.enqueue_conversation_record_conversion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $enqueue$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM public.native_conversation_conversion_pending p
   WHERE p.workspace_id IS NOT DISTINCT FROM OLD.workspace_id AND p.kind='conversation_record'
    AND p.id=OLD.session_id AND p.version IN('record-v1','record-exact-v1');
  RETURN OLD;
 END IF;
 INSERT INTO public.native_conversation_conversion_pending(workspace_id,kind,id,version)
  VALUES(NEW.workspace_id,'conversation_record',NEW.session_id,'record-v1')
 ON CONFLICT(workspace_id,kind,id,version) DO UPDATE
  SET generation=native_conversation_conversion_pending.generation+1,record_cursor=0;
 RETURN NEW;
END $enqueue$;
CREATE TRIGGER enqueue_conversation_record_conversion AFTER INSERT OR DELETE ON public.conversation_envelopes
 FOR EACH ROW EXECUTE FUNCTION public.enqueue_conversation_record_conversion();
CREATE TRIGGER requeue_conversation_record_conversion AFTER UPDATE OF version,record_data_revision ON public.conversation_envelopes
 FOR EACH ROW WHEN (OLD.version IS DISTINCT FROM NEW.version OR OLD.record_data_revision IS DISTINCT FROM NEW.record_data_revision)
 EXECUTE FUNCTION public.enqueue_conversation_record_conversion();

-- The original installation may already contain conversations. A separate run
-- cursor enrolls them in small keyset pages, including owner-only personal rows.
CREATE FUNCTION public.enroll_existing_conversation_records(unit_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $enroll$
DECLARE
 enrollment_digest constant text:=encode(sha256(convert_to('native-conversation-record-enrollment-v1','UTF8')),'hex');
 work public.native_conversation_conversion_runs;latest uuid;rows_count integer;
BEGIN
 IF unit_limit IS NULL OR unit_limit NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'conversion_invalid_page_budget';END IF;
 INSERT INTO public.native_conversation_conversion_runs(id,workspace_id,compiler_digest)
  VALUES(gen_random_uuid(),NULL,enrollment_digest) ON CONFLICT(workspace_id,compiler_digest) DO NOTHING;
 SELECT * INTO work FROM public.native_conversation_conversion_runs
  WHERE workspace_id IS NULL AND compiler_digest=enrollment_digest FOR UPDATE SKIP LOCKED;
 IF NOT FOUND OR work.phase='reconciled' THEN RETURN 0;END IF;
 WITH batch AS MATERIALIZED(
  SELECT e.workspace_id,e.session_id,e.record_dirty_from,
    e.record_conversion_generation=e.version AND e.record_conversion_revision=e.record_data_revision AS sealed
   FROM public.conversation_envelopes e
   WHERE work.cursor_id IS NULL OR e.session_id>work.cursor_id ORDER BY e.session_id LIMIT unit_limit FOR KEY SHARE
 ), inserted AS (
  INSERT INTO public.native_conversation_conversion_pending(workspace_id,kind,id,version)
   SELECT workspace_id,'conversation_record',session_id,'record-v1' FROM batch
   WHERE sealed IS NOT TRUE OR record_dirty_from IS NOT NULL
   ON CONFLICT(workspace_id,kind,id,version) DO NOTHING
 )
 SELECT count(*)::int,(SELECT session_id FROM batch ORDER BY session_id DESC LIMIT 1) INTO rows_count,latest FROM batch;
 IF rows_count=0 THEN
  UPDATE public.native_conversation_conversion_runs SET phase='reconciled' WHERE id=work.id;
 ELSE
  UPDATE public.native_conversation_conversion_runs SET cursor_id=latest WHERE id=work.id;
 END IF;
 RETURN rows_count;
END $enroll$;

-- At most one outstanding model selection per conversation. Caller values
-- come from a bound record request and the writer rechecks the current epoch.
CREATE FUNCTION public.enqueue_exact_conversation_record(e public.conversation_envelopes,after_sequence integer,
 through_sequence integer,topic_through integer,legacy_allowed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $exact_work$
BEGIN
 IF e.session_id IS NULL OR e.workspace_id IS NULL OR after_sequence IS NULL OR through_sequence IS NULL
  OR topic_through IS NULL OR legacy_allowed IS NULL OR after_sequence<0 OR through_sequence<after_sequence
  OR topic_through<0
  OR e.record_conversion_generation IS DISTINCT FROM e.version OR e.record_conversion_revision IS DISTINCT FROM e.record_data_revision
  OR e.record_conversion_legacy IS DISTINCT FROM legacy_allowed OR through_sequence>e.record_conversion_through
  OR topic_through>e.record_conversion_through
 THEN RETURN;END IF;
 IF EXISTS(SELECT 1 FROM public.native_conversation_conversion_inputs i
  WHERE i.record_session_id=e.session_id AND i.record_epoch=e.version::text||':'||e.record_data_revision::text
   AND i.record_recipe='dialogue_text_v1' AND i.record_legacy=legacy_allowed AND i.record_starter
   AND i.record_after=after_sequence AND i.record_through=through_sequence AND i.record_topic_through=topic_through)
 OR (SELECT count(*) FROM public.native_conversation_conversion_inputs i
  WHERE i.record_session_id=e.session_id AND i.record_epoch=e.version::text||':'||e.record_data_revision::text
   AND i.record_recipe='dialogue_text_v1' AND i.record_starter)>=8 THEN RETURN;END IF;
 INSERT INTO public.native_conversation_conversion_pending(workspace_id,kind,id,version,record_parameters)
 VALUES(e.workspace_id,'conversation_record',e.session_id,'record-exact-v1',
  jsonb_build_array(e.version,e.record_data_revision,after_sequence,through_sequence,topic_through,legacy_allowed))
 ON CONFLICT(workspace_id,kind,id,version) DO NOTHING;
END $exact_work$;

CREATE FUNCTION public.compile_conversation_record_page(unit_limit integer,byte_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $compile$
DECLARE
 compiler constant text:=public.conversation_record_conversion_compiler();
 p public.native_conversation_conversion_pending;e public.conversation_envelopes;
 run public.native_conversation_conversion_runs;
 after_sequence integer;last_sequence integer;high integer;first_sequence integer;bytes integer:=0;
 retained_bytes bigint;retained_pages bigint;
 page_number bigint;written integer:=0;purged integer;
 legacy boolean:=false;mode text;starter boolean:=false;topic integer;viewer uuid;
 payload jsonb;sealed_rows jsonb;epoch text;input_version text;digest text;next_chain text;
 disposition text:='compiled'; work_done boolean:=false;
BEGIN
 IF unit_limit IS NULL OR unit_limit NOT BETWEEN 1 AND 32 OR byte_limit IS NULL OR byte_limit NOT BETWEEN 1024 AND 4194304
 THEN RAISE EXCEPTION 'conversion_invalid_page_budget';END IF;
 SELECT * INTO p FROM public.native_conversation_conversion_pending pending
  WHERE pending.kind='conversation_record' AND pending.version IN('record-v1','record-exact-v1')
  ORDER BY pending.generation,pending.id,pending.version DESC LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','idle');END IF;
 IF p.workspace_id IS NOT NULL THEN
  PERFORM id FROM public.workspaces WHERE id=p.workspace_id FOR KEY SHARE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','busy');END IF;
 END IF;
 SELECT * INTO e FROM public.conversation_envelopes x WHERE x.session_id=p.id
  AND x.workspace_id IS NOT DISTINCT FROM p.workspace_id FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','busy');END IF;
 -- Keep the enrollment lock order (workspace, envelope, then pending).
 IF NOT EXISTS(SELECT 1 FROM public.native_conversation_conversion_pending x
  WHERE x.kind=p.kind AND x.id=p.id AND x.version=p.version AND x.workspace_id IS NOT DISTINCT FROM p.workspace_id
   AND (x.generation,x.record_cursor)=(p.generation,p.record_cursor))
 THEN RETURN jsonb_build_object('state','superseded');END IF;
 SELECT coalesce(max(m.sequence_num),0) INTO high FROM public.session_messages m WHERE m.session_id=e.session_id;
 IF e.workspace_id IS NOT NULL AND e.visibility='private_by_kind' THEN
  SELECT public.conversation_legacy_enrolled(s.id,e.workspace_id,s.user_id,s.assistant_id) IS TRUE INTO legacy
   FROM public.sessions s WHERE s.id=e.session_id;
 END IF;
 INSERT INTO public.native_conversation_conversion_runs(id,workspace_id,compiler_digest,phase)
  VALUES(gen_random_uuid(),e.workspace_id,compiler,'delta') ON CONFLICT(workspace_id,compiler_digest) DO NOTHING;
 SELECT * INTO STRICT run FROM public.native_conversation_conversion_runs x
  WHERE x.workspace_id IS NOT DISTINCT FROM e.workspace_id AND x.compiler_digest=compiler FOR UPDATE;

 IF p.version='record-exact-v1' THEN
  IF p.record_parameters->0 IS DISTINCT FROM to_jsonb(e.version)
   OR p.record_parameters->1 IS DISTINCT FROM to_jsonb(e.record_data_revision)
   OR p.record_parameters->5 IS DISTINCT FROM to_jsonb(legacy)
  THEN
   DELETE FROM public.native_conversation_conversion_pending x
    WHERE x.workspace_id IS NOT DISTINCT FROM p.workspace_id AND x.kind=p.kind AND x.id=p.id AND x.version=p.version;
   RETURN jsonb_build_object('state','superseded');
  END IF;
  mode:='dialogue_text_v1';
  epoch:=e.version::text||':'||e.record_data_revision::text;
  after_sequence:=(p.record_parameters->>2)::integer;
  last_sequence:=(p.record_parameters->>3)::integer;
  topic:=(p.record_parameters->>4)::integer;
  starter:=p.record_cursor=0;
  viewer:=CASE WHEN starter THEN e.starter_user_id END;
  work_done:=NOT starter;
  IF last_sequence<=high AND topic<=high THEN
   sealed_rows:=public.read_compiled_conversation_payload(e,after_sequence,last_sequence,NULL,legacy,
      coalesce(e.starter_user_id,'00000000-0000-0000-0000-000000000000'::uuid),'model_visual_rows_v1')->'rows';
   IF sealed_rows IS NOT NULL AND jsonb_array_length(sealed_rows)<=128 AND octet_length(sealed_rows::text)<=byte_limit THEN
    payload:=public.project_conversation_record(e,after_sequence,last_sequence,topic,legacy,viewer,sealed_rows);
   END IF;
  END IF;
  IF payload IS NULL THEN disposition:='visual_copy_unavailable_or_oversized';END IF;
 ELSE
  mode:='visual_rows_v1';
  epoch:=e.version::text||':0';
  after_sequence:=p.record_cursor;
  IF p.record_cursor=0 THEN
   -- Drop only obsolete receipts and the affected suffix. A monotonic
   -- earliest dirty sequence protects every retained immutable prefix page.
   DELETE FROM public.native_conversation_conversion_inputs old WHERE old.ctid IN (
    SELECT stale.ctid FROM public.native_conversation_conversion_inputs stale
    WHERE stale.record_session_id=e.session_id AND (
     stale.record_recipe='dialogue_text_v1' AND stale.record_epoch<>e.version::text||':'||e.record_data_revision::text
     OR stale.record_recipe='visual_rows_v1' AND (stale.record_epoch<>epoch
       OR stale.record_legacy IS DISTINCT FROM legacy
       OR stale.record_after=stale.record_through AND high>stale.record_through
       OR stale.record_through>=coalesce(e.record_dirty_from,0)))
    LIMIT 96
   );
   GET DIAGNOSTICS purged=ROW_COUNT;
   IF purged=96 THEN RETURN jsonb_build_object('state','cleanup','deleted',purged);END IF;
   SELECT coalesce(max(i.record_through),0) INTO after_sequence FROM public.native_conversation_conversion_inputs i
    WHERE i.record_session_id=e.session_id AND i.record_epoch=epoch AND i.record_recipe=mode AND i.record_legacy=legacy;
  END IF;
  SELECT coalesce(sum(i.bytes),0),count(*) INTO retained_bytes,retained_pages FROM public.native_conversation_conversion_inputs i
   WHERE i.record_session_id=e.session_id AND i.record_epoch=epoch AND i.record_recipe=mode AND i.record_legacy=legacy;
  IF retained_pages>=4096 OR retained_bytes>=67108864 THEN
   last_sequence:=high;
   disposition:='record_copy_retention_limit';
  ELSE
  WITH candidate AS MATERIALIZED(
   SELECT m.sequence_num, coalesce(pg_column_size(m.content),0)::bigint+coalesce(pg_column_size(m.attachments),0)+512 AS bytes
   FROM public.session_messages m WHERE m.session_id=e.session_id AND m.sequence_num>after_sequence
   ORDER BY m.sequence_num LIMIT unit_limit
  ), bounded AS(
   SELECT sequence_num,sum(candidate.bytes) OVER(ORDER BY sequence_num) running_bytes FROM candidate
  )
  SELECT min(sequence_num),max(sequence_num) FILTER(WHERE running_bytes<=byte_limit) INTO first_sequence,last_sequence FROM bounded;
  IF first_sequence IS NULL THEN last_sequence:=after_sequence;
  ELSIF last_sequence IS NULL THEN last_sequence:=first_sequence;disposition:='source_row_oversized';
  END IF;
  END IF;
  work_done:=last_sequence=high;
  IF disposition='compiled' THEN
   SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.sequence_num),'[]') INTO sealed_rows
    FROM public.conversation_record_rows(e,after_sequence,last_sequence,legacy,e.starter_user_id,true) m;
   payload:=jsonb_build_object('rows',sealed_rows,'manifest',jsonb_build_object('rowCount',jsonb_array_length(sealed_rows)));
  END IF;
 END IF;

 IF payload IS NOT NULL THEN
  bytes:=octet_length(payload::text);
  IF bytes>byte_limit THEN payload:=NULL;disposition:='compiled_payload_oversized';
  ELSIF mode='visual_rows_v1' AND retained_bytes+bytes>67108864 THEN
   payload:=NULL;disposition:='record_copy_retention_limit';last_sequence:=high;work_done:=true;
  END IF;
 END IF;
 IF payload IS NULL AND mode='dialogue_text_v1' THEN
  -- Record this selector as an explicit miss for both reader variants. A
  -- popular unsupported request must not enqueue the same bounded job forever.
  payload:=jsonb_build_object('manifest',jsonb_build_object('disposition',disposition));
  bytes:=octet_length(payload::text);
 END IF;
 IF payload IS NOT NULL THEN
  digest:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
  input_version:=format('%s/%s/%s/%s/%s/%s/%s',epoch,mode,after_sequence,last_sequence,coalesce(topic::text,'-'),legacy,starter);
  INSERT INTO public.native_conversation_conversion_inputs(run_id,kind,id,version,original_digest,compiler_digest,bytes,
    descriptor_digest,processing_mode,record_session_id,record_epoch,record_recipe,record_after,record_through,
    record_topic_through,record_legacy,record_starter,record_payload)
   VALUES(run.id,'conversation_record',e.session_id,input_version,digest,compiler,bytes,
    encode(sha256(convert_to((payload->'manifest')::text,'UTF8')),'hex'),'compiled_record',e.session_id,epoch,mode,after_sequence,last_sequence,topic,legacy,starter,payload)
   ON CONFLICT(run_id,kind,id,version) DO NOTHING;
  IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM public.native_conversation_conversion_inputs i
   WHERE i.run_id=run.id AND i.kind='conversation_record' AND i.id=e.session_id AND i.version=input_version
    AND i.original_digest=digest AND i.record_payload=payload)
  THEN RAISE EXCEPTION 'compiled_conversation_replay_mismatch';END IF;
  written:=bytes;
 END IF;
 page_number:=run.page+1;
 next_chain:=encode(sha256(convert_to(jsonb_build_array(run.chain_digest,page_number,e.session_id,epoch,mode,after_sequence,last_sequence,disposition,input_version)::text,'UTF8')),'hex');
 INSERT INTO public.native_conversation_conversion_pages(run_id,page,phase,units,bytes,before_cursor,after_cursor,chain_digest,source_bytes)
  VALUES(run.id,page_number,'delta',(payload IS NOT NULL)::int,written,to_jsonb(after_sequence),
   jsonb_build_object('sequence',last_sequence,'recipe',mode,'disposition',disposition),next_chain,bytes);
 DELETE FROM public.native_conversation_conversion_pages old_page
  WHERE old_page.run_id=run.id AND old_page.page=page_number-4096;
 UPDATE public.native_conversation_conversion_runs SET page=page_number,chain_digest=next_chain WHERE id=run.id;
 IF work_done THEN
  DELETE FROM public.native_conversation_conversion_pending x
   WHERE x.workspace_id IS NOT DISTINCT FROM p.workspace_id AND x.kind=p.kind AND x.id=p.id AND x.version=p.version AND x.generation=p.generation;
  IF mode='visual_rows_v1' THEN
   UPDATE public.conversation_envelopes SET record_conversion_generation=e.version,record_conversion_revision=e.record_data_revision,
    record_conversion_through=last_sequence,record_conversion_legacy=legacy,record_dirty_from=NULL WHERE session_id=e.session_id
    RETURNING * INTO e;
   PERFORM public.enqueue_exact_conversation_record(e,0,last_sequence,last_sequence,legacy);
  END IF;
 ELSE
  UPDATE public.native_conversation_conversion_pending x
   SET record_cursor=CASE WHEN mode='visual_rows_v1' THEN last_sequence ELSE 1 END
   WHERE x.workspace_id IS NOT DISTINCT FROM p.workspace_id AND x.kind=p.kind AND x.id=p.id AND x.version=p.version AND x.generation=p.generation;
 END IF;
 RETURN jsonb_build_object('state','committed','page',page_number,'bytes',written,'units',(payload IS NOT NULL)::int,'disposition',disposition);
END $compile$;

-- Only a caller that already proved the exact current purpose may call this.
-- Matching touches only compiled metadata and selected compiled bytes, never
-- the original transcript or authorization graph.
CREATE FUNCTION public.read_compiled_conversation_payload(e public.conversation_envelopes,after_sequence integer,
 through_sequence integer,topic_through integer,legacy_allowed boolean,viewer uuid,recipe text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $compiled$
DECLARE
 epoch text:=e.version::text||':'||e.record_data_revision::text;
 compiler constant text:=public.conversation_record_conversion_compiler();
 i public.native_conversation_conversion_inputs;selected jsonb;starter boolean; covered boolean;
BEGIN
 IF viewer IS NULL OR after_sequence IS NULL OR after_sequence<0 OR legacy_allowed IS NULL
   OR (through_sequence IS NOT NULL AND through_sequence<after_sequence) THEN RETURN NULL;END IF;
 IF e.record_conversion_generation IS DISTINCT FROM e.version OR e.record_conversion_revision IS DISTINCT FROM e.record_data_revision
  OR e.record_conversion_legacy IS DISTINCT FROM legacy_allowed OR e.record_conversion_through IS NULL THEN RETURN NULL;END IF;
 IF recipe='dialogue_text_v1' THEN
  IF through_sequence IS NULL OR topic_through IS NULL THEN RETURN NULL;END IF;
  starter:=viewer IS NOT DISTINCT FROM e.starter_user_id;
  SELECT * INTO i FROM public.native_conversation_conversion_inputs c
   WHERE c.record_session_id=e.session_id AND c.record_epoch=epoch AND c.record_recipe=recipe
    AND c.record_after=after_sequence AND c.record_through=through_sequence AND c.record_topic_through=topic_through
    AND c.record_starter=starter AND c.record_legacy=legacy_allowed AND c.compiler_digest=compiler;
  IF NOT FOUND THEN RETURN NULL;END IF;
  selected:=i.record_payload;
  IF jsonb_typeof(selected->'rows') IS DISTINCT FROM 'array' OR jsonb_typeof(selected->'annotations') IS DISTINCT FROM 'array'
   OR jsonb_typeof(selected->'legacyRowsSelected') IS DISTINCT FROM 'boolean' THEN RETURN NULL;END IF;
  IF selected#>>'{manifest,modelRecipe}' IS DISTINCT FROM recipe
   OR selected#>'{manifest,afterSequence}' IS DISTINCT FROM to_jsonb(after_sequence)
   OR selected#>'{manifest,throughSequence}' IS DISTINCT FROM to_jsonb(through_sequence)
   OR selected#>'{manifest,topicThroughSequence}' IS DISTINCT FROM to_jsonb(topic_through)
   OR selected#>'{manifest,rowCount}' IS DISTINCT FROM to_jsonb(jsonb_array_length(selected->'rows'))
   OR selected#>'{manifest,annotationCount}' IS DISTINCT FROM to_jsonb(jsonb_array_length(selected->'annotations'))
   OR i.descriptor_digest IS DISTINCT FROM encode(sha256(convert_to((selected->'manifest')::text,'UTF8')),'hex')
   THEN RETURN NULL;END IF;
  RETURN selected;
 ELSIF recipe IN('visual_rows_v1','model_visual_rows_v1') THEN
  epoch:=e.version::text||':0';
  WITH chunks AS MATERIALIZED(
   SELECT c.record_after,c.record_through,c.record_payload->'rows' AS rows,c.bytes,
    lag(c.record_through,1,0) OVER(ORDER BY c.record_after) AS previous,
    CASE WHEN jsonb_typeof(c.record_payload->'rows')='array' THEN
      c.record_payload#>'{manifest,rowCount}'=to_jsonb(jsonb_array_length(c.record_payload->'rows'))
      AND c.descriptor_digest=encode(sha256(convert_to((c.record_payload->'manifest')::text,'UTF8')),'hex')
    ELSE false END AS valid
   FROM public.native_conversation_conversion_inputs c
   WHERE c.record_session_id=e.session_id AND c.record_epoch=epoch AND c.record_recipe='visual_rows_v1'
    AND NOT c.record_starter AND c.record_legacy=legacy_allowed AND c.compiler_digest=compiler
  ), coverage AS(
   SELECT coalesce(bool_and(valid IS TRUE AND record_after=previous),false)
    AND max(record_through)=e.record_conversion_through AS covered FROM chunks
  ), window_size AS(
   SELECT coalesce(sum(bytes),0)<=4194304 AS model_budget FROM chunks
   WHERE record_through>after_sequence AND record_after<through_sequence
  ), expanded AS MATERIALIZED (
   SELECT chunk.record_after,chunk.record_through,item.row,item.pos,
    lag(item.row->'sequence_num',1,to_jsonb(chunk.record_after))
     OVER(PARTITION BY chunk.record_after ORDER BY item.pos) AS prior_sequence
   FROM window_size budget CROSS JOIN chunks chunk
   JOIN LATERAL jsonb_array_elements(CASE WHEN chunk.valid AND (recipe='visual_rows_v1' OR budget.model_budget)
     THEN chunk.rows ELSE '[]'::jsonb END)
    WITH ORDINALITY item(row,pos) ON true
   WHERE chunk.record_through>after_sequence AND (through_sequence IS NULL OR chunk.record_after<through_sequence)
  ), selected_rows AS (
   SELECT coalesce(bool_and((jsonb_typeof(row)='object' AND jsonb_typeof(row->'sequence_num')='number'
     AND row->'session_id'=to_jsonb(e.session_id) AND jsonb_typeof(row->'id')='string'
     AND row->>'role' IN('user','assistant')
     AND row->'sequence_num'>prior_sequence AND row->'sequence_num'<=to_jsonb(record_through)) IS TRUE),true) AS valid,
    coalesce(jsonb_agg(row ORDER BY record_after,pos) FILTER (WHERE row->'sequence_num'>to_jsonb(after_sequence)
     AND (through_sequence IS NULL OR row->'sequence_num'<=to_jsonb(through_sequence))),'[]') AS rows
   FROM expanded
  )
  SELECT coverage.covered AND selected_rows.valid AND (recipe='visual_rows_v1' OR window_size.model_budget),selected_rows.rows
   INTO covered,selected FROM coverage CROSS JOIN selected_rows CROSS JOIN window_size;
  IF covered IS NOT TRUE OR selected IS NULL THEN RETURN NULL;END IF;
  RETURN jsonb_build_object('rows',selected,'manifest',jsonb_build_object('rowCount',jsonb_array_length(selected)));
 END IF;
 RETURN NULL;
END $compiled$;

REVOKE ALL ON FUNCTION public.conversation_record_conversion_compiler(),public.enqueue_conversation_record_conversion(),
 public.protect_compiled_conversation_payload(),public.enroll_existing_conversation_records(integer),
 public.compile_conversation_record_page(integer,integer),
 public.enqueue_exact_conversation_record(public.conversation_envelopes,integer,integer,integer,boolean),
 public.read_compiled_conversation_payload(public.conversation_envelopes,integer,integer,integer,boolean,uuid,text)
 FROM PUBLIC,app_user;
