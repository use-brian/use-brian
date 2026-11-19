-- [COMP:api/conversation-visibility] A Page-thread delivery reads one current
-- destination/actor boundary and then proves its exact ordinary and Page roots.
-- Room and member floors are applied independently by the receiving host.
CREATE FUNCTION public.capture_native_page_turn_delivery(w uuid, actor uuid, answering uuid, sid uuid,
 device uuid, native_version integer, credential_actor uuid, include_departments boolean,
 include_policy boolean, token uuid, boundary text, ordinary jsonb, pages jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $page_delivery$
DECLARE facts jsonb;proof jsonb;target jsonb;candidate record;source jsonb;current_pages jsonb:='[]';
 required jsonb;receipt_proofs jsonb:='{}';current_digest text;
BEGIN
 IF boundary IS NULL OR boundary NOT IN ('dispatch','frame')
  OR jsonb_typeof(ordinary) IS DISTINCT FROM 'array' OR jsonb_array_length(ordinary)>4096
  OR jsonb_typeof(pages) IS DISTINCT FROM 'array' OR jsonb_array_length(pages)>32
  OR EXISTS(SELECT 1 FROM jsonb_to_recordset(pages) AS p(kind text,id uuid,version text)
   WHERE p.id IS NULL OR p.version IS NULL OR p.kind IS NULL OR p.kind NOT IN
    ('page_event_changed','page_event_destination','page_live_changed','page_live_destination'))
 THEN RAISE EXCEPTION 'invalid_scope_source' USING ERRCODE='22023'; END IF;
 -- The shared lock order is workspace/member/session/envelope followed by the
 -- concrete Page. The normal writer (including grants) waits on those rows.
 facts:=public.conversation_page_turn_facts(w,actor,answering,sid,device,native_version,credential_actor,
  include_departments,include_policy,token,boundary);
 SELECT public.workflow_page_event_boundary(p) INTO target
 FROM public.sessions s JOIN public.comment_threads ct ON ct.session_id=s.id AND ct.workspace_id=w
 JOIN public.saved_views p ON p.id=ct.page_id AND p.workspace_id=w
 WHERE s.id=sid AND s.workspace_id=w AND s.visibility='workspace' AND s.anchor_kind='doc_thread';
 IF target->>'unavailable' IS DISTINCT FROM 'false'
 THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;

 IF jsonb_array_length(pages)>0 AND public.page_event_principal_allows(w,actor,target) IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;

 -- The ordinary planner must positively own every non-Page root, including
 -- its current ancestry. An independent family must use its existing owner.
 IF jsonb_array_length(ordinary)>0 THEN
  proof:=public.capture_conversation_evidence(w,ordinary);
  IF proof IS NULL THEN RETURN NULL; END IF;
 END IF;

 current_digest:=encode(sha256(convert_to(target::text,'UTF8')),'hex');
 FOR candidate IN SELECT input.kind,input.id,input.version,r.revision,r.boundaries,r.metadata,
  o.id AS observation_id,o.role AS observation_role,o.boundary AS observation,
  CASE WHEN input.kind IN('page_event_destination','page_live_destination') THEN 'destination' ELSE 'changed' END AS role
  FROM ROWS FROM(jsonb_to_recordset(pages) AS (kind text,id uuid,version text)) WITH ORDINALITY input(kind,id,version,ordinality)
  LEFT JOIN public.workflow_page_event_observations o ON o.workspace_id=w AND o.id=input.id
   AND input.kind IN('page_live_changed','page_live_destination')
  LEFT JOIN public.workflow_page_event_receipts r ON r.workspace_id=w AND r.page_id=(target->>'pageId')::uuid
   AND r.revision=CASE WHEN input.kind IN('page_live_changed','page_live_destination') THEN o.receipt_id ELSE input.id END
  ORDER BY input.ordinality
 LOOP
  -- Every saved or observed receipt axis must describe this exact live Page.
  -- A Page receipt elsewhere with identical labels never satisfies the room.
  IF candidate.boundaries IS NULL OR EXISTS(
   SELECT 1 FROM (SELECT value FROM jsonb_each(candidate.boundaries)
    UNION ALL SELECT candidate.observation WHERE candidate.observation IS NOT NULL) b
   WHERE b.value->>'unavailable' IS DISTINCT FROM 'false'
    OR b.value->>'pageId' IS DISTINCT FROM target->>'pageId' OR b.value->>'workspaceId' IS DISTINCT FROM w::text
    OR b.value->>'principalBoundary' IS DISTINCT FROM target->>'principalBoundary'
    OR CASE target->>'principalBoundary'
     WHEN 'private' THEN b.value->>'creatorId' IS DISTINCT FROM target->>'creatorId'
     WHEN 'department' THEN b.value->>'departmentId' IS DISTINCT FROM target->>'departmentId'
     WHEN 'teamspace' THEN b.value->>'teamspaceId' IS DISTINCT FROM target->>'teamspaceId'
     ELSE true END)
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
  IF (candidate.kind IN('page_live_changed','page_live_destination')
    AND (candidate.observation_id IS NULL OR candidate.observation_role IS DISTINCT FROM candidate.role))
   OR (candidate.role='destination' AND candidate.metadata->>'action' NOT IN('created','moved'))
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
  source:=public.page_event_scope_descriptor(candidate.id,candidate.role,
   CASE WHEN candidate.observation_id IS NOT NULL THEN candidate.observation ELSE candidate.boundaries->candidate.role END,
   candidate.observation_id IS NOT NULL);
  IF candidate.observation_id IS NOT NULL THEN
   PERFORM 1 FROM public.workflow_page_event_observations WHERE workspace_id=w AND id=candidate.observation_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
  END IF;
  IF source->>'version' IS DISTINCT FROM candidate.version
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;

  -- Each receipt has one saved/current projection. Its multiple roots keep
  -- their own identities and exact original versions in the returned order.
  required:=receipt_proofs->candidate.revision::text;
  IF required IS NULL THEN
   PERFORM 1 FROM public.workflow_page_event_receipts WHERE workspace_id=w AND revision=candidate.revision FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
   SELECT jsonb_agg(origin.value ORDER BY b.key,origin.ordinality) INTO required
   FROM jsonb_each(candidate.boundaries) b
   LEFT JOIN LATERAL (SELECT o.id FROM public.workflow_page_event_observations o WHERE o.workspace_id=w
    AND o.receipt_id=candidate.revision AND o.role=b.key AND o.boundary_digest=current_digest AND o.boundary=target FOR SHARE
   ) current_observation ON true
   CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(
    public.page_event_scope_descriptor(candidate.revision,b.key,b.value,false),
    CASE WHEN current_observation.id IS NOT NULL THEN public.page_event_scope_descriptor(current_observation.id,b.key,target,true)
     ELSE public.capture_page_event_observation(w,candidate.revision,b.key,target) END
   )) WITH ORDINALITY origin(value,ordinality)
   WHERE (b.key='changed' OR candidate.metadata->>'action' IN('created','moved')) AND origin.value IS DISTINCT FROM 'null'::jsonb;
   IF required IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
   receipt_proofs:=jsonb_set(receipt_proofs,ARRAY[candidate.revision::text],required,true);
  END IF;
  current_pages:=current_pages||jsonb_build_array(jsonb_build_object('source',source,'requiredSources',required,'principalAllowed',true));
 END LOOP;
 RETURN facts||jsonb_build_object('ordinary',proof,'pages',current_pages);
END $page_delivery$;
REVOKE ALL ON FUNCTION public.capture_native_page_turn_delivery(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid,text,jsonb,jsonb) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.capture_native_page_turn_delivery(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid,text,jsonb,jsonb) TO app_user;

-- Select the exact Page revision the original app-role projection may read.
-- The caller projects the Page and collaborative document under original RLS.
CREATE FUNCTION public.capture_native_page_turn_anchor(w uuid, actor uuid, answering uuid, sid uuid,
 device uuid, native_version integer, credential_actor uuid, include_departments boolean,
 include_policy boolean, token uuid, requested_page uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $page_anchor$
DECLARE revision uuid;admitted jsonb;payload jsonb;
BEGIN
 SELECT p.page_event_revision INTO revision FROM public.comment_threads t
 JOIN public.saved_views p ON p.workspace_id=t.workspace_id AND p.id=t.page_id
 WHERE t.workspace_id=w AND t.session_id=sid AND p.id=requested_page;
 IF revision IS NULL THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 admitted:=public.capture_native_page_turn_delivery(w,actor,answering,sid,device,native_version,credential_actor,
  include_departments,include_policy,token,'dispatch','[]',
  jsonb_build_array(jsonb_build_object('kind','page_event_changed','id',revision,'version',revision)));
 SELECT jsonb_build_object('page',coalesce(d.snapshot_json,p.page),'version',coalesce(d.seq::integer,p.version),
  'title',coalesce(d.snapshot_title,p.name),'nameOrigin',p.name_origin,'icon',p.icon)
 INTO payload FROM public.saved_views p LEFT JOIN public.documents d ON d.page_id=p.id
 WHERE p.id=requested_page AND p.workspace_id=w AND p.page_event_revision=revision;
 IF payload IS NULL OR admitted IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('authority',admitted->'authority','page',payload,'source',admitted->'pages'->0);
END $page_anchor$;
REVOKE ALL ON FUNCTION public.capture_native_page_turn_anchor(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid,uuid) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.capture_native_page_turn_anchor(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid,uuid) TO app_user;
