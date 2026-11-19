 -- A canonical frame can retain Page roots from another frame. Match every
 -- immutable Page root to this thread before the native seal can accept it.
 DECLARE page_roots jsonb;page_boundary jsonb;
 BEGIN
  SELECT jsonb_agg(n) INTO page_roots FROM jsonb_array_elements(lineage) n
   WHERE n->>'kind' IN('page_event_changed','page_event_destination','page_live_changed','page_live_destination');
  IF page_roots IS NOT NULL THEN
   IF public.lock_conversation_member_read(w,s,actor) IS NOT TRUE THEN
    RAISE EXCEPTION 'page_derivation_output_not_integrated' USING ERRCODE='42501';END IF;
   SELECT public.workflow_page_event_boundary(p) INTO page_boundary FROM public.sessions session
    JOIN public.comment_threads ct ON ct.workspace_id=w AND ct.session_id=session.id
    JOIN public.saved_views p ON p.workspace_id=w AND p.id=ct.page_id
    WHERE session.workspace_id=w AND session.id=s AND session.visibility='workspace' AND session.anchor_kind='doc_thread';
   IF public.page_event_principal_allows(w,actor,page_boundary) IS NOT TRUE OR EXISTS(
    SELECT 1 FROM (
     SELECT root.*,root.kind IN('page_live_changed','page_live_destination') AS live,
      CASE WHEN root.kind IN('page_event_destination','page_live_destination') THEN 'destination' ELSE 'changed' END AS role
     FROM jsonb_to_recordset(page_roots) AS root(kind text,id uuid,version text)
    ) source
    LEFT JOIN public.workflow_page_event_observations o ON source.live AND o.workspace_id=w AND o.id=source.id AND o.role=source.role
    LEFT JOIN public.workflow_page_event_receipts r ON r.workspace_id=w AND r.page_id=(page_boundary->>'pageId')::uuid
     AND r.revision=CASE WHEN source.live THEN o.receipt_id ELSE source.id END
    WHERE r.revision IS NULL OR source.role='destination' AND r.metadata->>'action' NOT IN('created','moved')
     OR public.page_event_scope_descriptor(source.id,source.role,
      CASE WHEN source.live THEN o.boundary ELSE r.boundaries->source.role END,source.live)->>'version' IS DISTINCT FROM source.version
     OR EXISTS(SELECT 1 FROM (
      SELECT value FROM jsonb_each(r.boundaries)
      UNION ALL SELECT o.boundary WHERE source.live
     ) boundary WHERE boundary.value->>'unavailable' IS DISTINCT FROM 'false'
      OR boundary.value->>'pageId' IS DISTINCT FROM page_boundary->>'pageId'
      OR boundary.value->>'workspaceId' IS DISTINCT FROM w::text
      OR boundary.value->>'principalBoundary' IS DISTINCT FROM page_boundary->>'principalBoundary'
      OR CASE page_boundary->>'principalBoundary'
       WHEN 'private' THEN boundary.value->>'creatorId' IS DISTINCT FROM page_boundary->>'creatorId'
       WHEN 'teamspace' THEN boundary.value->>'teamspaceId' IS DISTINCT FROM page_boundary->>'teamspaceId'
       WHEN 'department' THEN boundary.value->>'departmentId' IS DISTINCT FROM page_boundary->>'departmentId'
       ELSE true END)) THEN
    RAISE EXCEPTION 'page_derivation_output_not_integrated' USING ERRCODE='42501';END IF;
  END IF;
 END;
