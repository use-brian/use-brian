-- [COMP:api/conversation-visibility] The actual source-edge write compares a
-- current record with its stored destination. Record descriptors alone never
-- authorize a reader or a destination.
CREATE FUNCTION public.conversation_record_publication_source(w uuid,capture_id uuid,sid uuid,actor uuid,title_purpose boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $source$
DECLARE source jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.private_transcript_observations o WHERE o.workspace_id=w AND o.id=capture_id
   AND o.session_id=sid AND o.binding->>'kind'='conversation_record_v1'
   AND (o.binding->>'purpose'='native_member_dialogue' AND NOT title_purpose
    OR o.binding->>'purpose'='native_session_title' AND title_purpose AND o.binding->>'readerUserId'=actor::text))
 THEN RETURN '{"held":true}';END IF;
 PERFORM session_id FROM public.conversation_envelopes WHERE session_id=sid AND workspace_id=w FOR SHARE;
 IF NOT FOUND OR public.conversation_member_read_allowed(w,sid,actor) IS NOT TRUE THEN RETURN '{"held":true}';END IF;
 source:=public.read_conversation_record_source(w,capture_id);
 RETURN source;
END $source$;
REVOKE ALL ON FUNCTION public.conversation_record_publication_source(uuid,uuid,uuid,uuid,boolean) FROM PUBLIC,app_user;

CREATE FUNCTION public.read_conversation_record_for_write(w uuid,capture_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $snapshot$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;sid uuid;source jsonb;
BEGIN
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN RETURN '{"held":true}';END IF;
 SELECT o.session_id INTO sid FROM public.private_transcript_observations o WHERE o.workspace_id=w AND o.id=capture_id
  AND o.binding->>'purpose'='native_member_dialogue';
 IF NOT FOUND OR actor IS NULL THEN RETURN '{"held":true}';END IF;
 PERFORM e.session_id FROM public.conversation_envelopes e WHERE e.session_id=sid AND e.workspace_id=w FOR SHARE;
 IF NOT FOUND OR public.conversation_member_read_allowed(w,sid,actor) IS NOT TRUE THEN RETURN '{"held":true}';END IF;
 source:=public.read_conversation_record_source(w,capture_id);
 RETURN source;
END $snapshot$;
REVOKE ALL ON FUNCTION public.read_conversation_record_for_write(uuid,uuid) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.read_conversation_record_for_write(uuid,uuid) TO app_user;

-- Exact captured selection becomes an upstream root only for a fresh
-- derivative. Current record display and same-conversation writes skip this.
CREATE FUNCTION public.conversation_record_lineage_roots(w uuid,capture_id uuid,actor uuid)
RETURNS TABLE(kind text,id uuid,version text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $roots$
DECLARE o public.private_transcript_observations;e public.conversation_envelopes;projection jsonb;
BEGIN
 SELECT * INTO o FROM public.private_transcript_observations WHERE workspace_id=w AND private_transcript_observations.id=capture_id;
 IF NOT FOUND OR o.binding->>'purpose' IS DISTINCT FROM 'native_member_dialogue'
  OR o.binding->'legacyRowsSelected' IS DISTINCT FROM 'false'::jsonb
  OR public.conversation_record_member_allowed(w,capture_id,actor) IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=o.session_id AND workspace_id=w FOR SHARE;
 IF NOT FOUND OR o.binding->>'generation' IS DISTINCT FROM e.version::text
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 projection:=public.project_conversation_record(e,(o.manifest->>'afterSequence')::integer,(o.manifest->>'throughSequence')::integer,
  (o.manifest->>'topicThroughSequence')::integer,false,(o.binding->>'readerUserId')::uuid);
 IF projection->'manifest' IS DISTINCT FROM o.manifest THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN QUERY
  SELECT 'session_message'::text,m.id,m.scope_version::text FROM jsonb_array_elements(projection->'rows') item
   JOIN public.session_messages m ON m.id=(item->>'id')::uuid AND m.session_id=o.session_id AND m.workspace_id=w
  UNION ALL SELECT 'session_context_revision'::text,(item->>'revisionId')::uuid,item->>'version'
   FROM jsonb_array_elements(projection->'annotations') item;
END $roots$;
REVOKE ALL ON FUNCTION public.conversation_record_lineage_roots(uuid,uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.require_conversation_record_current_lineage(w uuid,capture_id uuid,actor uuid,d public.scope_derivations)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $lineage$
DECLARE node record;snapshot jsonb;seen integer:=0;
BEGIN
 FOR node IN WITH RECURSIVE lineage(kind,id,version) AS (
  SELECT 'conversation_record'::text,capture_id,'1'::text
  UNION SELECT next.kind,next.id,next.version FROM lineage l CROSS JOIN LATERAL (
   SELECT r.* FROM public.conversation_record_lineage_roots(w,l.id,actor) r WHERE l.kind='conversation_record'
   UNION ALL SELECT e.* FROM public.conversation_source_edges(w,l.kind,l.id,l.version) e WHERE l.kind<>'conversation_record'
  ) next
 ) SELECT l.* FROM lineage l LIMIT 4097 LOOP
  seen:=seen+1;
  IF seen>4096 OR node.version IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF node.kind='conversation_record' THEN
   IF node.version IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   CONTINUE;
  END IF;
  -- These leaves have additional independent, source-family authority. A
  -- metadata snapshot cannot stand in for their native read/retain proof.
  IF node.kind NOT IN('session_message','session_context_revision','memory','task','workspace_file','entity','entity_link','episode')
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  snapshot:=public.read_scope_source(w,node.kind,node.id);
  IF snapshot->>'held' IS DISTINCT FROM 'false' OR snapshot->>'version' IS DISTINCT FROM node.version
   OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL
   OR snapshot->>'workspaceId' IS DISTINCT FROM w::text
   OR snapshot->>'userId' IS NOT NULL AND snapshot->>'userId' IS DISTINCT FROM d.user_id::text
   OR snapshot->>'assistantId' IS NOT NULL AND snapshot->>'assistantId' IS DISTINCT FROM d.assistant_id::text
   OR (public.sensitivity_rank(snapshot->>'sensitivity')<=public.sensitivity_rank(d.sensitivity)
    AND to_jsonb(d.compartments) @> (snapshot->'compartments') AND to_jsonb(d.project_ids) @> (snapshot->'projectIds')) IS NOT TRUE
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
END $lineage$;
REVOKE ALL ON FUNCTION public.require_conversation_record_current_lineage(uuid,uuid,uuid,public.scope_derivations) FROM PUBLIC,app_user;

CREATE FUNCTION public.conversation_anchor_key(sid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $key$
 SELECT CASE s.anchor_kind
  WHEN 'none' THEN '[]'::jsonb
  WHEN 'doc_thread' THEN (SELECT jsonb_build_array('page',ct.page_id) FROM public.comment_threads ct WHERE ct.session_id=sid)
  WHEN 'office_file' THEN (SELECT jsonb_build_array('office',l.artifact_id) FROM public.office_artifact_sessions l WHERE l.session_id=sid)
  WHEN 'feed_draft' THEN jsonb_build_array('feed',sid)
  WHEN 'feed_thread' THEN (SELECT jsonb_build_array('feed',t.session_id) FROM public.feed_comment_threads t WHERE t.transcript_session_id=sid)
  WHEN 'channel' THEN jsonb_build_array('channel',s.assistant_id,s.channel_type,s.channel_id)
 END FROM public.sessions s WHERE s.id=sid
$key$;
REVOKE ALL ON FUNCTION public.conversation_anchor_key(uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.require_conversation_record_edge(w uuid,did uuid,capture_id uuid,source_version text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $edge$
DECLARE d public.scope_derivations;destination_id uuid;source jsonb;e public.conversation_envelopes;origin public.conversation_envelopes;
 o public.private_transcript_observations;original_anchor jsonb;one_reader uuid;
 destination jsonb;
 source_readers uuid[];destination_readers uuid[];
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 SELECT * INTO d FROM public.scope_derivations WHERE workspace_id=w AND id=did;
 IF NOT FOUND OR source_version IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF d.resource_kind='session_message' THEN
  SELECT m.session_id INTO destination_id FROM public.session_messages m
  WHERE m.workspace_id=w AND m.id=d.resource_id AND m.scope_held IS FALSE AND m.scope_version::text=d.resource_version;
 ELSIF d.resource_kind='session_context_revision' THEN
  SELECT r.session_id INTO destination_id FROM public.session_context_scope_revisions r
  WHERE r.workspace_id=w AND r.id=d.resource_id AND r.scope_held IS FALSE AND r.scope_version::text=d.resource_version
   AND r.parent_kind IN('turn_frame','message_annotation','session_title','compact_summary');
 END IF;
 SELECT * INTO o FROM public.private_transcript_observations WHERE workspace_id=w AND id=capture_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF destination_id=o.session_id THEN
  source:=public.conversation_record_publication_source(w,capture_id,destination_id,actor,o.binding->>'purpose'='native_session_title');
  SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=destination_id AND workspace_id=w;
  IF NOT FOUND OR source->>'held' IS DISTINCT FROM 'false'
   OR public.sensitivity_rank(d.sensitivity)<>public.sensitivity_rank(e.cap)
   OR NOT (to_jsonb(d.compartments) @> (source->'compartments') AND e.compartments @> d.compartments)
   OR NOT (to_jsonb(d.project_ids) @> (source->'projectIds') AND public.conversation_hard_project_ids(e.compartments) @> d.project_ids)
   OR d.user_id IS NOT NULL AND d.user_id<>e.starter_user_id
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  RETURN;
 END IF;
 source:=public.read_conversation_record_for_write(w,capture_id);
 SELECT * INTO origin FROM public.conversation_envelopes WHERE session_id=o.session_id AND workspace_id=w;
 IF NOT FOUND OR source->>'held' IS DISTINCT FROM 'false'
  OR (public.sensitivity_rank(origin.cap)<=public.sensitivity_rank(d.sensitivity)
   AND origin.compartments<@d.compartments AND public.conversation_hard_project_ids(origin.compartments)<@d.project_ids) IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 original_anchor:=public.conversation_anchor_key(origin.session_id);
 IF original_anchor IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF destination_id IS NULL THEN
  -- An unresolved transcript output is never a non-conversation destination.
  -- Reacquire the real current output, including its canonical identity and
  -- audience pair, before trusting any labels in the derivation declaration.
  IF d.resource_kind NOT IN('memory','task','workspace_file') THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  destination:=public.read_scope_source(w,d.resource_kind,d.resource_id);
  IF destination->>'held' IS DISTINCT FROM 'false' OR destination->>'workspaceId' IS DISTINCT FROM w::text
   OR destination->>'version' IS DISTINCT FROM d.resource_version
   OR destination->>'retractedAt' IS NOT NULL OR destination->>'validTo' IS NOT NULL
   OR destination->>'userId' IS DISTINCT FROM d.user_id::text OR destination->>'assistantId' IS DISTINCT FROM d.assistant_id::text
   OR destination->>'sensitivity' IS DISTINCT FROM d.sensitivity
   OR NOT ((destination->'compartments') @> to_jsonb(d.compartments) AND to_jsonb(d.compartments) @> (destination->'compartments'))
   OR NOT ((destination->'projectIds') @> to_jsonb(d.project_ids) AND to_jsonb(d.project_ids) @> (destination->'projectIds'))
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  one_reader:=d.user_id;
  IF origin.visibility<>'workspace' AND one_reader IS NULL OR original_anchor<>'[]'::jsonb AND one_reader IS NULL
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 ELSE
  SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=destination_id AND workspace_id=w FOR SHARE;
  IF NOT FOUND OR public.conversation_member_read_current(w,destination_id,actor) IS NOT TRUE
   OR public.sensitivity_rank(origin.cap)>public.sensitivity_rank(e.cap) OR NOT origin.compartments<@e.compartments
   OR origin.visibility='private_by_kind' AND e.visibility<>'private_by_kind'
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF e.visibility='private_by_kind' THEN one_reader:=e.starter_user_id;END IF;
  IF origin.visibility<>'workspace' THEN
   source_readers:=ARRAY[origin.starter_user_id]||ARRAY(SELECT user_id FROM public.conversation_participants WHERE session_id=origin.session_id);
   destination_readers:=ARRAY[e.starter_user_id]||ARRAY(SELECT user_id FROM public.conversation_participants WHERE session_id=e.session_id);
   IF e.visibility='workspace' OR NOT destination_readers<@source_readers
   THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  END IF;
  IF original_anchor<>'[]'::jsonb AND original_anchor IS DISTINCT FROM public.conversation_anchor_key(e.session_id) AND one_reader IS NULL
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END IF;
 IF one_reader IS NOT NULL AND public.conversation_member_read_allowed(w,origin.session_id,one_reader) IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 PERFORM public.require_conversation_record_current_lineage(w,capture_id,actor,d);
END $edge$;
REVOKE ALL ON FUNCTION public.require_conversation_record_edge(uuid,uuid,uuid,text) FROM PUBLIC,app_user;
