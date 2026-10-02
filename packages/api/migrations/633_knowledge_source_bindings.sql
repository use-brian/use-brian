BEGIN;

ALTER TABLE workspace_knowledge_sources
  ADD COLUMN sync_run_id uuid,
  ADD COLUMN sync_lease_until timestamptz,
  ADD COLUMN sync_dirty boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT knowledge_sync_lease_complete CHECK ((sync_run_id IS NULL) = (sync_lease_until IS NULL)),
  ADD COLUMN configured_by_user_id uuid REFERENCES users(id),
  ADD COLUMN binding_sensitivity text CHECK(binding_sensitivity IN ('public','internal','confidential')),
  ADD COLUMN binding_compartments text[],
  ADD COLUMN binding_project_ids uuid[],
  ADD COLUMN binding_version bigint NOT NULL DEFAULT 1,
  ADD COLUMN binding_held boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT knowledge_source_binding_complete CHECK (
    (configured_by_user_id IS NULL AND binding_sensitivity IS NULL AND binding_compartments IS NULL AND binding_project_ids IS NULL)
    OR (configured_by_user_id IS NOT NULL AND binding_sensitivity IS NOT NULL AND binding_compartments IS NOT NULL AND binding_project_ids IS NOT NULL));

-- Configuration is immutable. Sync status/probe updates do not mint new worker
-- authority; reconfiguration requires a separately reviewed replacement source.
CREATE FUNCTION guard_knowledge_source_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; ready boolean;
BEGIN
  PERFORM 1 FROM workspaces WHERE id=NEW.workspace_id FOR UPDATE NOWAIT;
  SELECT setup_state<>'legacy' INTO ready FROM workspace_access_policies WHERE workspace_id=NEW.workspace_id;
  IF TG_OP='UPDATE' THEN
    IF OLD.configured_by_user_id IS NOT NULL AND ROW(NEW.workspace_id,NEW.source_type,NEW.repo,NEW.branch,NEW.root_path,NEW.connector_instance_id,
      NEW.configured_by_user_id,NEW.binding_sensitivity,NEW.binding_compartments,NEW.binding_project_ids,NEW.binding_version,NEW.default_sensitivity)
      IS DISTINCT FROM ROW(OLD.workspace_id,OLD.source_type,OLD.repo,OLD.branch,OLD.root_path,OLD.connector_instance_id,
      OLD.configured_by_user_id,OLD.binding_sensitivity,OLD.binding_compartments,OLD.binding_project_ids,OLD.binding_version,OLD.default_sensitivity)
      THEN RAISE EXCEPTION 'knowledge_source_binding_immutable'; END IF;
    IF OLD.configured_by_user_id IS NULL AND NEW.configured_by_user_id IS NOT NULL
      THEN RAISE EXCEPTION 'knowledge_source_binding_immutable'; END IF;
    IF OLD.binding_held AND NOT NEW.binding_held THEN RAISE EXCEPTION 'knowledge_source_binding_held'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.configured_by_user_id IS NULL THEN
    IF ready THEN RAISE EXCEPTION 'knowledge_source_admission_required'; END IF;
    RETURN NEW;
  END IF;
  IF actor IS NULL OR actor IS DISTINCT FROM NEW.configured_by_user_id OR NEW.binding_version<>1 OR NEW.binding_held
    OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=actor)
    OR member_operation_scope_allows(NEW.workspace_id,NEW.binding_sensitivity,NEW.binding_compartments,true) IS NOT TRUE
    OR agent_mutation_scope_allows(NEW.binding_compartments) IS NOT TRUE
    OR agent_read_scope_allows(NEW.binding_sensitivity,NEW.binding_compartments,NEW.binding_project_ids) IS NOT TRUE
    THEN RAISE EXCEPTION 'knowledge_source_configuration_denied'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(NEW.binding_compartments) AS requested(compartment) WHERE NOT EXISTS(
    SELECT 1 FROM workspace_groups g WHERE g.workspace_id=NEW.workspace_id AND g.compartment_key=requested.compartment AND g.kind='team' AND g.status='active'))
    THEN RAISE EXCEPTION 'knowledge_source_configuration_denied'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(NEW.binding_project_ids) pid WHERE NOT EXISTS(
    SELECT 1 FROM workspace_projects p WHERE p.id=pid AND p.workspace_id=NEW.workspace_id AND p.status='active'
      AND (EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=NEW.workspace_id AND m.user_id=actor AND m.role IN ('owner','admin'))
        OR EXISTS(SELECT 1 FROM workspace_project_members m WHERE m.project_id=pid AND m.user_id=actor))))
    THEN RAISE EXCEPTION 'knowledge_source_configuration_denied'; END IF;
  IF NEW.connector_instance_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM connector_instance WHERE id=NEW.connector_instance_id AND workspace_id=NEW.workspace_id)
    THEN RAISE EXCEPTION 'knowledge_source_configuration_denied'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_source_binding_guard BEFORE INSERT OR UPDATE ON workspace_knowledge_sources
  FOR EACH ROW EXECUTE FUNCTION guard_knowledge_source_binding();
REVOKE ALL ON FUNCTION guard_knowledge_source_binding() FROM PUBLIC;

ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check CHECK(source_kind IN (
 'memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','crm_event',
 'memory_verification','brain_verification','correction_audit','session_message','feedback_event','workspace_skill_revision','knowledge_source'));

ALTER FUNCTION read_scope_source(uuid,text,uuid) RENAME TO read_scope_source_before_knowledge_binding;
CREATE FUNCTION read_scope_source(p_workspace uuid,p_kind text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s workspace_knowledge_sources;
BEGIN
 IF p_kind<>'knowledge_source' THEN RETURN read_scope_source_before_knowledge_binding(p_workspace,p_kind,p_id); END IF;
 SELECT * INTO s FROM workspace_knowledge_sources WHERE workspace_id=p_workspace AND id=p_id FOR SHARE;
 IF s.configured_by_user_id IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('workspaceId',p_workspace,'resourceKind',p_kind,'resourceId',p_id,'version',s.binding_version::text,
  'userId',NULL,'assistantId',NULL,'sensitivity',s.binding_sensitivity,'compartments',s.binding_compartments,
  'projectIds',s.binding_project_ids,'held',s.binding_held,'validTo',NULL,'retractedAt',NULL);
END $$;
REVOKE ALL ON FUNCTION read_scope_source(uuid,text,uuid) FROM PUBLIC;

-- Claims are durable fencing tokens. Dirty survives release, errors and expiry;
-- only a successful checkpoint clears it. An abandoned run requires a full walk.
CREATE FUNCTION claim_knowledge_source_sync_worker(w uuid,i uuid,token uuid,expected jsonb) RETURNS SETOF workspace_knowledge_sources
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE s workspace_knowledge_sources; actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 PERFORM 1 FROM workspaces WHERE id=w FOR UPDATE;
 SELECT * INTO s FROM workspace_knowledge_sources WHERE workspace_id=w AND id=i FOR UPDATE;
 IF s.id IS NULL OR s.binding_held OR s.last_synced_sha IS DISTINCT FROM expected->>'lastSyncedSha'
  OR s.binding_version::text IS DISTINCT FROM expected->>'bindingVersion'
  OR s.repo IS DISTINCT FROM expected->>'repo' OR s.branch IS DISTINCT FROM expected->>'branch'
  OR s.root_path IS DISTINCT FROM expected->>'rootPath' OR s.source_type IS DISTINCT FROM expected->>'sourceType'
  OR s.connector_instance_id::text IS DISTINCT FROM expected->>'connectorInstanceId'
  THEN RAISE EXCEPTION 'knowledge_source_changed'; END IF;
 IF s.configured_by_user_id IS NULL THEN
  IF EXISTS(SELECT 1 FROM workspace_access_policies WHERE workspace_id=w AND setup_state<>'legacy')
    THEN RAISE EXCEPTION 'knowledge_source_admission_required'; END IF;
 ELSE
  IF actor IS DISTINCT FROM s.configured_by_user_id OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
    THEN RAISE EXCEPTION 'knowledge_source_changed'; END IF;
 END IF;
 IF s.sync_run_id IS NOT NULL AND s.sync_lease_until>clock_timestamp() THEN RAISE EXCEPTION 'knowledge_sync_in_progress'; END IF;
 UPDATE workspace_knowledge_sources SET sync_run_id=token,sync_lease_until=clock_timestamp()+interval '15 minutes',sync_dirty=true WHERE id=i;
 -- Return the PRE-claim dirty bit, so the worker knows whether reconciliation is required.
 s.sync_run_id:=token; s.sync_lease_until:=clock_timestamp()+interval '15 minutes';
 RETURN NEXT s;
END $$;

CREATE FUNCTION release_knowledge_source_sync_worker(w uuid,i uuid,token uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM workspaces WHERE id=w FOR UPDATE;
 UPDATE workspace_knowledge_sources SET sync_run_id=NULL,sync_lease_until=NULL WHERE workspace_id=w AND id=i AND sync_run_id=token
  AND (configured_by_user_id IS NULL OR configured_by_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid);
END $$;

-- Narrow source-bound writer. Neither a body actor nor a body source ID is an
-- authorization: the caller's frozen, canonical binding must still match and
-- its configured principal must retain current read/addition authority.
CREATE FUNCTION apply_knowledge_source_sync_worker(p jsonb,e jsonb) RETURNS SETOF knowledge_entries
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 s workspace_knowledge_sources; old knowledge_entries; result knowledge_entries; d uuid;
 w uuid:=((p->>'workspaceId'))::uuid; teams text[]; projects uuid[]; additions text[]; tier text;
BEGIN
 PERFORM 1 FROM workspaces WHERE id=w FOR UPDATE;
 SELECT * INTO s FROM workspace_knowledge_sources WHERE workspace_id=w AND id=((p->>'sourceId'))::uuid FOR SHARE;
 IF s.id IS NULL OR s.binding_held
  OR s.sync_run_id IS NULL OR s.sync_run_id::text IS DISTINCT FROM e->>'syncRunId' OR s.sync_lease_until<=clock_timestamp()
  OR s.binding_version::text IS DISTINCT FROM (e->>'bindingVersion')
  OR s.workspace_id::text IS DISTINCT FROM (e->>'workspaceId') OR s.id::text IS DISTINCT FROM (e->>'id')
  OR s.repo IS DISTINCT FROM (e->>'repo') OR s.branch IS DISTINCT FROM (e->>'branch')
  OR s.root_path IS DISTINCT FROM (e->>'rootPath') OR s.source_type IS DISTINCT FROM (e->>'sourceType')
  OR s.connector_instance_id::text IS DISTINCT FROM (e->>'connectorInstanceId')
  OR s.last_synced_sha IS DISTINCT FROM (e->>'lastSyncedSha')
  OR s.binding_sensitivity IS DISTINCT FROM (e->>'bindingSensitivity')
  OR coalesce(to_jsonb(s.binding_compartments),'null'::jsonb) IS DISTINCT FROM (e->'bindingCompartments')
  OR coalesce(to_jsonb(s.binding_project_ids),'null'::jsonb) IS DISTINCT FROM (e->'bindingProjectIds')
  THEN RAISE EXCEPTION 'knowledge_source_changed'; END IF;
 IF entity_derivation_envelope_valid(p || jsonb_build_object('userId',NULL,'assistantId',NULL)) IS NOT TRUE
  OR (p->>'userId') IS NOT NULL OR (p->>'assistantId') IS NOT NULL
  OR coalesce((p->>'sourceSha'),'')='' THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
 IF s.configured_by_user_id IS NULL THEN
  IF EXISTS(SELECT 1 FROM workspace_access_policies WHERE workspace_id=w AND setup_state<>'legacy') THEN RAISE EXCEPTION 'knowledge_source_admission_required'; END IF;
 ELSE
 IF actor IS NULL OR s.configured_by_user_id IS DISTINCT FROM actor OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) THEN RAISE EXCEPTION 'knowledge_source_changed'; END IF;
 IF member_operation_scope_allows(w,s.binding_sensitivity,s.binding_compartments,false) IS NOT TRUE
  OR agent_read_scope_allows(s.binding_sensitivity,s.binding_compartments,s.binding_project_ids) IS NOT TRUE
  OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id')::uuid<>w)
  THEN RAISE EXCEPTION 'scope_operation_denied'; END IF;
 END IF;
 SELECT * INTO old FROM knowledge_entries WHERE workspace_id=w AND path=(p->>'path') FOR UPDATE;
 IF old.id IS NOT NULL AND (old.scope_held OR old.source_id IS DISTINCT FROM s.id)
  THEN RAISE EXCEPTION 'knowledge_source_target_conflict'; END IF;
 teams:=ARRAY(SELECT DISTINCT unnest(coalesce(s.binding_compartments,'{}') || coalesce(old.compartments,'{}') || ARRAY(SELECT jsonb_array_elements_text((p->'compartments')))) ORDER BY 1);
 projects:=ARRAY(SELECT DISTINCT unnest(coalesce(s.binding_project_ids,'{}') || coalesce(old.project_ids,'{}') || ARRAY(SELECT jsonb_array_elements_text((p->'projectIds'))::uuid)) ORDER BY 1);
 SELECT value INTO tier FROM unnest(ARRAY[s.binding_sensitivity,old.sensitivity,(p->>'sensitivity')]) value WHERE value IS NOT NULL ORDER BY sensitivity_rank(value) DESC LIMIT 1;
 additions:=ARRAY(SELECT unnest(teams) EXCEPT SELECT unnest(s.binding_compartments));
 IF s.configured_by_user_id IS NOT NULL AND (member_operation_scope_allows(w,tier,additions,true) IS NOT TRUE OR agent_mutation_scope_allows(additions) IS NOT TRUE
  OR agent_read_scope_allows(tier,teams,projects) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM unnest(projects) AS required(id) WHERE NOT EXISTS(
   SELECT 1 FROM workspace_projects pr WHERE pr.workspace_id=w AND pr.id=required.id AND pr.status='active'
    AND (EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor AND m.role IN('owner','admin'))
     OR EXISTS(SELECT 1 FROM workspace_project_members m WHERE m.project_id=required.id AND m.user_id=actor))))
  ) THEN RAISE EXCEPTION 'scope_operation_denied'; END IF;
 UPDATE workspace_knowledge_sources SET sync_lease_until=clock_timestamp()+interval '15 minutes' WHERE id=s.id;
 IF p->>'operation' = 'delete' THEN
  DELETE FROM knowledge_entries WHERE id=old.id AND source_id=s.id RETURNING * INTO result;
  IF result.id IS NOT NULL THEN RETURN NEXT result; END IF;
  RETURN;
 ELSIF p->>'operation' = 'related' THEN
  IF old.id IS NULL OR old.id::text IS DISTINCT FROM p->>'targetId' THEN RAISE EXCEPTION 'knowledge_source_target_conflict'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'relatedIds') r(id) WHERE NOT EXISTS(
    SELECT 1 FROM knowledge_entries k WHERE k.id=r.id::uuid AND k.workspace_id=w AND NOT k.scope_held
      AND sensitivity_rank(k.sensitivity)<=sensitivity_rank(tier) AND k.compartments <@ teams AND k.project_ids <@ projects))
    THEN RAISE EXCEPTION 'knowledge_source_target_conflict'; END IF;
  UPDATE knowledge_entries SET related_ids=ARRAY(SELECT jsonb_array_elements_text(p->'relatedIds')::uuid) WHERE id=old.id RETURNING * INTO result;
  RETURN NEXT result; RETURN;
 ELSIF p->>'operation' = 'checkpoint' THEN
  UPDATE workspace_knowledge_sources SET last_synced_sha=p->>'sourceSha',last_synced_at=now(),sync_error=NULL,sync_dirty=false,sync_run_id=NULL,sync_lease_until=NULL WHERE id=s.id;
  RETURN;
 ELSIF p->>'operation' = 'error' THEN
  UPDATE workspace_knowledge_sources SET sync_error=p->>'error',last_synced_at=now() WHERE id=s.id;
  RETURN;
 ELSIF p->>'operation' = 'probe' THEN
  UPDATE workspace_knowledge_sources SET write_access=(p->>'writeAccess')::boolean,write_access_checked_at=now() WHERE id=s.id;
  RETURN;
 END IF;
 INSERT INTO knowledge_entries(workspace_id,path,title,summary,content,tags,related_ids,sensitivity,sensitivity_explicit,metadata,source_id,source_sha,compartments,project_ids)
 VALUES(w,(p->>'path'),(p->>'title'),(p->>'summary'),(p->>'content'),ARRAY(SELECT jsonb_array_elements_text((p->'tags'))),
  coalesce(old.related_ids,'{}'),tier,((p->>'sensitivityExplicit'))::boolean,coalesce((p->'metadata'),'{}'),s.id,(p->>'sourceSha'),teams,projects)
 ON CONFLICT(workspace_id,path) DO UPDATE SET title=EXCLUDED.title,summary=EXCLUDED.summary,content=EXCLUDED.content,tags=EXCLUDED.tags,
  sensitivity=EXCLUDED.sensitivity,sensitivity_explicit=EXCLUDED.sensitivity_explicit,metadata=EXCLUDED.metadata,
  source_sha=EXCLUDED.source_sha,compartments=EXCLUDED.compartments,project_ids=EXCLUDED.project_ids
 RETURNING * INTO result;
 IF s.configured_by_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM scope_derivations WHERE workspace_id=w AND resource_kind='knowledge_entry' AND resource_id=result.id AND resource_version=result.scope_version::text) THEN
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
   SELECT w,'knowledge_entry',result.id,result.scope_version::text,'knowledge-source-sync',NULL,NULL,result.sensitivity,result.compartments,result.project_ids,revision
    FROM workspace_access_policies WHERE workspace_id=w RETURNING id INTO d;
  IF d IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
   VALUES(w,d,'knowledge_source',s.id,s.binding_version::text);
 END IF;
 RETURN NEXT result;
END $$;

-- Owner-only SECURITY INVOKER implementations retain the unbound legacy path. The app
-- role cannot enter them directly; SECURITY DEFINER wrappers below admit only
-- a current, actor-bound source. Never infer caller privilege from current_user
-- inside a definer function (it is the function owner).
REVOKE ALL ON FUNCTION claim_knowledge_source_sync_worker(uuid,uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_knowledge_source_sync_worker(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_knowledge_source_sync_worker(jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION assert_bound_knowledge_sync_actor(w uuid,i uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s workspace_knowledge_sources; actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 PERFORM 1 FROM workspaces WHERE id=w FOR UPDATE;
 SELECT * INTO s FROM workspace_knowledge_sources WHERE workspace_id=w AND id=i FOR SHARE;
 IF actor IS NULL OR s.id IS NULL OR s.configured_by_user_id IS NULL OR s.configured_by_user_id IS DISTINCT FROM actor
  OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
  OR member_operation_scope_allows(w,s.binding_sensitivity,s.binding_compartments,false) IS NOT TRUE
  OR agent_read_scope_allows(s.binding_sensitivity,s.binding_compartments,s.binding_project_ids) IS NOT TRUE
  OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id')::uuid<>w)
  OR EXISTS(SELECT 1 FROM unnest(s.binding_project_ids) AS required(id) WHERE NOT EXISTS(
   SELECT 1 FROM workspace_projects pr WHERE pr.workspace_id=w AND pr.id=required.id AND pr.status='active'
    AND (EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor AND m.role IN('owner','admin'))
     OR EXISTS(SELECT 1 FROM workspace_project_members m WHERE m.project_id=required.id AND m.user_id=actor))))
  THEN RAISE EXCEPTION 'knowledge_source_operation_denied' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION assert_bound_knowledge_sync_actor(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION claim_knowledge_source_sync(w uuid,i uuid,token uuid,expected jsonb) RETURNS SETOF workspace_knowledge_sources
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM assert_bound_knowledge_sync_actor(w,i);
 RETURN QUERY SELECT * FROM claim_knowledge_source_sync_worker(w,i,token,expected);
END $$;

CREATE FUNCTION release_knowledge_source_sync(w uuid,i uuid,token uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM assert_bound_knowledge_sync_actor(w,i);
 PERFORM release_knowledge_source_sync_worker(w,i,token);
END $$;

CREATE FUNCTION apply_knowledge_source_sync(p jsonb,e jsonb) RETURNS SETOF knowledge_entries
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM assert_bound_knowledge_sync_actor((p->>'workspaceId')::uuid,(p->>'sourceId')::uuid);
 RETURN QUERY SELECT * FROM apply_knowledge_source_sync_worker(p,e);
END $$;

-- Only the runtime role gets these specific entry points, never PUBLIC.
REVOKE ALL ON FUNCTION claim_knowledge_source_sync(uuid,uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_knowledge_source_sync(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_knowledge_source_sync(jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  -- Also remove any direct privileges inherited from deployment defaults.
  REVOKE ALL ON FUNCTION claim_knowledge_source_sync_worker(uuid,uuid,uuid,jsonb) FROM app_user;
  REVOKE ALL ON FUNCTION release_knowledge_source_sync_worker(uuid,uuid,uuid) FROM app_user;
  REVOKE ALL ON FUNCTION apply_knowledge_source_sync_worker(jsonb,jsonb) FROM app_user;
  REVOKE ALL ON FUNCTION assert_bound_knowledge_sync_actor(uuid,uuid) FROM app_user;
  GRANT EXECUTE ON FUNCTION claim_knowledge_source_sync(uuid,uuid,uuid,jsonb) TO app_user;
  GRANT EXECUTE ON FUNCTION release_knowledge_source_sync(uuid,uuid,uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION apply_knowledge_source_sync(jsonb,jsonb) TO app_user;
 END IF;
END $$;

CREATE FUNCTION hold_knowledge_binding_outputs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM workspaces WHERE id=OLD.workspace_id FOR UPDATE NOWAIT;
 IF TG_OP='DELETE' OR NEW.binding_held IS DISTINCT FROM OLD.binding_held THEN
  UPDATE knowledge_entries SET scope_held=true WHERE workspace_id=OLD.workspace_id AND source_id=OLD.id AND NOT scope_held;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER hold_knowledge_binding_outputs BEFORE DELETE OR UPDATE OF binding_held ON workspace_knowledge_sources
 FOR EACH ROW EXECUTE FUNCTION hold_knowledge_binding_outputs();
REVOKE ALL ON FUNCTION hold_knowledge_binding_outputs() FROM PUBLIC;

COMMIT;
