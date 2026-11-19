-- Structural identity only. The live Page actor and recipient are evaluated
-- separately by the owning read and publication operation.
CREATE FUNCTION public.private_conversation_page_frame_source(w uuid,sid uuid,k text,i uuid,v text,owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $private_page_frame$
 SELECT EXISTS(
  SELECT 1 FROM public.sessions s
  JOIN public.comment_threads t ON t.workspace_id=w AND t.session_id=s.id
  LEFT JOIN public.workflow_page_event_observations o ON o.workspace_id=w AND o.id=i
   AND k IN('page_live_changed','page_live_destination')
  JOIN public.workflow_page_event_receipts r ON r.workspace_id=w AND r.page_id=t.page_id
   AND r.revision=CASE WHEN k IN('page_live_changed','page_live_destination') THEN o.receipt_id ELSE i END
  CROSS JOIN LATERAL (SELECT CASE WHEN k IN('page_event_destination','page_live_destination') THEN 'destination' ELSE 'changed' END) slot(role)
  CROSS JOIN LATERAL (SELECT CASE WHEN o.id IS NULL THEN r.boundaries->slot.role ELSE o.boundary END) selected(scope)
  WHERE s.workspace_id=w AND s.id=sid AND s.visibility='workspace' AND s.anchor_kind='doc_thread'
   AND owner IS NOT NULL AND k IN('page_event_changed','page_event_destination','page_live_changed','page_live_destination')
   AND (CASE WHEN o.id IS NOT NULL THEN o.role=slot.role ELSE slot.role='changed' OR r.metadata->>'action' IN('created','moved') END)
   AND selected.scope->>'creatorId'=owner::text
   AND public.page_event_scope_descriptor(i,slot.role,selected.scope,o.id IS NOT NULL)->>'version'=v
   AND NOT EXISTS(SELECT 1 FROM (SELECT value FROM jsonb_each(r.boundaries)
     UNION ALL SELECT o.boundary WHERE o.id IS NOT NULL) a
    WHERE a.value->>'unavailable' IS DISTINCT FROM 'false'
     OR a.value->>'pageId' IS DISTINCT FROM t.page_id::text OR a.value->>'workspaceId' IS DISTINCT FROM w::text
     OR a.value->>'principalBoundary' IS DISTINCT FROM 'private' OR a.value->>'creatorId' IS DISTINCT FROM owner::text)
 )
$private_page_frame$;
REVOKE ALL ON FUNCTION public.private_conversation_page_frame_source(uuid,uuid,text,uuid,text,uuid) FROM PUBLIC,app_user;
