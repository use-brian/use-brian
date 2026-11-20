-- [COMP:api/native-turn-frame] Title readers consume canonical frames at their existing boundary.
DO $title_evidence_owner$ DECLARE signature text;definition text;
 old_proof constant text:=$old$ proof:=read_native_file_session_evidence(w,ARRAY(SELECT 'session_context_revision'::text FROM unnest(revision_ids)),revision_ids,
  ARRAY(SELECT '1'::text FROM unnest(revision_ids)),true);$old$;
BEGIN
 FOREACH signature IN ARRAY ARRAY['read_native_personal_title_group(uuid,uuid[],uuid[])','native_personal_title_group_acquisition(uuid,uuid[],uuid[])'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  IF strpos(definition,old_proof)=0 THEN RAISE EXCEPTION 'conversation_title_evidence_predecessor_changed';END IF;
  EXECUTE replace(definition,old_proof,$new$ proof:=capture_conversation_evidence(w,(SELECT jsonb_agg(jsonb_build_object(
   'kind','session_context_revision','id',id,'version','1') ORDER BY ordinal)
   FROM unnest(revision_ids) WITH ORDINALITY input(id,ordinal)));$new$);
 END LOOP;
END $title_evidence_owner$;

-- The current-head reader follows publication's workspace-before-head lock
-- order. Capture then admits the revision before the payload is selected.
DO $title_head_owner$ DECLARE definition text;previous constant text:=
 ' SELECT h.scope_revision_id INTO current_revision FROM session_title_heads h';BEGIN
 definition:=pg_get_functiondef('read_session_title_revision(uuid,uuid,uuid)'::regprocedure);
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'conversation_title_head_predecessor_changed';END IF;
 EXECUTE replace(definition,previous,' PERFORM id FROM workspaces WHERE id=w FOR SHARE;'||chr(10)||previous);
END $title_head_owner$;
