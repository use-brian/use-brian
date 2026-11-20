-- [COMP:api/conversation-visibility] Proposed receiving gate for retained
-- outputs. Walk the original immutable output edges even before enrollment.
-- Source changes perform no synchronous traversal of dependent outputs.
CREATE FUNCTION public.conversation_record_derivative_origin(
 w uuid, capture_id uuid, recipient uuid, destination public.scope_derivations
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $origin_current$
DECLARE
 observation public.private_transcript_observations;
 envelope public.conversation_envelopes;
 reader uuid;
 projected jsonb;
 origin_anchor jsonb;
 selected_after integer;selected_through integer;selected_topics integer;
 candidate_count integer;candidate_bytes bigint;
BEGIN
 SELECT * INTO observation FROM public.private_transcript_observations o
 WHERE o.workspace_id=w AND o.id=capture_id;
 IF NOT FOUND OR observation.binding->>'kind' IS DISTINCT FROM 'conversation_record_v1'
  OR observation.binding->>'purpose' IS DISTINCT FROM 'native_member_dialogue'
  OR observation.binding->'legacyRowsSelected' IS DISTINCT FROM 'false'::jsonb
 THEN RETURN NULL;END IF;
 SELECT * INTO envelope FROM public.conversation_envelopes e
 WHERE e.workspace_id=w AND e.session_id=observation.session_id;
 IF NOT FOUND OR destination.workspace_id IS DISTINCT FROM w
  OR public.sensitivity_rank(envelope.cap)>public.sensitivity_rank(destination.sensitivity)
  OR NOT envelope.compartments<@destination.compartments
  OR NOT public.conversation_hard_project_ids(envelope.compartments)<@destination.project_ids
 THEN RETURN NULL;END IF;
 reader:=(observation.binding->>'readerUserId')::uuid;
 origin_anchor:=public.conversation_anchor_key(envelope.session_id);
 IF origin_anchor IS NULL OR reader IS NULL OR public.conversation_member_read_allowed(w,envelope.session_id,reader) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.sessions s JOIN public.assistants a ON a.id=s.assistant_id AND a.workspace_id=w
   WHERE s.id=envelope.session_id AND NOT reader=ANY(a.blocked_user_ids) AND public.assistant_placement_visible(reader,a.id))
  OR destination.user_id IS NULL AND destination.resource_kind NOT IN('session_message','session_context_revision')
   AND (envelope.visibility<>'workspace' OR origin_anchor<>'[]'::jsonb)
  OR recipient IS NOT NULL AND public.conversation_member_read_allowed(w,envelope.session_id,recipient) IS NOT TRUE
 THEN RETURN NULL;END IF;
 -- A later append or benign settings transition can preserve the exact
 -- selected window. Current role/anchor expiry and a changed selection do
 -- not require a dependency index or a notification to withhold this copy.
 selected_after:=(observation.manifest->>'afterSequence')::integer;
 selected_through:=(observation.manifest->>'throughSequence')::integer;
 selected_topics:=(observation.manifest->>'topicThroughSequence')::integer;
 SELECT count(*),coalesce(sum(bytes),0) INTO candidate_count,candidate_bytes
 FROM (SELECT octet_length(m.content::text)+octet_length(m.attachments::text) AS bytes FROM public.session_messages m
  WHERE m.session_id=envelope.session_id AND m.sequence_num>selected_after AND m.sequence_num<=selected_through
  ORDER BY m.sequence_num LIMIT 4097) bounded;
 IF candidate_count>4096 OR candidate_bytes>8388608 THEN RETURN NULL;END IF;
 projected:=public.project_conversation_record(envelope,selected_after,selected_through,selected_topics,false,reader);
 IF (projected->'manifest') IS DISTINCT FROM observation.manifest THEN RETURN NULL;END IF;
 RETURN projected;
END $origin_current$;
REVOKE ALL ON FUNCTION public.conversation_record_derivative_origin(uuid,uuid,uuid,public.scope_derivations)
 FROM PUBLIC,app_user;

CREATE FUNCTION public.conversation_record_derivative_edges(w uuid,capture_id uuid,k text,i uuid,recipient uuid,
 destination public.scope_derivations)
RETURNS TABLE(kind text,id uuid,version text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $derivative_edges$
DECLARE sid uuid;projection jsonb;
BEGIN
 SELECT o.session_id INTO sid FROM public.private_transcript_observations o WHERE o.workspace_id=w AND o.id=capture_id;
 -- A durable reply may retain the conversation's own delivered record.
 IF (k,i)=(destination.resource_kind,destination.resource_id) AND sid=(CASE k
  WHEN 'session_message' THEN (SELECT m.session_id FROM public.session_messages m WHERE m.workspace_id=w AND m.id=i)
  WHEN 'session_context_revision' THEN (SELECT r.session_id FROM public.session_context_scope_revisions r WHERE r.workspace_id=w AND r.id=i)
  END) THEN RETURN;END IF;
 projection:=public.conversation_record_derivative_origin(w,capture_id,recipient,destination);
 IF projection IS NULL THEN
  RETURN QUERY SELECT 'conversation_record_refused'::text,capture_id,NULL::text;
  RETURN;
 END IF;
 RETURN QUERY SELECT 'conversation_record_current_root'::text,capture_id,'1'::text
 UNION ALL SELECT 'session_message'::text,m.id,m.scope_version::text
 FROM jsonb_array_elements(projection->'rows') item
 JOIN public.session_messages m ON m.id=(item->>'id')::uuid AND m.workspace_id=w AND m.session_id=sid
 UNION ALL SELECT 'session_context_revision'::text,(item->>'revisionId')::uuid,item->>'version'
 FROM jsonb_array_elements(projection->'annotations') item;
END $derivative_edges$;
REVOKE ALL ON FUNCTION public.conversation_record_derivative_edges(uuid,uuid,text,uuid,uuid,public.scope_derivations) FROM PUBLIC,app_user;

CREATE FUNCTION public.conversation_record_retained_native_source(w uuid,k text,i uuid,recipient uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $native_source$
DECLARE original_actor text:=current_setting('app.current_user_id',true);source jsonb;
BEGIN
 IF recipient IS NULL THEN RETURN public.read_scope_source(w,k,i);END IF;
 IF recipient::text IS NOT DISTINCT FROM original_actor THEN RETURN public.read_admitted_native_scope_snapshot(w,k,i);END IF;
 PERFORM set_config('app.current_user_id',recipient::text,true);
 source:=public.read_admitted_native_scope_snapshot(w,k,i);
 PERFORM set_config('app.current_user_id',coalesce(original_actor,''),true);
 RETURN source;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('app.current_user_id',coalesce(original_actor,''),true);
 RAISE;
END $native_source$;
REVOKE ALL ON FUNCTION public.conversation_record_retained_native_source(uuid,text,uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.conversation_record_derivation_current(w uuid,k text,i uuid,v text,recipient uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $derived_current$
DECLARE
 destination public.scope_derivations;
 node record;
 total integer;intact boolean;record_found boolean;obligations jsonb;
 prior_possible boolean:=false;
 snapshot jsonb;
BEGIN
 IF w IS NULL THEN RETURN true;END IF;
 IF k IS NULL OR i IS NULL OR v IS NULL THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.scope_derivations d WHERE d.workspace_id=w AND d.resource_kind=k AND d.resource_id=i) THEN
  -- A content/metadata revision cannot discard its predecessor's lineage.
  CASE k
  WHEN 'memory' THEN SELECT EXISTS(SELECT 1 FROM public.memories m WHERE m.workspace_id=w AND m.superseded_by=i) INTO prior_possible;
  WHEN 'task' THEN SELECT EXISTS(SELECT 1 FROM public.tasks t WHERE t.workspace_id=w AND t.superseded_by=i) INTO prior_possible;
  WHEN 'workspace_file' THEN SELECT EXISTS(SELECT 1 FROM public.workspace_files f WHERE f.workspace_id=w AND f.superseded_by=i) INTO prior_possible;
  ELSE NULL;
  END CASE;
  IF NOT prior_possible THEN RETURN true;END IF;
 END IF;
 snapshot:=public.read_scope_source(w,k,i);
 IF snapshot->>'workspaceId' IS DISTINCT FROM w::text OR snapshot->>'version' IS DISTINCT FROM v
  OR snapshot->>'held' IS DISTINCT FROM 'false' OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL
 THEN RETURN false;END IF;
 destination.workspace_id:=w;destination.resource_kind:=k;destination.resource_id:=i;
 destination.user_id:=(snapshot->>'userId')::uuid;
 destination.assistant_id:=(snapshot->>'assistantId')::uuid;
 destination.sensitivity:=snapshot->>'sensitivity';
 destination.compartments:=ARRAY(SELECT jsonb_array_elements_text(snapshot->'compartments'));
 destination.project_ids:=ARRAY(SELECT jsonb_array_elements_text(snapshot->'projectIds')::uuid);
 WITH RECURSIVE origins(kind,id,version,parent_kind,parent_id) AS (
  SELECT edge.kind,edge.id,edge.version,k,i FROM public.conversation_source_edges(w,k,i,v) edge
  UNION SELECT forward.kind,forward.id,forward.version,origins.kind,origins.id
   FROM origins CROSS JOIN LATERAL (
    SELECT edge.* FROM public.conversation_source_edges(w,origins.kind,origins.id,origins.version) edge
    WHERE origins.kind NOT IN('conversation_record','conversation_record_current_root','conversation_record_refused')
    UNION ALL
    SELECT edge.* FROM public.conversation_record_derivative_edges(w,origins.id,origins.parent_kind,origins.parent_id,recipient,destination) edge
    WHERE origins.kind='conversation_record'
   ) forward
 ), bounded AS MATERIALIZED(SELECT origins.* FROM origins LIMIT 4097)
 SELECT count(*),coalesce(bool_and(version IS NOT NULL AND (kind<>'conversation_record' OR version='1')),true),
  coalesce(bool_or(kind='conversation_record_current_root'),false),
  coalesce(jsonb_agg(jsonb_build_array(kind,id,version))
   FILTER(WHERE kind NOT IN('conversation_record','conversation_record_current_root')),'[]'::jsonb)
 INTO total,intact,record_found,obligations FROM bounded;
 IF total>4096 OR NOT intact THEN RETURN false;END IF;
 IF NOT record_found THEN RETURN true;END IF;
 IF destination.user_id IS NOT NULL AND destination.user_id IS DISTINCT FROM recipient THEN RETURN false;END IF;
 FOR node IN SELECT DISTINCT value->>0 kind,(value->>1)::uuid id,value->>2 version FROM jsonb_array_elements(obligations) LOOP
  IF node.kind NOT IN('memory','task','workspace_file','entity','entity_link','episode','session_message','session_context_revision')
  THEN RETURN false;END IF;
  IF node.kind='session_message' AND recipient IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.session_messages m
   WHERE m.workspace_id=w AND m.id=node.id AND public.conversation_member_read_allowed(w,m.session_id,recipient))
   OR node.kind='session_context_revision' AND recipient IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.session_context_scope_revisions r
   WHERE r.workspace_id=w AND r.id=node.id AND public.conversation_member_read_allowed(w,r.session_id,recipient))
  THEN RETURN false;END IF;
  snapshot:=CASE WHEN node.kind IN('session_message','session_context_revision') THEN public.read_scope_source(w,node.kind,node.id)
    ELSE public.conversation_record_retained_native_source(w,node.kind,node.id,recipient) END;
  IF snapshot->>'version' IS DISTINCT FROM node.version OR snapshot->>'held' IS DISTINCT FROM 'false'
   OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL
   OR (snapshot->>'userId' IS NOT NULL AND snapshot->>'userId' IS DISTINCT FROM destination.user_id::text)
   OR (snapshot->>'assistantId' IS NOT NULL AND snapshot->>'assistantId' IS DISTINCT FROM destination.assistant_id::text)
   OR (public.sensitivity_rank(snapshot->>'sensitivity')<=public.sensitivity_rank(destination.sensitivity)
    AND to_jsonb(destination.compartments) @> (snapshot->'compartments')
    AND to_jsonb(destination.project_ids) @> (snapshot->'projectIds')) IS NOT TRUE
  THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN insufficient_privilege OR invalid_parameter_value OR invalid_text_representation THEN RETURN false;
END $derived_current$;
REVOKE ALL ON FUNCTION public.conversation_record_derivation_current(uuid,text,uuid,text,uuid) FROM PUBLIC,app_user;
