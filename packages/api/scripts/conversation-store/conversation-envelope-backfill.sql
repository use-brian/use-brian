-- [COMP:api/conversation-visibility] The existing-record inventory advances by
-- the session key. Every new session already receives an envelope at creation.
CREATE TABLE public.conversation_envelope_backfill_checkpoint(
 singleton boolean PRIMARY KEY CHECK(singleton),
 after_session_id uuid,
 complete boolean NOT NULL DEFAULT false
);
ALTER TABLE public.conversation_envelope_backfill_checkpoint ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversation_envelope_backfill_checkpoint FROM PUBLIC,app_user;
INSERT INTO public.conversation_envelope_backfill_checkpoint(singleton) VALUES(true);

CREATE FUNCTION public.advance_conversation_envelope_backfill(batch_size integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $backfill$
DECLARE checkpoint public.conversation_envelope_backfill_checkpoint;ids uuid[];sid uuid;
 scanned integer:=0;classified integer:=0;has_more boolean;
BEGIN
 IF batch_size IS NULL OR batch_size NOT BETWEEN 1 AND 200 THEN
  RAISE EXCEPTION 'conversation_backfill_limit' USING ERRCODE='22023';END IF;
 SELECT * INTO checkpoint FROM public.conversation_envelope_backfill_checkpoint WHERE singleton FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN jsonb_build_object('busy',true,'classified',0,'scanned',0);END IF;
 IF checkpoint.complete THEN RETURN jsonb_build_object('done',true,'classified',0,'scanned',0);END IF;
 IF checkpoint.after_session_id IS NULL THEN
  ids:=ARRAY(SELECT id FROM public.sessions ORDER BY id LIMIT batch_size+1);
 ELSE
  ids:=ARRAY(SELECT id FROM public.sessions WHERE id>checkpoint.after_session_id ORDER BY id LIMIT batch_size+1);
 END IF;
 has_more:=cardinality(ids)>batch_size;
 FOREACH sid IN ARRAY ids[1:batch_size] LOOP
  scanned:=scanned+1;
  IF NOT EXISTS(SELECT 1 FROM public.conversation_envelopes e WHERE e.session_id=sid) THEN
   -- Retained historical facts must come from one locked session version.
   PERFORM id FROM public.sessions WHERE id=sid FOR SHARE;
   IF FOUND AND public.classify_conversation_envelope(sid,true) THEN classified:=classified+1;END IF;
  END IF;
 END LOOP;
 UPDATE public.conversation_envelope_backfill_checkpoint SET after_session_id=coalesce(ids[scanned],after_session_id),complete=NOT has_more WHERE singleton;
 RETURN jsonb_build_object('done',NOT has_more,'classified',classified,'scanned',scanned);
END $backfill$;
REVOKE ALL ON FUNCTION public.advance_conversation_envelope_backfill(integer) FROM PUBLIC,app_user;
