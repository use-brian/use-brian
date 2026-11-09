-- [COMP:api/page-thread-audience] Private Page receipts remain bound to their own discussion.
BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;
-- This predicate admits only the original actor's private Page descriptors.
-- It cannot admit private Memory or another Page, and leaves all scalar label
-- and assistant restrictions to the existing envelope validator.
CREATE FUNCTION page_thread_private_source_visible(w uuid,source jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 sid uuid:=nullif(current_setting('app.page_thread_session_id',true),'')::uuid;
 target jsonb;boundaries jsonb;observed jsonb;b jsonb;
BEGIN
 IF actor IS NULL OR sid IS NULL OR source->>'resourceKind' NOT IN
  ('page_event_changed','page_event_destination','page_live_changed','page_live_destination')
  OR source->>'userId' IS DISTINCT FROM actor::text OR source->>'assistantId' IS NOT NULL
 THEN RETURN false;END IF;
 SELECT workflow_page_event_boundary(p),r.boundaries,o.boundary INTO target,boundaries,observed
 FROM sessions session JOIN comment_threads ct ON ct.session_id=session.id AND ct.workspace_id=session.workspace_id
 JOIN saved_views p ON p.id=ct.page_id AND p.workspace_id=session.workspace_id
 LEFT JOIN workflow_page_event_observations o ON o.workspace_id=w AND o.id=(source->>'resourceId')::uuid
  AND source->>'resourceKind' IN('page_live_changed','page_live_destination')
 JOIN workflow_page_event_receipts r ON r.workspace_id=w AND r.page_id=p.id
  AND r.revision=CASE WHEN source->>'resourceKind' IN('page_live_changed','page_live_destination')
    THEN o.receipt_id ELSE (source->>'resourceId')::uuid END
 WHERE session.id=sid AND session.workspace_id=w AND session.visibility='workspace' AND session.anchor_kind='doc_thread'
 FOR SHARE OF session,ct,p,r;
 IF NOT FOUND OR target->>'principalBoundary' IS DISTINCT FROM 'private'
  OR target->>'creatorId' IS DISTINCT FROM actor::text OR target->>'unavailable' IS DISTINCT FROM 'false'
  OR boundaries IS NULL THEN RETURN false;END IF;
 FOR b IN SELECT value FROM jsonb_each(boundaries)
  UNION ALL SELECT observed WHERE observed IS NOT NULL LOOP
  IF b->>'pageId' IS DISTINCT FROM target->>'pageId' OR b->>'workspaceId' IS DISTINCT FROM w::text
   OR b->>'principalBoundary' IS DISTINCT FROM 'private' OR b->>'creatorId' IS DISTINCT FROM actor::text
   OR b->>'unavailable' IS DISTINCT FROM 'false' THEN RETURN false;END IF;
 END LOOP;
 RETURN workflow_evidence_envelope_visible(w,source||'{"userId":null}'::jsonb);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR raise_exception THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION page_thread_private_source_visible(uuid,jsonb) FROM PUBLIC;
DO $private_page_reader$
DECLARE routine pg_proc;successor constant text:=$private_page_body$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 authority jsonb; s jsonb;
BEGIN
 IF k NOT IN ('page_event_changed','page_event_destination','page_live_changed','page_live_destination')
  OR actor IS NULL
  OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w)
  OR (nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor) THEN RETURN NULL; END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF acting IS NOT NULL THEN
  PERFORM id FROM assistants WHERE workspace_id=w AND id=acting FOR SHARE;
  IF NOT FOUND OR assistant_placement_visible(actor,acting) IS NOT TRUE THEN RETURN NULL; END IF;
 END IF;
 PERFORM id FROM workspace_groups WHERE workspace_id=w AND kind='team' ORDER BY id FOR SHARE;
 PERFORM id FROM department_edges WHERE workspace_id=w AND (user_id=actor OR assistant_id=acting) ORDER BY id FOR SHARE;
 authority:=read_page_scope_authority(w,k,i,actor);
 IF authority IS NULL OR authority->>'principalAllowed' IS DISTINCT FROM 'true'
  OR authority->'source' IS NULL OR (workflow_evidence_envelope_visible(w,authority->'source') OR page_thread_private_source_visible(w,authority->'source')) IS NOT TRUE THEN RETURN NULL; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(authority->'requiredSources') LOOP
  IF (workflow_evidence_envelope_visible(w,s) OR page_thread_private_source_visible(w,s)) IS NOT TRUE THEN RETURN NULL; END IF;
 END LOOP;
 RETURN (authority->'source')||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL,
  'requiredSources',authority->'requiredSources');
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR raise_exception THEN RETURN NULL;
END $private_page_body$;
BEGIN
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid='read_page_derivation_source(uuid,text,uuid)'::regprocedure;
 IF encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex') IS DISTINCT FROM '5e58f14a521059161570209087e4974f5cffc0e926c1a8171fd88f7d47114677'
  OR routine.prosecdef IS NOT TRUE OR routine.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
  OR routine.proowner IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid='saved_views'::regclass)
 THEN RAISE EXCEPTION 'private_page_reader_predecessor_changed';END IF;
 IF encode(sha256(convert_to(successor,'UTF8')),'hex') IS DISTINCT FROM '5955ff17494272b25bef3b5514f163c9ce7f3ff5e47dc77a198995e0519791e4'
 THEN RAISE EXCEPTION 'private_page_reader_successor_changed';END IF;
 EXECUTE replace(pg_get_functiondef(routine.oid),routine.prosrc,successor);
END $private_page_reader$;
COMMIT;
