-- Trusted execution persistence. No command is granted to app_user: the server
-- constructs previews/results and calls these on its owner connection. A GUC is
-- actor context, NEVER a system capability. SELECT remains canonical RLS-bound.
BEGIN;
ALTER TABLE public.project_harness_revisions ADD CONSTRAINT harness_revision_identity UNIQUE(workspace_id,project_id,id);
CREATE TABLE public.project_harness_approvals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL,
 revision_id uuid NOT NULL, approved_by uuid NOT NULL, auth_session_id uuid NOT NULL,
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(), reason text NOT NULL CHECK(public.project_harness_text(to_jsonb(reason),1,1000)),
 FOREIGN KEY(workspace_id,project_id,revision_id) REFERENCES public.project_harness_revisions(workspace_id,project_id,id) ON DELETE CASCADE,
 UNIQUE(workspace_id,project_id,revision_id,id), UNIQUE(workspace_id,project_id,id)
);
CREATE TABLE public.project_harness_runs (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, project_id uuid NOT NULL, revision_id uuid NOT NULL, approval_id uuid NOT NULL,
 requested_by uuid NOT NULL, auth_session_id uuid NOT NULL, executor text NOT NULL CHECK(executor IN ('human','agent')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','passed','failed','blocked','inconclusive','cancelled','expired')),
 preview jsonb NOT NULL, result jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), started_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 minutes', completed_at timestamptz,
 FOREIGN KEY(workspace_id,project_id,revision_id,approval_id) REFERENCES public.project_harness_approvals(workspace_id,project_id,revision_id,id) ON DELETE CASCADE,
 UNIQUE(workspace_id,project_id,id), CHECK(expires_at>created_at),
 CHECK((status IN ('pending','running'))=(completed_at IS NULL)),
 CHECK((status IN ('passed','failed','blocked','inconclusive'))=(result IS NOT NULL))
);
CREATE TABLE public.project_harness_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL,
 criterion_key text NOT NULL CHECK(criterion_key ~ '^[a-z][a-z0-9._-]{0,99}$'),
 kind text NOT NULL, provenance text NOT NULL, text text, content_type text, base64 text,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(workspace_id,project_id,run_id) REFERENCES public.project_harness_runs(workspace_id,project_id,id) ON DELETE CASCADE,
 CHECK((kind='observation' AND provenance='human_reported' AND public.project_harness_text(to_jsonb(text),1,8000) AND content_type IS NULL AND base64 IS NULL)
 OR (kind='screenshot' AND provenance='isolated_browser' AND text IS NULL AND content_type='image/png' AND base64 IS NOT NULL AND length(base64) BETWEEN 44 AND 2796204))
);
CREATE TABLE public.project_harness_execution_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL,
 run_id uuid, approval_id uuid, actor_id uuid NOT NULL, event text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(workspace_id,project_id,run_id) REFERENCES public.project_harness_runs(workspace_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,project_id,approval_id) REFERENCES public.project_harness_approvals(workspace_id,project_id,id) ON DELETE CASCADE
);
CREATE INDEX harness_runs_scope ON public.project_harness_runs(workspace_id,project_id,created_at DESC);
CREATE INDEX harness_evidence_run ON public.project_harness_evidence(run_id);
CREATE INDEX harness_approvals_revision ON public.project_harness_approvals(revision_id);

CREATE FUNCTION public.harness_execution_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 -- Only complete workspace teardown may erase history, matching 8269. Neither
 -- deleting a Project nor deleting an account/session rewrites attribution.
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=OLD.workspace_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'harness_history_immutable';
END $$;
CREATE TRIGGER harness_approval_immutable BEFORE UPDATE OR DELETE ON public.project_harness_approvals FOR EACH ROW EXECUTE FUNCTION public.harness_execution_immutable();
CREATE TRIGGER harness_evidence_immutable BEFORE UPDATE OR DELETE ON public.project_harness_evidence FOR EACH ROW EXECUTE FUNCTION public.harness_execution_immutable();
CREATE TRIGGER harness_audit_immutable BEFORE UPDATE OR DELETE ON public.project_harness_execution_audit FOR EACH ROW EXECUTE FUNCTION public.harness_execution_immutable();
CREATE FUNCTION public.harness_execution_run_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=OLD.workspace_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'harness_history_immutable';
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','started_at','completed_at','result']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','started_at','completed_at','result'])
 OR OLD.status NOT IN ('pending','running') OR NEW.status=OLD.status
 OR (OLD.status='pending' AND NEW.status NOT IN ('running','cancelled','expired'))
 OR (OLD.status='running' AND NEW.status NOT IN ('passed','failed','blocked','inconclusive','cancelled','expired'))
 OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
 OR (NEW.status='running' AND NEW.started_at IS NULL)
 OR (NEW.status NOT IN ('expired','cancelled') AND OLD.expires_at<=clock_timestamp())
 THEN RAISE EXCEPTION 'harness_run_conflict'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER harness_run_guard BEFORE UPDATE OR DELETE ON public.project_harness_runs FOR EACH ROW EXECUTE FUNCTION public.harness_execution_run_guard();
CREATE FUNCTION public.harness_execution_audit_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO public.project_harness_execution_audit(workspace_id,project_id,run_id,actor_id,event)
 VALUES(NEW.workspace_id,NEW.project_id,NEW.id,NEW.requested_by,NEW.status);
 RETURN NEW;
END $$;
CREATE TRIGGER harness_run_audit AFTER INSERT OR UPDATE ON public.project_harness_runs FOR EACH ROW EXECUTE FUNCTION public.harness_execution_audit_run();

CREATE FUNCTION public.harness_execution_human(actor uuid, session_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF actor IS NULL OR session_id IS NULL OR nullif(current_setting('app.v2_assistant_id',true),'') IS NOT NULL
 OR nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL THEN RAISE EXCEPTION 'harness_human_required'; END IF;
 PERFORM 1 FROM public.auth_sessions s JOIN public.users u ON u.id=s.user_id
 WHERE s.id=session_id AND s.user_id=actor FOR SHARE OF s,u;
 IF NOT FOUND THEN RAISE EXCEPTION 'harness_human_required'; END IF;
 -- Evaluate freshness AFTER acquiring both row locks: a predicate evaluated
 -- before a lock wait cannot establish that the session is still live now.
 IF NOT EXISTS(SELECT 1 FROM public.auth_sessions s JOIN public.users u ON u.id=s.user_id
   WHERE s.id=session_id AND s.user_id=actor AND s.auth_version=u.auth_version
     AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'harness_human_required'; END IF;
END $$;
-- Lock the same ancestor order as 8269 before examining the head. Membership
-- locks serialize removals/updates; check wall-clock expiry after lock waits.
CREATE FUNCTION public.harness_execution_authority(w uuid,p uuid,rid uuid,reviewer uuid DEFAULT NULL) RETURNS public.project_harness_revisions
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public.project_harness_revisions; actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 PERFORM 1 FROM public.workspaces WHERE id=w FOR UPDATE;
 PERFORM 1 FROM public.project_shared_scopes WHERE workspace_id=w AND project_id=p FOR UPDATE;
 PERFORM 1 FROM public.workspace_projects WHERE workspace_id=w AND id=p FOR UPDATE;
 SELECT * INTO r FROM public.project_harness_revisions WHERE workspace_id=w AND project_id=p AND id=rid;
 IF NOT FOUND THEN RAISE EXCEPTION 'harness_not_found'; END IF;
 PERFORM public.project_harness_require(w,p,r.product_id,r.component_id,false);
 PERFORM 1 FROM public.workspace_members WHERE workspace_id=w AND user_id IN (actor,reviewer) FOR SHARE;
 PERFORM 1 FROM public.project_shared_members WHERE project_id=p AND user_id IN (actor,reviewer) FOR SHARE;
 PERFORM 1 FROM public.project_shared_owners WHERE workspace_id=w AND project_id=p AND user_id=reviewer FOR SHARE;
 PERFORM 1 FROM public.department_edges WHERE workspace_id=w AND user_id IN (actor,reviewer) FOR SHARE;
 PERFORM 1 FROM public.project_harness_products WHERE id=r.product_id FOR UPDATE;
 PERFORM 1 FROM public.project_harness_components WHERE id=r.component_id FOR UPDATE;
 IF NOT public.project_harness_visible(w,p,true) OR NOT public.project_member_live(p,'user',actor)
 OR EXISTS(SELECT 1 FROM public.project_shared_members WHERE project_id=p AND user_id=actor AND expires_at<=clock_timestamp())
 OR EXISTS(SELECT 1 FROM public.department_edges WHERE workspace_id=w AND user_id IN (actor,reviewer) AND expires_at>transaction_timestamp() AND expires_at<=clock_timestamp())
 THEN RAISE EXCEPTION 'harness_participant_required'; END IF;
 IF reviewer IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=w AND user_id=reviewer)
 OR NOT EXISTS(SELECT 1 FROM public.project_shared_owners WHERE workspace_id=w AND project_id=p AND user_id=reviewer)
 OR NOT public.project_member_live(p,'user',reviewer)
 -- Principal-specific canonical grants preserve the requester's actor context;
 -- Project ownership alone must not bypass the reviewer's current tier/floor.
 OR NOT public.department_row_allows(public.department_principal_grant_snapshot(reviewer),w,'internal',ARRAY['project:'||p::text],NULL::uuid)
 OR NOT public.member_operation_row_allows(public.member_principal_operation_grants(reviewer,true,w),w,'internal',ARRAY['project:'||p::text])
 OR EXISTS(SELECT 1 FROM public.project_shared_members WHERE project_id=p AND user_id=reviewer AND expires_at<=clock_timestamp())) THEN RAISE EXCEPTION 'harness_owner_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.workspace_projects WHERE workspace_id=w AND id=p AND status='active')
 OR EXISTS(SELECT 1 FROM public.project_harness_products WHERE id=r.product_id AND status<>'active')
 OR EXISTS(SELECT 1 FROM public.project_harness_components WHERE id=r.component_id AND status<>'active') THEN RAISE EXCEPTION 'harness_archived'; END IF;
 IF EXISTS(SELECT 1 FROM public.project_harness_revisions WHERE workspace_id=w AND project_id=p AND scope_id=r.scope_id AND revision>r.revision) THEN RAISE EXCEPTION 'harness_revision_stale'; END IF;
 RETURN r;
END $$;

CREATE FUNCTION public.harness_execution_approve(w uuid,p uuid,rid uuid,sid uuid,expected bigint,why text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; r public.project_harness_revisions; a public.project_harness_approvals;
BEGIN
 r:=public.harness_execution_authority(w,p,rid,actor);
 PERFORM public.harness_execution_human(actor,sid);
 IF r.created_by IS NOT DISTINCT FROM actor THEN RAISE EXCEPTION 'harness_independent_reviewer_required'; END IF;
 IF r.revision IS DISTINCT FROM expected THEN RAISE EXCEPTION 'harness_revision_stale'; END IF;
 INSERT INTO public.project_harness_approvals(workspace_id,project_id,revision_id,approved_by,auth_session_id,reason)
 VALUES(w,p,rid,actor,sid,why) RETURNING * INTO a;
 INSERT INTO public.project_harness_execution_audit(workspace_id,project_id,approval_id,actor_id,event) VALUES(w,p,a.id,actor,'approved');
 RETURN to_jsonb(a);
END $$;

-- Server-only: preview is produced by buildVerificationPreview, not accepted
-- from HTTP. SQL additionally pins the selected scenario and composite identity.
CREATE FUNCTION public.harness_execution_create(w uuid,p uuid,aid uuid,sid uuid,rid uuid,executor_kind text,packet jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; a public.project_harness_approvals; r public.project_harness_revisions; result jsonb;
BEGIN
 SELECT * INTO a FROM public.project_harness_approvals WHERE workspace_id=w AND project_id=p AND id=aid;
 IF NOT FOUND THEN RAISE EXCEPTION 'harness_not_found'; END IF;
 r:=public.harness_execution_authority(w,p,a.revision_id,a.approved_by);
 PERFORM public.harness_execution_human(actor,sid);
 IF packet->>'runId' IS DISTINCT FROM rid::text OR packet#>>'{specification,revisionId}' IS DISTINCT FROM r.id::text
 OR packet#>>'{specification,workspaceId}' IS DISTINCT FROM w::text OR packet#>>'{specification,projectId}' IS DISTINCT FROM p::text
 OR packet#>>'{specification,revision}' IS DISTINCT FROM r.revision::text
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.definition->'acceptanceScenarios') s WHERE s=packet->'scenario') THEN RAISE EXCEPTION 'harness_invalid_input'; END IF;
 INSERT INTO public.project_harness_runs(id,workspace_id,project_id,revision_id,approval_id,requested_by,auth_session_id,executor,preview)
 VALUES(rid,w,p,r.id,aid,actor,sid,executor_kind,packet) RETURNING to_jsonb(project_harness_runs) INTO result;
 RETURN result;
END $$;

CREATE FUNCTION public.harness_execution_expire(w uuid,p uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.project_harness_require(w,p,NULL,NULL,false);
 UPDATE public.project_harness_runs SET status='expired',completed_at=clock_timestamp() WHERE workspace_id=w AND project_id=p AND status IN ('pending','running') AND expires_at<=clock_timestamp();
END $$;
-- Result validation is duplicated at the authority boundary: stored evidence,
-- exact criteria and packet identity cannot be replaced by opaque references.
CREATE FUNCTION public.harness_execution_result_valid(r public.project_harness_runs, body jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c jsonb; e jsonb; ref jsonb; required text[]; seen text[]:='{}'; ids text[]:='{}'; used text[]:='{}'; statuses text[]:='{}'; overall text;
BEGIN
 IF body IS NULL OR jsonb_typeof(body)<>'object' OR body-ARRAY['binding','status','criteria','evidence']<>'{}'::jsonb
 OR body->'binding' IS DISTINCT FROM jsonb_build_object('runId',r.id,'packetSha256',r.preview->'packetSha256','specification',r.preview->'specification','build',r.preview->'build','scenarioKey',r.preview#>'{scenario,key}')
 OR jsonb_typeof(body->'criteria') IS DISTINCT FROM 'array' OR jsonb_typeof(body->'evidence') IS DISTINCT FROM 'array'
 OR jsonb_array_length(body->'criteria') NOT BETWEEN 1 AND 50 OR jsonb_array_length(body->'evidence')>500 THEN RETURN false; END IF;
 SELECT array_agg(value->>'key') INTO required FROM jsonb_array_elements(r.preview#>'{scenario,criteria}');
 FOR e IN SELECT value FROM jsonb_array_elements(body->'evidence') LOOP
  IF e-ARRAY['id','criterionKey','kind','reference']<>'{}'::jsonb OR e->>'id'=ANY(ids)
   OR e->>'reference' IS DISTINCT FROM e->>'id' OR NOT EXISTS(SELECT 1 FROM public.project_harness_evidence x WHERE x.run_id=r.id AND x.id::text=e->>'id' AND x.criterion_key=e->>'criterionKey' AND x.kind=e->>'kind') THEN RETURN false; END IF;
  ids:=array_append(ids,e->>'id');
 END LOOP;
 FOR c IN SELECT value FROM jsonb_array_elements(body->'criteria') LOOP
  IF c-ARRAY['criterionKey','status','evidenceIds','reason']<>'{}'::jsonb OR coalesce(c->>'criterionKey','')<>ALL(required)
   OR c->>'criterionKey'=ANY(seen) OR coalesce(c->>'status','') NOT IN ('passed','failed','blocked','inconclusive')
   OR jsonb_typeof(c->'evidenceIds') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'evidenceIds')>100
   OR (c->>'status'='passed' AND jsonb_array_length(c->'evidenceIds')=0)
   OR (c->>'status'<>'passed' AND NOT public.project_harness_text(c->'reason',1,4000)) THEN RETURN false; END IF;
  seen:=array_append(seen,c->>'criterionKey'); statuses:=array_append(statuses,c->>'status');
  FOR ref IN SELECT value FROM jsonb_array_elements(c->'evidenceIds') LOOP
   IF jsonb_typeof(ref)<>'string' OR ref#>>'{}'=ANY(used) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(body->'evidence') x WHERE x->>'id'=ref#>>'{}' AND x->>'criterionKey'=c->>'criterionKey') THEN RETURN false; END IF;
   used:=array_append(used,ref#>>'{}');
  END LOOP;
 END LOOP;
 overall:=CASE WHEN 'failed'=ANY(statuses) THEN 'failed' WHEN 'blocked'=ANY(statuses) THEN 'blocked' WHEN 'inconclusive'=ANY(statuses) THEN 'inconclusive' ELSE 'passed' END;
 RETURN coalesce(cardinality(seen)=cardinality(required) AND cardinality(used)=cardinality(ids) AND body->>'status'=overall,false);
END $$;

CREATE FUNCTION public.harness_execution_action(w uuid,p uuid,rid uuid,sid uuid,action text,body jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; r public.project_harness_runs; a public.project_harness_approvals; result jsonb; bytes bytea;
BEGIN
 -- Same lock ordering as create/approve/definition writes, then per-run CAS.
 PERFORM 1 FROM public.workspaces WHERE id=w FOR UPDATE;
 PERFORM 1 FROM public.project_shared_scopes WHERE workspace_id=w AND project_id=p FOR UPDATE;
 PERFORM 1 FROM public.workspace_projects WHERE workspace_id=w AND id=p FOR UPDATE;
 SELECT * INTO r FROM public.project_harness_runs WHERE workspace_id=w AND project_id=p AND id=rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'harness_not_found'; END IF;
 PERFORM public.project_harness_require(w,p,NULL,NULL,false);
 IF r.requested_by IS DISTINCT FROM actor THEN RAISE EXCEPTION 'harness_requester_required'; END IF;
 PERFORM public.harness_execution_human(actor,r.auth_session_id);
 IF action NOT IN ('claim_agent','authorize_agent','evidence_agent','complete_agent') AND sid IS DISTINCT FROM r.auth_session_id THEN RAISE EXCEPTION 'harness_human_required'; END IF;
 IF r.status NOT IN ('pending','running') OR r.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'harness_run_conflict'; END IF;
 IF action='cancel' THEN
  UPDATE public.project_harness_runs SET status='cancelled',completed_at=clock_timestamp() WHERE id=rid RETURNING to_jsonb(project_harness_runs) INTO result;
  RETURN result;
 END IF;
 SELECT * INTO a FROM public.project_harness_approvals WHERE id=r.approval_id;
 PERFORM public.harness_execution_authority(w,p,r.revision_id,a.approved_by);
 -- Authority may wait on membership/ancestor locks. Re-evaluate session and
 -- run clocks only after all those waits, including the no-write authorize path.
 PERFORM public.harness_execution_human(actor,r.auth_session_id);
 IF r.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'harness_run_conflict'; END IF;
 IF (action LIKE '%_agent' AND r.executor<>'agent') OR (action LIKE '%_human' AND r.executor<>'human') THEN RAISE EXCEPTION 'harness_run_conflict'; END IF;
 IF action='claim_agent' THEN
  IF r.status<>'pending' THEN RAISE EXCEPTION 'harness_run_conflict'; END IF;
  UPDATE public.project_harness_runs SET status='running',started_at=clock_timestamp() WHERE id=rid RETURNING to_jsonb(project_harness_runs) INTO result;
  RETURN result;
 END IF;
 IF action LIKE '%_human' AND r.status='pending' THEN
  UPDATE public.project_harness_runs SET status='running',started_at=clock_timestamp() WHERE id=rid RETURNING * INTO r;
 END IF;
 IF r.status<>'running' THEN RAISE EXCEPTION 'harness_run_conflict'; END IF;
 IF action='authorize_agent' THEN RETURN to_jsonb(r); END IF;
 IF action IN ('evidence_agent','evidence_human') THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.preview#>'{scenario,criteria}') c WHERE c->>'key'=body->>'criterionKey') THEN RAISE EXCEPTION 'harness_invalid_input'; END IF;
  IF action='evidence_agent' THEN
   IF body-ARRAY['criterionKey','base64']<>'{}'::jsonb OR coalesce(length(body->>'base64'),0) NOT BETWEEN 44 AND 2796204
     OR body->>'base64' !~ '^[A-Za-z0-9+/]+={0,2}$' THEN RAISE EXCEPTION 'harness_invalid_input'; END IF;
   bytes:=decode(body->>'base64','base64');
   IF octet_length(bytes) NOT BETWEEN 33 AND 2097152 OR replace(encode(bytes,'base64'),chr(10),'') IS DISTINCT FROM body->>'base64'
    OR substring(bytes FROM 1 FOR 8)<>decode('89504e470d0a1a0a','hex')
    OR substring(bytes FROM 9 FOR 8)<>decode('0000000d49484452','hex') THEN RAISE EXCEPTION 'harness_invalid_input'; END IF;
   INSERT INTO public.project_harness_evidence(workspace_id,project_id,run_id,criterion_key,kind,provenance,content_type,base64,sha256)
    VALUES(w,p,rid,body->>'criterionKey','screenshot','isolated_browser','image/png',body->>'base64',encode(sha256(bytes),'hex')) RETURNING to_jsonb(project_harness_evidence) INTO result;
  ELSE
   IF body-ARRAY['criterionKey','text']<>'{}'::jsonb THEN RAISE EXCEPTION 'harness_invalid_input'; END IF;
   INSERT INTO public.project_harness_evidence(workspace_id,project_id,run_id,criterion_key,kind,provenance,text,sha256)
    VALUES(w,p,rid,body->>'criterionKey','observation','human_reported',body->>'text',encode(sha256(convert_to(body->>'text','UTF8')),'hex')) RETURNING to_jsonb(project_harness_evidence) INTO result;
  END IF;
  INSERT INTO public.project_harness_execution_audit(workspace_id,project_id,run_id,actor_id,event) VALUES(w,p,rid,actor,action);
  RETURN result;
 ELSIF action IN ('complete_agent','complete_human') THEN
  IF NOT public.harness_execution_result_valid(r,body) THEN RAISE EXCEPTION 'harness_invalid_input'; END IF;
  UPDATE public.project_harness_runs SET status=body->>'status',result=body,completed_at=clock_timestamp() WHERE id=rid RETURNING to_jsonb(project_harness_runs) INTO result;
  RETURN result;
 END IF;
 RAISE EXCEPTION 'harness_invalid_input';
END $$;

-- Ordinary owner migration and boot: no superuser roles/extensions required.
DO $$ DECLARE t text; fn record; BEGIN
 FOREACH t IN ARRAY ARRAY['project_harness_approvals','project_harness_runs','project_harness_evidence','project_harness_execution_audit'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY harness_execution_read ON public.%I FOR SELECT USING(public.project_harness_visible(workspace_id,project_id))',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
   EXECUTE format('REVOKE ALL ON public.%I FROM app_user',t);
   EXECUTE format('GRANT SELECT ON public.%I TO app_user',t);
  END IF;
 END LOOP;
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'harness_execution_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM app_user',fn.signature); END IF;
 END LOOP;
END $$;
COMMIT;
