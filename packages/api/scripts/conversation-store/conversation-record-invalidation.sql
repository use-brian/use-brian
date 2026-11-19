-- [COMP:api/conversation-visibility] Only fresh outward derivatives enroll
-- original dependencies. The ordinary record remains independent of that graph.
CREATE TABLE public.conversation_record_derivation_dependencies(
 workspace_id uuid NOT NULL,
 derivation_id uuid NOT NULL,
 dependency_kind text NOT NULL,
 dependency_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,derivation_id,dependency_kind,dependency_id),
 FOREIGN KEY(workspace_id,derivation_id) REFERENCES public.scope_derivations(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX conversation_record_derivation_dependencies_source
 ON public.conversation_record_derivation_dependencies(workspace_id,dependency_kind,dependency_id,derivation_id);
ALTER TABLE public.conversation_record_derivation_dependencies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversation_record_derivation_dependencies FROM PUBLIC,app_user;

CREATE FUNCTION public.conversation_record_dependency_reader(w uuid,kind text,target uuid,actor uuid,snapshot jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $dependency_reader$
DECLARE grants jsonb;sid uuid;member public.workspace_members;v2 boolean;teams text[];projects uuid[];
BEGIN
 SELECT * INTO member FROM public.workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RETURN false;END IF;
 IF kind='session_message' THEN
  SELECT session_id INTO sid FROM public.session_messages WHERE workspace_id=w AND id=target FOR SHARE;
 ELSIF kind='session_context_revision' THEN
  SELECT session_id INTO sid FROM public.session_context_scope_revisions WHERE workspace_id=w AND id=target FOR SHARE;
 END IF;
 IF kind IN('session_message','session_context_revision') AND
  (sid IS NULL OR public.conversation_member_read_allowed(w,sid,actor) IS NOT TRUE) THEN RETURN false;END IF;
 IF snapshot->>'userId' IS NOT NULL AND snapshot->>'userId' IS DISTINCT FROM actor::text THEN RETURN false;END IF;
 -- Only a source with an unambiguous human audience is accepted here. An
 -- independently scoped application, Page or integration leaf needs its own
 -- authenticated receiver, and the caller fails closed when it finds one.
 IF snapshot->>'assistantId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.assistants a
  WHERE a.id=(snapshot->>'assistantId')::uuid AND a.workspace_id=w AND public.assistant_placement_visible(actor,a.id))
 THEN RETURN false;END IF;
 SELECT department_read_v2 INTO v2 FROM public.workspaces WHERE id=w FOR SHARE;
 grants:=public.department_read_grants_for(actor);
 teams:=ARRAY(SELECT jsonb_array_elements_text(snapshot->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(snapshot->'projectIds')::uuid);
 IF (CASE WHEN v2 THEN public.department_row_allows(grants,w,snapshot->>'sensitivity',teams,NULL)
  ELSE public.sensitivity_rank(member.clearance)>=public.sensitivity_rank(snapshot->>'sensitivity')
   AND (public.effective_member_read_compartments(actor,w) IS NULL OR teams<@public.effective_member_read_compartments(actor,w)) END) IS NOT TRUE
  OR public.project_labels_allowed(grants,w,teams||ARRAY(SELECT 'project:'||value::text FROM unnest(projects) value),false) IS NOT TRUE
 THEN RETURN false;END IF;
 RETURN true;
END $dependency_reader$;
REVOKE ALL ON FUNCTION public.conversation_record_dependency_reader(uuid,text,uuid,uuid,jsonb) FROM PUBLIC,app_user;

CREATE FUNCTION public.index_conversation_record_lineage(w uuid,capture_id uuid,actor uuid,recipient uuid,d public.scope_derivations)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $index_lineage$
DECLARE node record;snapshot jsonb;seen integer:=0;sid uuid;catalog_table name;locked uuid;anchor jsonb;project uuid;
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
   SELECT o.session_id INTO sid FROM public.private_transcript_observations o WHERE o.workspace_id=w AND o.id=node.id;
   IF node.version IS DISTINCT FROM '1' OR sid IS NULL OR recipient IS NOT NULL
    AND public.conversation_member_read_allowed(w,sid,recipient) IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   anchor:=public.conversation_anchor_key(sid);
   IF anchor IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   INSERT INTO public.conversation_record_derivation_dependencies VALUES(w,d.id,'conversation_session',sid),
    (w,d.id,'workspace_member',actor) ON CONFLICT DO NOTHING;
   IF recipient IS NOT NULL THEN
    INSERT INTO public.conversation_record_derivation_dependencies VALUES(w,d.id,'workspace_member',recipient) ON CONFLICT DO NOTHING;
   END IF;
   IF anchor->>0='page' THEN
    PERFORM id FROM public.saved_views WHERE id=(anchor->>1)::uuid AND workspace_id=w FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
    INSERT INTO public.conversation_record_derivation_dependencies VALUES(w,d.id,'page_anchor',(anchor->>1)::uuid) ON CONFLICT DO NOTHING;
   ELSIF anchor->>0='office' THEN
    PERFORM id FROM public.office_artifacts WHERE id=(anchor->>1)::uuid AND workspace_id=w FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
    INSERT INTO public.conversation_record_derivation_dependencies VALUES(w,d.id,'office_anchor',(anchor->>1)::uuid) ON CONFLICT DO NOTHING;
   END IF;
   FOR project IN SELECT unnest(public.conversation_hard_project_ids(e.compartments)) FROM public.conversation_envelopes e WHERE e.session_id=sid LOOP
    PERFORM project_id FROM public.project_shared_scopes WHERE workspace_id=w AND project_id=project FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
    INSERT INTO public.conversation_record_derivation_dependencies VALUES(w,d.id,'project_scope',project) ON CONFLICT DO NOTHING;
   END LOOP;
   -- Pin the grant/anchor locks before the final check in the same write.
   IF public.conversation_member_read_allowed(w,sid,actor) IS NOT TRUE OR recipient IS NOT NULL
    AND public.conversation_member_read_allowed(w,sid,recipient) IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   CONTINUE;
  END IF;
  IF node.kind NOT IN('session_message','session_context_revision','memory','task','workspace_file','entity','entity_link','episode')
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  catalog_table:=CASE node.kind WHEN 'session_message' THEN 'session_messages'
   WHEN 'session_context_revision' THEN 'session_context_scope_revisions' WHEN 'memory' THEN 'memories'
   WHEN 'task' THEN 'tasks' WHEN 'workspace_file' THEN 'workspace_files' WHEN 'entity' THEN 'entities'
   WHEN 'entity_link' THEN 'entity_links' WHEN 'episode' THEN 'episodes' END;
  EXECUTE format('SELECT id FROM public.%I WHERE workspace_id=$1 AND id=$2 FOR SHARE',catalog_table) INTO locked USING w,node.id;
  IF locked IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  snapshot:=public.read_scope_source(w,node.kind,node.id);
  IF snapshot->>'held' IS DISTINCT FROM 'false' OR snapshot->>'version' IS DISTINCT FROM node.version
   OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL OR snapshot->>'workspaceId' IS DISTINCT FROM w::text
   OR snapshot->>'userId' IS NOT NULL AND snapshot->>'userId' IS DISTINCT FROM d.user_id::text
   OR snapshot->>'assistantId' IS NOT NULL AND snapshot->>'assistantId' IS DISTINCT FROM d.assistant_id::text
   OR (public.sensitivity_rank(snapshot->>'sensitivity')<=public.sensitivity_rank(d.sensitivity)
    AND to_jsonb(d.compartments) @> (snapshot->'compartments') AND to_jsonb(d.project_ids) @> (snapshot->'projectIds')) IS NOT TRUE
   OR public.conversation_record_dependency_reader(w,node.kind,node.id,actor,snapshot) IS NOT TRUE
   OR recipient IS NOT NULL AND recipient<>actor AND public.conversation_record_dependency_reader(w,node.kind,node.id,recipient,snapshot) IS NOT TRUE
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  INSERT INTO public.conversation_record_derivation_dependencies VALUES(w,d.id,node.kind,node.id) ON CONFLICT DO NOTHING;
 END LOOP;
END $index_lineage$;
REVOKE ALL ON FUNCTION public.index_conversation_record_lineage(uuid,uuid,uuid,uuid,public.scope_derivations) FROM PUBLIC,app_user;

-- Retain synchronous invalidation for these writes. The indexed relation is
-- empty on the ordinary capture/append/stream path. A committed change never
-- leaves a readable window awaiting a background worker or a retry.
CREATE FUNCTION public.hold_conversation_record_dependents(w uuid,kind text,target uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $held_dependents$
DECLARE output record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.conversation_record_derivation_dependencies dependency
  WHERE dependency.workspace_id=w AND dependency.dependency_kind=kind AND dependency.dependency_id=target)
 THEN RETURN;END IF;
 FOR output IN WITH RECURSIVE affected(k,i) AS (
  SELECT kind,target
  UNION SELECT d.resource_kind,d.resource_id FROM affected source CROSS JOIN LATERAL (
   SELECT dependency.derivation_id FROM public.conversation_record_derivation_dependencies dependency
    WHERE dependency.workspace_id=w AND dependency.dependency_kind=source.k AND dependency.dependency_id=source.i
   UNION SELECT edge.derivation_id FROM public.scope_derivation_sources edge
    WHERE edge.workspace_id=w AND edge.source_kind=source.k AND edge.source_id=source.i
  ) successor JOIN public.scope_derivations d ON d.workspace_id=w AND d.id=successor.derivation_id
 ) SELECT affected.* FROM affected WHERE (k,i) IS DISTINCT FROM (kind,target) ORDER BY k,i LOOP
  CASE output.k
  WHEN 'memory' THEN UPDATE public.memories SET scope_held=true WHERE workspace_id=w AND id=output.i AND NOT scope_held;
  WHEN 'task' THEN UPDATE public.tasks SET scope_held=true WHERE workspace_id=w AND id=output.i AND NOT scope_held;
  WHEN 'workspace_file' THEN UPDATE public.workspace_files SET scope_held=true WHERE workspace_id=w AND id=output.i AND NOT scope_held;
  WHEN 'entity' THEN UPDATE public.entities SET scope_held=true WHERE workspace_id=w AND id=output.i AND NOT scope_held;
  WHEN 'entity_link' THEN UPDATE public.entity_links SET scope_held=true WHERE workspace_id=w AND id=output.i AND NOT scope_held;
  WHEN 'episode' THEN UPDATE public.episodes SET scope_held=true WHERE workspace_id=w AND id=output.i AND NOT scope_held;
  WHEN 'knowledge_entry' THEN UPDATE public.knowledge_entries SET scope_held=true WHERE workspace_id=w AND id=output.i AND NOT scope_held;
  ELSE NULL;
  END CASE;
 END LOOP;
END $held_dependents$;
REVOKE ALL ON FUNCTION public.hold_conversation_record_dependents(uuid,text,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.withdraw_conversation_dependents_on_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $generation$
BEGIN
 IF OLD.workspace_id IS NOT NULL AND (TG_OP='DELETE' OR NEW.version IS DISTINCT FROM OLD.version) THEN
  PERFORM public.hold_conversation_record_dependents(OLD.workspace_id,'conversation_session',OLD.session_id);
 END IF;
 RETURN NULL;
END $generation$;
REVOKE ALL ON FUNCTION public.withdraw_conversation_dependents_on_generation() FROM PUBLIC,app_user;
CREATE TRIGGER conversation_record_generation_invalidation AFTER UPDATE OF version OR DELETE ON public.conversation_envelopes
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_dependents_on_generation();

CREATE FUNCTION public.withdraw_conversation_dependents_on_explicit_hold() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $explicit_hold$
BEGIN
 IF NEW.review_state='held' AND (TG_OP='INSERT' OR OLD.review_state IS DISTINCT FROM NEW.review_state) THEN
  PERFORM public.hold_conversation_record_dependents(NEW.workspace_id,NEW.resource_kind,NEW.resource_id);
 END IF;
 RETURN NULL;
END $explicit_hold$;
REVOKE ALL ON FUNCTION public.withdraw_conversation_dependents_on_explicit_hold() FROM PUBLIC,app_user;
CREATE TRIGGER conversation_record_explicit_hold_invalidation AFTER INSERT OR UPDATE OF review_state ON public.scope_resource_states
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_dependents_on_explicit_hold();

CREATE FUNCTION public.withdraw_conversation_dependents_on_scope_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $source_scope$
DECLARE changed jsonb:=CASE WHEN TG_OP='INSERT' THEN to_jsonb(NEW) ELSE to_jsonb(OLD) END;
 workspace uuid:=(changed->>'workspace_id')::uuid;kind text;target uuid;
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW) THEN RETURN NULL;END IF;
 IF TG_TABLE_NAME='office_artifact_grants' AND TG_OP='INSERT' AND changed->>'role'<>'deny' THEN RETURN NULL;END IF;
 IF TG_TABLE_NAME='workspace_members' THEN
  kind:='workspace_member';target:=(changed->>'user_id')::uuid;
 ELSIF TG_TABLE_NAME='workspace_group_members' THEN
  kind:='workspace_member';target:=(changed->>'user_id')::uuid;
  SELECT w.workspace_id INTO workspace FROM public.workspace_groups w WHERE w.id=(changed->>'group_id')::uuid;
 ELSIF TG_TABLE_NAME IN('project_shared_scopes','project_shared_members') THEN
  kind:='project_scope';target:=(changed->>'project_id')::uuid;
  PERFORM project_id FROM public.project_shared_scopes p WHERE p.project_id=target FOR NO KEY UPDATE;
 ELSIF TG_TABLE_NAME IN('saved_views','page_grants') THEN
  kind:='page_anchor';target:=(coalesce(changed->>'page_id',changed->>'id'))::uuid;
  IF TG_TABLE_NAME='page_grants' AND changed->>'principal_type' IN('link','published') THEN RETURN NULL;END IF;
  IF TG_TABLE_NAME='page_grants' THEN
   SELECT p.workspace_id INTO workspace FROM public.saved_views p WHERE p.id=target FOR NO KEY UPDATE;
  ELSE
   PERFORM p.id FROM public.saved_views p WHERE p.id=target FOR NO KEY UPDATE;
  END IF;
 ELSIF TG_TABLE_NAME IN('office_artifacts','office_artifact_grants','office_artifact_sources') THEN
  kind:='office_anchor';target:=(coalesce(changed->>'artifact_id',changed->>'id'))::uuid;
  PERFORM id FROM public.office_artifacts a WHERE a.id=target FOR NO KEY UPDATE;
 ELSE RAISE EXCEPTION 'conversation_unreviewed_withdrawal_owner';END IF;
 IF workspace IS NOT NULL AND target IS NOT NULL THEN
  PERFORM public.hold_conversation_record_dependents(workspace,kind,target);
 END IF;
 RETURN NULL;
END $source_scope$;
REVOKE ALL ON FUNCTION public.withdraw_conversation_dependents_on_scope_change() FROM PUBLIC,app_user;
CREATE TRIGGER conversation_member_scope_withdrawal AFTER UPDATE OF role,clearance OR DELETE ON public.workspace_members
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_dependents_on_scope_change();
CREATE TRIGGER conversation_member_group_withdrawal AFTER DELETE ON public.workspace_group_members
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_dependents_on_scope_change();
CREATE TRIGGER conversation_project_scope_withdrawal AFTER UPDATE OF status OR DELETE ON public.project_shared_scopes
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_dependents_on_scope_change();
CREATE TRIGGER conversation_project_member_withdrawal AFTER UPDATE OF expires_at OR DELETE ON public.project_shared_members
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_dependents_on_scope_change();
CREATE TRIGGER conversation_page_anchor_withdrawal AFTER UPDATE OF clearance,parent_page_id OR DELETE ON public.saved_views
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_dependents_on_scope_change();
CREATE TRIGGER conversation_page_grant_withdrawal AFTER UPDATE OF role,revoked_at,expires_at OR DELETE ON public.page_grants
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_dependents_on_scope_change();
CREATE TRIGGER conversation_office_anchor_withdrawal AFTER UPDATE OF lifecycle_state,default_workspace_role,sensitivity,expires_at OR DELETE ON public.office_artifacts
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_dependents_on_scope_change();
CREATE TRIGGER conversation_office_grant_withdrawal AFTER INSERT OR UPDATE OF role,revoked_at OR DELETE ON public.office_artifact_grants
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_dependents_on_scope_change();
CREATE TRIGGER conversation_office_source_withdrawal AFTER UPDATE OF retracted_at OR DELETE ON public.office_artifact_sources
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_dependents_on_scope_change();
