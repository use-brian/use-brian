-- [COMP:api/conversation-visibility] Serialize anchor-policy changes with a
-- current conversation read used by a retained write.
CREATE FUNCTION public.lock_conversation_anchor_policy_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $anchor_change$
DECLARE old_id uuid;new_id uuid;
BEGIN
 CASE TG_TABLE_NAME
 WHEN 'page_grants' THEN
  IF TG_OP<>'INSERT' THEN old_id:=OLD.page_id;END IF;
  IF TG_OP<>'DELETE' THEN new_id:=NEW.page_id;END IF;
  PERFORM id FROM public.saved_views WHERE id IN(old_id,new_id) ORDER BY id FOR NO KEY UPDATE;
 WHEN 'office_artifact_grants','office_artifact_sources' THEN
  IF TG_OP<>'INSERT' THEN old_id:=OLD.artifact_id;END IF;
  IF TG_OP<>'DELETE' THEN new_id:=NEW.artifact_id;END IF;
  PERFORM id FROM public.office_artifacts WHERE id IN(old_id,new_id) ORDER BY id FOR NO KEY UPDATE;
 WHEN 'feed_post_working_copies' THEN
  IF TG_OP<>'INSERT' THEN old_id:=OLD.session_id;END IF;
  IF TG_OP<>'DELETE' THEN new_id:=NEW.session_id;END IF;
  PERFORM id FROM public.sessions WHERE id IN(old_id,new_id) ORDER BY id FOR NO KEY UPDATE;
 ELSE RAISE EXCEPTION 'conversation_anchor_policy_changed' USING ERRCODE='55000';
 END CASE;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 RETURN NEW;
END $anchor_change$;
REVOKE ALL ON FUNCTION public.lock_conversation_anchor_policy_change() FROM PUBLIC,app_user;

CREATE TRIGGER conversation_lock_page_grants
 BEFORE INSERT OR UPDATE OR DELETE ON public.page_grants
 FOR EACH ROW EXECUTE FUNCTION public.lock_conversation_anchor_policy_change();
CREATE TRIGGER conversation_lock_office_grants
 BEFORE INSERT OR UPDATE OR DELETE ON public.office_artifact_grants
 FOR EACH ROW EXECUTE FUNCTION public.lock_conversation_anchor_policy_change();
CREATE TRIGGER conversation_lock_office_sources
 BEFORE INSERT OR UPDATE OR DELETE ON public.office_artifact_sources
 FOR EACH ROW EXECUTE FUNCTION public.lock_conversation_anchor_policy_change();
CREATE TRIGGER conversation_lock_feed_working_copy
 BEFORE INSERT OR UPDATE OR DELETE ON public.feed_post_working_copies
 FOR EACH ROW EXECUTE FUNCTION public.lock_conversation_anchor_policy_change();

CREATE FUNCTION public.lock_conversation_member_read(w uuid,sid uuid,actor uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $read_pin$
DECLARE bound_session public.sessions;root uuid;project uuid;teamspace uuid;labels text[];
BEGIN
 IF w IS NULL OR sid IS NULL OR actor IS NULL THEN RETURN false;END IF;
 PERFORM id FROM public.workspaces WHERE id=w FOR SHARE;
 PERFORM user_id FROM public.workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO bound_session FROM public.sessions s WHERE s.id=sid AND s.workspace_id=w FOR SHARE;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT e.compartments INTO labels FROM public.conversation_envelopes e WHERE e.session_id=sid AND e.workspace_id=w FOR SHARE;
 IF NOT FOUND THEN RETURN false;END IF;
 CASE bound_session.anchor_kind
 WHEN 'doc_thread' THEN
  SELECT t.page_id INTO root FROM public.comment_threads t WHERE t.session_id=sid AND t.workspace_id=w FOR SHARE;
  SELECT v.shared_project_id,v.teamspace_id INTO project,teamspace FROM public.saved_views v WHERE v.id=root AND v.workspace_id=w FOR SHARE;
  IF NOT FOUND THEN RETURN false;END IF;
  IF teamspace IS NOT NULL THEN
   PERFORM id FROM public.teamspaces WHERE id=teamspace AND workspace_id=w FOR SHARE;
   PERFORM user_id FROM public.teamspace_members WHERE teamspace_id=teamspace AND user_id=actor FOR SHARE;
  END IF;
  IF project IS NOT NULL AND NOT ('project:'||project::text)=ANY(labels) THEN labels:=array_append(labels,'project:'||project::text);END IF;
 WHEN 'office_file' THEN
  SELECT l.artifact_id INTO root FROM public.office_artifact_sessions l WHERE l.session_id=sid AND l.workspace_id=w FOR SHARE;
  PERFORM id FROM public.office_artifacts WHERE id=root AND workspace_id=w FOR SHARE;
  IF NOT FOUND THEN RETURN false;END IF;
 WHEN 'feed_thread' THEN
  SELECT t.session_id INTO root FROM public.feed_comment_threads t WHERE t.transcript_session_id=sid AND t.workspace_id=w FOR SHARE;
  PERFORM id FROM public.sessions WHERE id=root AND workspace_id=w AND anchor_kind='feed_draft' FOR SHARE;
  IF NOT FOUND THEN RETURN false;END IF;
  PERFORM session_id FROM public.conversation_envelopes WHERE session_id=root AND workspace_id=w FOR SHARE;
  IF NOT FOUND THEN RETURN false;END IF;
 WHEN 'feed_draft','none' THEN NULL;
 ELSE RETURN false;
 END CASE;
 FOR project IN SELECT unnest(public.conversation_hard_project_ids(labels)) LOOP
  PERFORM project_id FROM public.project_shared_scopes WHERE workspace_id=w AND project_id=project FOR SHARE;
  IF NOT FOUND THEN RETURN false;END IF;
  PERFORM project_id FROM public.project_shared_members WHERE project_id=project AND user_id=actor FOR SHARE;
 END LOOP;
 RETURN public.conversation_member_read_allowed(w,sid,actor);
END $read_pin$;
REVOKE ALL ON FUNCTION public.lock_conversation_member_read(uuid,uuid,uuid) FROM PUBLIC,app_user;
