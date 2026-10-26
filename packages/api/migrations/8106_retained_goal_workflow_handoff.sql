-- Spec: docs/architecture/features/goals.md -> Bounded retained Goal workflow handoff
-- [COMP:api/task-responsibility] Canonical run envelope, no copied authority table.
BEGIN;
CREATE FUNCTION retained_goal_workflow_current(rid uuid,retaining boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r workflow_runs;g goals;w workflows;s goal_task_source_authority;f jsonb;
BEGIN
 SELECT * INTO r FROM workflow_runs WHERE id=rid FOR SHARE;
 IF NOT FOUND OR r.execution_authority->'retainedGoal' IS NULL THEN RETURN false;END IF;
 SELECT * INTO w FROM workflows WHERE id=r.workflow_id AND workspace_id=r.workspace_id FOR SHARE;
 SELECT * INTO g FROM goals WHERE id=r.source_goal_id AND workspace_id=r.workspace_id FOR SHARE;
 SELECT * INTO s FROM goal_task_source_authority WHERE goal_id=g.id;
 f:=r.execution_authority->'retainedGoal';
 IF g.id IS NULL OR w.id IS NULL OR s.proof->'retained' IS NULL
  OR NOT EXISTS(SELECT 1 FROM assistants a WHERE a.id=(s.proof->>'assistantId')::uuid AND a.workspace_id=s.workspace_id AND a.kind='primary')
  OR s.proof#>'{retained,sourceAuthority,nativeCredential}' IS NULL
  OR retained_task_goal_source_current(s.task_id,retaining) IS NOT TRUE
  OR g.updated_at::text IS DISTINCT FROM f->>'goalUpdatedAt'
  OR encode(sha256(convert_to(jsonb_build_object('definition',w.definition,'authority',w.authoring_authority,
    'actor',w.created_by,'group',w.context_group_id,'project',w.context_project_id,'enabled',w.enabled)::text,'UTF8')),'hex') IS DISTINCT FROM f->>'workflowFingerprint'
  OR encode(sha256(convert_to(r.input::text,'UTF8')),'hex') IS DISTINCT FROM f->>'inputFingerprint'
  OR r.triggered_by IS DISTINCT FROM g.created_by_user_id OR r.workflow_id::text IS DISTINCT FROM g.means->>'workflowId'
  OR r.execution_authority->'sourceGoal' IS DISTINCT FROM jsonb_build_object('id',g.id,'contextGroupId',g.context_group_id,
    'contextProjectId',g.context_project_id,'authoringAuthority',g.authoring_authority)
  OR r.execution_authority->'workflowAuthoringAuthority' IS DISTINCT FROM w.authoring_authority
  OR r.execution_authority->'ceiling' IS DISTINCT FROM s.proof->'authority'->'ceiling'
  OR r.execution_authority->>'assistantId' IS DISTINCT FROM s.proof->>'assistantId'
  OR NOT w.enabled OR g.confirmed_at IS NULL OR g.status NOT IN('active','running')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.proof->'retained'->'sources') x WHERE x->>'resourceKind'='external_source')
  OR EXISTS(SELECT 1 FROM application_scope_lineage(s.workspace_id,
    ARRAY(SELECT x->>'resourceKind' FROM jsonb_array_elements(s.proof->'retained'->'sources') x),
    ARRAY(SELECT (x->>'resourceId')::uuid FROM jsonb_array_elements(s.proof->'retained'->'sources') x),
    ARRAY(SELECT x->>'version' FROM jsonb_array_elements(s.proof->'retained'->'sources') x)) node WHERE node.kind='external_source')
 THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION retained_goal_workflow_current(uuid,boolean) FROM PUBLIC;

CREATE FUNCTION bind_retained_goal_workflow_run(rid uuid,gid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r workflow_runs;g goals;w workflows;s goal_task_source_authority;expected jsonb;fingerprint text;fresh_xmin bigint;
BEGIN
 SELECT * INTO g FROM goals WHERE id=gid FOR UPDATE;
 SELECT * INTO s FROM goal_task_source_authority WHERE goal_id=gid;
 SELECT * INTO r FROM workflow_runs WHERE id=rid FOR UPDATE;
 SELECT xmin::text::bigint INTO fresh_xmin FROM workflow_runs WHERE id=rid;
 SELECT * INTO w FROM workflows WHERE id=r.workflow_id AND workspace_id=g.workspace_id FOR SHARE;
 IF g.id IS NULL OR s.proof->'retained' IS NULL OR r.id IS NULL OR w.id IS NULL
  OR fresh_xmin IS DISTINCT FROM (pg_current_xact_id()::text::numeric%4294967296)::bigint
  OR r.source_goal_id IS DISTINCT FROM gid OR r.execution_authority IS NOT NULL OR r.status<>'pending'
  OR r.vars<>'{}'::jsonb OR r.current_step_id IS NOT NULL
  OR EXISTS(SELECT 1 FROM workflow_step_runs WHERE run_id=rid)
  OR EXISTS(SELECT 1 FROM workflow_runs prior WHERE prior.source_goal_id=gid AND prior.id<>rid)
  OR g.confirmed_at IS NULL OR g.status<>'active' OR g.means->>'workflowId' IS DISTINCT FROM w.id::text
  OR r.triggered_by IS DISTINCT FROM g.created_by_user_id OR w.created_by IS DISTINCT FROM g.created_by_user_id
  OR w.authoring_authority IS NULL OR NOT w.enabled
  OR w.context_group_id IS DISTINCT FROM g.context_group_id OR w.context_project_id IS DISTINCT FROM g.context_project_id
  OR w.definition ?| ARRAY['principal','failureDelivery','taskIntake']
  OR jsonb_typeof(w.definition->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(w.definition->'steps')=0
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(w.definition->'steps') step WHERE jsonb_typeof(step) IS DISTINCT FROM 'object'
    OR jsonb_typeof(step->'type') IS DISTINCT FROM 'string' OR coalesce(step->>'type','') NOT IN('wait','branch') OR step ? 'deliver'
    OR step->>'type'='wait' AND (step ? 'until' OR jsonb_typeof(step->'at') IS DISTINCT FROM 'object'
      OR jsonb_typeof(step#>'{at,datetime}') IS DISTINCT FROM 'string' OR coalesce(step#>>'{at,timezone}','UTC')<>'UTC'))
  OR NOT EXISTS(SELECT 1 FROM assistants a WHERE a.id=(s.proof->>'assistantId')::uuid AND a.workspace_id=s.workspace_id AND a.kind='primary')
  OR s.proof#>'{retained,sourceAuthority,nativeCredential}' IS NULL
  OR retained_task_goal_source_current(s.task_id,true) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.proof->'retained'->'sources') x WHERE x->>'resourceKind'='external_source')
  OR EXISTS(SELECT 1 FROM application_scope_lineage(s.workspace_id,
    ARRAY(SELECT x->>'resourceKind' FROM jsonb_array_elements(s.proof->'retained'->'sources') x),
    ARRAY(SELECT (x->>'resourceId')::uuid FROM jsonb_array_elements(s.proof->'retained'->'sources') x),
    ARRAY(SELECT x->>'version' FROM jsonb_array_elements(s.proof->'retained'->'sources') x)) node WHERE node.kind='external_source')
 THEN RAISE EXCEPTION 'goal_source_scope_unavailable' USING ERRCODE='42501';END IF;
 expected:=jsonb_build_object('goalId',g.id,'goalOutcome',g.outcome,'taskTitle',(s.proof->>'snapshot')::jsonb->'title');
 IF g.brief->>'verification' IS NOT NULL THEN expected:=expected||jsonb_build_object('goalVerification',g.brief->>'verification');END IF;
 IF g.brief->>'approach' IS NOT NULL THEN expected:=expected||jsonb_build_object('goalApproach',g.brief->>'approach');END IF;
 IF r.input IS DISTINCT FROM expected THEN RAISE EXCEPTION 'goal_source_scope_unavailable' USING ERRCODE='42501';END IF;
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('definition',w.definition,'authority',w.authoring_authority,
   'actor',w.created_by,'group',w.context_group_id,'project',w.context_project_id,'enabled',w.enabled)::text,'UTF8')),'hex');
 UPDATE workflow_runs SET execution_authority=jsonb_build_object('version',1,'assistantId',s.proof->>'assistantId',
  'ceiling',s.proof->'authority'->'ceiling','workflowAuthoringAuthority',w.authoring_authority,
  'sourceGoal',jsonb_build_object('id',g.id,'contextGroupId',g.context_group_id,'contextProjectId',g.context_project_id,'authoringAuthority',g.authoring_authority),
  'retainedGoal',jsonb_build_object('goalUpdatedAt',g.updated_at::text,'workflowFingerprint',fingerprint,
    'inputFingerprint',encode(sha256(convert_to(r.input::text,'UTF8')),'hex'))) WHERE id=rid;
 UPDATE workflow_runs SET vars=jsonb_build_object('__contextScopeEvidence',jsonb_build_object(
  'sensitivity',CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(s.proof->'retained'->'sources') x WHERE x->>'sensitivity'='confidential') THEN 'confidential'
    WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(s.proof->'retained'->'sources') x WHERE x->>'sensitivity'='internal') THEN 'internal' ELSE 'public' END,
  'compartments',coalesce((SELECT jsonb_agg(label ORDER BY label) FROM (SELECT DISTINCT jsonb_array_elements_text(x->'compartments') AS label FROM jsonb_array_elements(s.proof->'retained'->'sources') x) labels),'[]'::jsonb),
  'projectIds',coalesce((SELECT jsonb_agg(label ORDER BY label) FROM (SELECT DISTINCT jsonb_array_elements_text(x->'projectIds') AS label FROM jsonb_array_elements(s.proof->'retained'->'sources') x) labels),'[]'::jsonb),
  'sources',s.proof->'retained'->'sources')),claimed_at=clock_timestamp(),claim_attempts=claim_attempts+1 WHERE id=rid;
 IF retained_goal_workflow_current(rid,true) IS NOT TRUE THEN RAISE EXCEPTION 'goal_source_scope_unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION bind_retained_goal_workflow_run(uuid,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION bind_retained_goal_workflow_run(uuid,uuid),retained_goal_workflow_current(uuid,boolean) TO app_user;
END IF;END $$;
COMMIT;
