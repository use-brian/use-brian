-- [COMP:crm/r2-store] Statement-local CRM authority and write-owned freshness.
BEGIN;

-- A subject revision records a write, never an admission decision. Subject
-- rows are created only by actual writes, so an upgrade needs no actor fan-out.
CREATE TABLE public.crm_summary_principal_revisions (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  fact text NOT NULL CHECK (fact IN ('workspace','member','legacy','legacy_member','department','assistant','project','project_member')),
  subject_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision>0),
  PRIMARY KEY (workspace_id,fact,subject_id)
);
ALTER TABLE public.crm_summary_principal_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_summary_principal_revisions FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_principal_revision_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb;
DECLARE after_row jsonb;
DECLARE workspace_before uuid;
DECLARE workspace_after uuid;
DECLARE subject_before uuid;
DECLARE subject_after uuid;
DECLARE axis text:=TG_ARGV[0];
DECLARE nil constant uuid:='00000000-0000-0000-0000-000000000000';
BEGIN
  IF TG_OP<>'INSERT' THEN before_row:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN after_row:=to_jsonb(NEW); END IF;
  IF TG_OP='UPDATE' AND NOT EXISTS (
    SELECT 1 FROM unnest(TG_ARGV[3:]) AS field
    WHERE before_row->field IS DISTINCT FROM after_row->field
  ) THEN RETURN NULL; END IF;
  IF TG_ARGV[1]='group' THEN
    SELECT workspace_id INTO workspace_before FROM public.workspace_groups WHERE id=(before_row->>'group_id')::uuid;
    SELECT workspace_id INTO workspace_after FROM public.workspace_groups WHERE id=(after_row->>'group_id')::uuid;
    -- A deleted parent advances the workspace's legacy journal itself.
  ELSE
    workspace_before:=(before_row->>TG_ARGV[1])::uuid;
    workspace_after:=(after_row->>TG_ARGV[1])::uuid;
  END IF;
  IF axis='legacy_grant' THEN
    INSERT INTO public.crm_summary_principal_revisions AS r(workspace_id,fact,subject_id,revision)
    SELECT w.id,input.fact,input.subject,nextval('public.application_policy_revision_seq') FROM (
      SELECT DISTINCT workspace,
        CASE WHEN value->>'beneficiary_kind'='member' THEN 'legacy_member' ELSE 'legacy' END AS fact,
        CASE WHEN value->>'beneficiary_kind'='member' THEN (value->>'beneficiary_id')::uuid ELSE nil END AS subject
      FROM (VALUES (workspace_before,before_row),(workspace_after,after_row)) v(workspace,value)
      WHERE workspace IS NOT NULL
    ) input JOIN public.workspaces w ON w.id=input.workspace
    ORDER BY w.id,input.fact,input.subject
    ON CONFLICT(workspace_id,fact,subject_id) DO UPDATE SET revision=nextval('public.application_policy_revision_seq');
    RETURN NULL;
  END IF;
  subject_before:=coalesce((before_row->>TG_ARGV[2])::uuid,
    CASE WHEN TG_ARGV[2]='user_id' THEN (before_row->>'assistant_id')::uuid END,nil);
  subject_after:=coalesce((after_row->>TG_ARGV[2])::uuid,
    CASE WHEN TG_ARGV[2]='user_id' THEN (after_row->>'assistant_id')::uuid END,nil);
  INSERT INTO public.crm_summary_principal_revisions AS r(workspace_id,fact,subject_id,revision)
  SELECT w.id,axis,input.subject,nextval('public.application_policy_revision_seq') FROM (
    SELECT DISTINCT workspace,subject FROM (VALUES (workspace_before,subject_before),(workspace_after,subject_after)) v(workspace,subject)
  ) input JOIN public.workspaces w ON w.id=input.workspace
  ORDER BY w.id,input.subject
  ON CONFLICT(workspace_id,fact,subject_id) DO UPDATE SET revision=nextval('public.application_policy_revision_seq');
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_principal_revision_write() FROM PUBLIC,app_user;

CREATE TRIGGER crm_summary_principal_workspace AFTER UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_principal_revision_write('workspace','id','','id','department_read_v2','project_shared_spaces');
CREATE TRIGGER crm_summary_principal_member AFTER INSERT OR UPDATE OR DELETE ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_principal_revision_write('member','workspace_id','user_id','workspace_id','user_id','role','clearance','team_scope_mode','compartments');
CREATE TRIGGER crm_summary_principal_group AFTER INSERT OR UPDATE OR DELETE ON public.workspace_groups
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_principal_revision_write('legacy','workspace_id','','workspace_id','id','status','kind','read_all','compartment_key');
CREATE TRIGGER crm_summary_principal_group_member AFTER INSERT OR UPDATE OR DELETE ON public.workspace_group_members
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_principal_revision_write('legacy_member','group','user_id','group_id','user_id');
CREATE TRIGGER crm_summary_principal_group_grant AFTER INSERT OR UPDATE OR DELETE ON public.workspace_group_compartment_grants
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_principal_revision_write('legacy','group','','group_id','compartment_key');
CREATE TRIGGER crm_summary_principal_access_grant AFTER INSERT OR UPDATE OR DELETE ON public.workspace_access_grants
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_principal_revision_write('legacy_grant','workspace_id','','workspace_id','beneficiary_kind','beneficiary_id','target_team_id','starts_at','expires_at','revoked_at');
CREATE TRIGGER crm_summary_principal_department AFTER INSERT OR UPDATE OR DELETE ON public.department_edges
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_principal_revision_write('department','workspace_id','user_id','workspace_id','department_id','user_id','assistant_id','clearance','expires_at');
CREATE TRIGGER crm_summary_principal_assistant AFTER INSERT OR UPDATE OR DELETE ON public.assistants
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_principal_revision_write('assistant','workspace_id','id','workspace_id','id','clearance');
CREATE TRIGGER crm_summary_principal_project AFTER INSERT OR UPDATE OR DELETE ON public.project_shared_scopes
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_principal_revision_write('project','workspace_id','','workspace_id','project_id','status');
CREATE TRIGGER crm_summary_principal_project_member AFTER INSERT OR UPDATE OR DELETE ON public.project_shared_members
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_principal_revision_write('project_member','workspace_id','user_id','workspace_id','project_id','user_id','assistant_id','expires_at');

-- The existing protected readers reject relation owners and privileged logins.
-- Reload that actual login and the member/workspace rows at each independent seam.
CREATE FUNCTION public.crm_summary_principal_stamp(w uuid,actor uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT jsonb_build_object(
    'workspaceId',w,'actorId',actor,'login',session_user,
    'role',m.role,'clearance',m.clearance,'teamScopeMode',m.team_scope_mode,'compartments',m.compartments,
    'departmentReadV2',wk.department_read_v2,'projectSharedSpaces',wk.project_shared_spaces,
    -- Each key is compared independently. Concurrent writers can commit
    -- sequence values out of order, so a single maximum would miss a write.
    'revisions',jsonb_build_array(
      (SELECT revision FROM public.crm_summary_principal_revisions WHERE workspace_id=w AND fact='workspace' AND subject_id='00000000-0000-0000-0000-000000000000'),
      (SELECT revision FROM public.crm_summary_principal_revisions WHERE workspace_id=w AND fact='member' AND subject_id=actor),
      CASE WHEN NOT wk.department_read_v2 THEN (SELECT revision FROM public.crm_summary_principal_revisions WHERE workspace_id=w AND fact='legacy' AND subject_id='00000000-0000-0000-0000-000000000000') END,
      CASE WHEN NOT wk.department_read_v2 THEN (SELECT revision FROM public.crm_summary_principal_revisions WHERE workspace_id=w AND fact='legacy_member' AND subject_id=actor) END,
      CASE WHEN wk.department_read_v2 THEN (SELECT revision FROM public.crm_summary_principal_revisions WHERE workspace_id=w AND fact='department' AND subject_id=actor) END,
      CASE WHEN wk.department_read_v2 AND settings.assistant IS NOT NULL THEN (SELECT revision FROM public.crm_summary_principal_revisions WHERE workspace_id=w AND fact='department' AND subject_id=settings.assistant) END,
      CASE WHEN wk.department_read_v2 AND settings.assistant IS NOT NULL THEN (SELECT revision FROM public.crm_summary_principal_revisions WHERE workspace_id=w AND fact='assistant' AND subject_id=settings.assistant) END,
      CASE WHEN wk.department_read_v2 AND wk.project_shared_spaces THEN (SELECT revision FROM public.crm_summary_principal_revisions WHERE workspace_id=w AND fact='project' AND subject_id='00000000-0000-0000-0000-000000000000') END,
      CASE WHEN wk.department_read_v2 AND wk.project_shared_spaces THEN (SELECT revision FROM public.crm_summary_principal_revisions WHERE workspace_id=w AND fact='project_member' AND subject_id=actor) END,
      CASE WHEN wk.department_read_v2 AND wk.project_shared_spaces AND settings.assistant IS NOT NULL THEN (SELECT revision FROM public.crm_summary_principal_revisions WHERE workspace_id=w AND fact='project_member' AND subject_id=settings.assistant) END
    ),
    'settings',jsonb_build_object(
      'clearance',nullif(current_setting('app.agent_clearance',true),''),
      'compartments',nullif(current_setting('app.agent_compartments',true),''),
      'projects',nullif(current_setting('app.agent_project_ids',true),''),
      'assistants',nullif(current_setting('app.agent_visibility_assistants',true),''),
      'shared',current_setting('app.agent_shared_audience',true) IS NOT DISTINCT FROM 'true',
      'v2Active',current_setting('app.v2_active',true) IS NOT DISTINCT FROM 'true',
      'v2Assistant',settings.assistant,
      'v2Department',nullif(current_setting('app.v2_context_department',true),''),
      'v2Binding',nullif(current_setting('app.v2_binding',true),''),
      'v2Cap',nullif(current_setting('app.v2_cap',true),'')))
  FROM public.workspace_members m JOIN public.workspaces wk ON wk.id=m.workspace_id
  CROSS JOIN LATERAL (SELECT nullif(current_setting('app.v2_assistant_id',true),'')::uuid AS assistant OFFSET 0) settings
  WHERE m.workspace_id=w AND m.user_id=actor AND actor=nullif(current_setting('app.current_user_id',true),'')::uuid
    AND nullif(current_setting('app.application_id',true),'') IS NULL
    AND nullif(current_setting('app.public_share_root',true),'') IS NULL
    AND coalesce(nullif(current_setting('app.agent_workspace_id',true),''),w::text)=w::text
    AND coalesce(nullif(current_setting('app.agent_actor_id',true),''),actor::text)=actor::text
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid=session_user::regrole::oid
      AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.oid IN('public.application_query_domains'::regclass,'public.crm_pipelines'::regclass)
          AND pg_catalog.pg_has_role(r.oid,c.relowner,'USAGE')))
$$;
REVOKE ALL ON FUNCTION public.crm_summary_principal_stamp(uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_capture_principal(w uuid,actor uuid,at_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE stamp jsonb:=public.crm_summary_principal_stamp(w,actor);
DECLARE settings jsonb:=stamp->'settings';
DECLARE v2 boolean:=stamp->>'departmentReadV2'='true';
DECLARE assistant uuid:=(settings->>'v2Assistant')::uuid;
DECLARE role_key text:=stamp->>'role';
DECLARE member_tier int:=public.sensitivity_rank(CASE WHEN role_key IN('owner','admin') THEN 'confidential' ELSE stamp->>'clearance' END);
DECLARE bound_tier int:=3;
DECLARE legacy_ceiling boolean:=settings->>'clearance' IS NOT NULL AND (NOT v2 OR settings->>'v2Active'='false' AND assistant IS NULL);
DECLARE original_labels jsonb:=coalesce((settings->>'compartments')::jsonb,'null');
DECLARE allowed_labels jsonb;
DECLARE projects jsonb:=coalesce((settings->>'projects')::jsonb,'null');
DECLARE assistants jsonb:=coalesce((settings->>'assistants')::jsonb,'null');
DECLARE binding jsonb:=coalesce((settings->>'v2Binding')::jsonb,'null');
DECLARE context_department text:=settings->>'v2Department';
DECLARE base text[];
DECLARE departments jsonb;
DECLARE project_labels jsonb;
DECLARE other_labels jsonb;
DECLARE next_change timestamptz;
DECLARE department_expiry timestamptz;
DECLARE project_expiry timestamptz;
DECLARE scope jsonb;
BEGIN
  IF stamp IS NULL OR at_time IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(assistants) NOT IN ('array','null') OR jsonb_typeof(projects) NOT IN ('array','null') THEN RETURN NULL; END IF;
  IF legacy_ceiling THEN
    bound_tier:=public.sensitivity_rank(settings->>'clearance');
    IF bound_tier IS NULL THEN RETURN NULL; END IF;
  END IF;
  IF NOT v2 THEN
    IF role_key NOT IN('owner','admin') THEN
      IF stamp->>'teamScopeMode'='legacy' THEN
        IF stamp->'compartments'<>'null' THEN
          base:=ARRAY(SELECT jsonb_array_elements_text(stamp->'compartments'));
        END IF;
      ELSE
        base:=public.effective_member_team_compartments(actor,w);
      END IF;
    END IF;
    IF base IS NOT NULL THEN
      -- Identical labels with adjacent or overlapping grants have one frontier.
      -- Ignore timelines already admitted through fixed membership or excluded
      -- by this execution's label ceiling.
      WITH beneficiary(kind,id) AS (
        SELECT 'member',actor UNION ALL
        SELECT 'team',g.id FROM public.workspace_group_members m JOIN public.workspace_groups g ON g.id=m.group_id
        WHERE m.user_id=actor AND g.workspace_id=w AND g.status='active'
      ), windows AS (
        SELECT t.compartment_key AS label,range_agg(tstzrange(g.starts_at,g.expires_at,'[)')) AS spans
        FROM beneficiary b JOIN public.workspace_access_grants g ON g.workspace_id=w AND g.beneficiary_kind=b.kind AND g.beneficiary_id=b.id
        JOIN public.workspace_groups t ON t.id=g.target_team_id AND t.workspace_id=w AND t.status='active'
        WHERE g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>at_time)
          AND NOT coalesce(t.compartment_key=ANY(base),false)
          AND (original_labels='null' OR original_labels ? t.compartment_key)
        GROUP BY t.compartment_key
      ), active_or_future AS (
        SELECT label,span@>at_time AS active,
          CASE WHEN span@>at_time THEN upper(span) ELSE lower(span) END AS transition
        FROM windows CROSS JOIN LATERAL unnest(spans) AS span
        WHERE span@>at_time OR lower(span)>at_time
      ) SELECT ARRAY(SELECT unnest(base) UNION SELECT label FROM active_or_future WHERE active),
        (SELECT min(transition) FROM active_or_future WHERE transition<'infinity')
      INTO base,next_change;
    END IF;
    allowed_labels:=public.application_query_set_intersection(coalesce(to_jsonb(base),'null'),original_labels);
    scope:=public.application_normalize_native_query_bounds(jsonb_build_object('kind','native_legacy',
      'tier',least(member_tier,bound_tier),'compartments',allowed_labels,'projectIds',projects));
    -- The original workflow treats malformed compartment grants as denying all rows.
    IF public.agent_scope_grant_allows('app.agent_compartments','{}') IS NOT TRUE THEN RETURN NULL; END IF;
  ELSE
    allowed_labels:=CASE WHEN legacy_ceiling THEN coalesce((settings->>'compartments')::jsonb,'[]') ELSE 'null' END;
    IF jsonb_typeof(allowed_labels) NOT IN('array','null') OR jsonb_typeof(binding) NOT IN('array','null')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN allowed_labels='null' THEN '[]' ELSE allowed_labels END) i WHERE jsonb_typeof(i)<>'string')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN binding='null' THEN '[]' ELSE binding END) i WHERE jsonb_typeof(i)<>'string') THEN RETURN NULL; END IF;
    bound_tier:=least(bound_tier,CASE WHEN settings->>'v2Cap' IS NULL THEN 3 ELSE coalesce(public.sensitivity_rank(settings->>'v2Cap'),0) END);
    IF assistant IS NOT NULL THEN
      member_tier:=least(member_tier,coalesce((SELECT public.sensitivity_rank(a.clearance) FROM public.assistants a WHERE a.id=assistant AND a.workspace_id=w),0));
    END IF;
    SELECT coalesce(jsonb_object_agg(e.department_id,least(public.sensitivity_rank(e.clearance),bound_tier,
             CASE WHEN assistant IS NULL THEN 3 ELSE public.sensitivity_rank(a.clearance) END)),'{}'),
           min(least(nullif(e.expires_at,'infinity'),nullif(a.expires_at,'infinity')))
      INTO departments,department_expiry
    FROM public.department_edges e LEFT JOIN public.department_edges a ON a.department_id=e.department_id AND a.assistant_id=assistant
      AND (a.expires_at IS NULL OR a.expires_at>at_time)
    WHERE e.workspace_id=w AND e.user_id=actor AND (e.expires_at IS NULL OR e.expires_at>at_time)
      AND (assistant IS NULL OR a.id IS NOT NULL) AND bound_tier>0
      AND (binding='null' OR binding ? e.department_id::text)
      AND (allowed_labels='null' OR allowed_labels ? ('team:'||e.department_id::text));
    project_labels:='[]';
    IF stamp->>'projectSharedSpaces'='true' THEN
      SELECT coalesce(jsonb_agg(s.project_id::text ORDER BY s.project_id),'[]'),
             min(least(CASE WHEN role_key<>'owner' THEN nullif(h.expires_at,'infinity') END,nullif(a.expires_at,'infinity')))
        INTO project_labels,project_expiry
      FROM public.project_shared_scopes s
      LEFT JOIN public.project_shared_members h ON h.project_id=s.project_id AND h.user_id=actor AND (h.expires_at IS NULL OR h.expires_at>at_time)
      LEFT JOIN public.project_shared_members a ON a.project_id=s.project_id AND a.assistant_id=assistant AND (a.expires_at IS NULL OR a.expires_at>at_time)
      WHERE s.workspace_id=w AND s.status='active' AND (role_key='owner' OR h.id IS NOT NULL)
        AND (assistant IS NULL OR a.id IS NOT NULL) AND (binding='null' OR binding ? s.project_id::text)
        AND (allowed_labels='null' OR allowed_labels ? ('project:'||s.project_id::text));
    END IF;
    other_labels:='null';
    IF allowed_labels<>'null' THEN
      SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO other_labels FROM (
        SELECT DISTINCT value FROM jsonb_array_elements(allowed_labels)
        WHERE value#>>'{}' NOT LIKE 'team:%' AND value#>>'{}' NOT LIKE 'project:%'
      ) labels;
    END IF;
    scope:=jsonb_build_object('kind','native_department_v2','tier',least(member_tier,bound_tier),
      'departments',departments,'contextDepartment',context_department,'projectLabels',project_labels,'otherLabels',other_labels,'projectIds',projects);
    next_change:=least(department_expiry,project_expiry);
  END IF;
  IF public.application_query_scope_valid(scope) IS NOT TRUE THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('mode',CASE WHEN v2 THEN 'department_v2' ELSE 'legacy' END,
    'nativeBounds',scope,'visibility',jsonb_build_object('userId',CASE WHEN settings->>'shared'='false' THEN actor END,'assistants',assistants),
    'principalStamp',stamp,'nextChange',next_change);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_capture_principal(uuid,uuid,timestamptz) FROM PUBLIC,app_user;

-- Both canonical native and workflow predicates reduce to this typed subset
-- test after capture. The native map includes every workflow binding and cap;
-- no old permissive input can add a Project, label, private or assistant leg.
CREATE FUNCTION public.crm_summary_scope_admitted(basis jsonb,scope_row public.crm_summary_scope_classes) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE bound jsonb:=basis->'nativeBounds';
DECLARE visibility jsonb:=basis->'visibility';
DECLARE department_caps jsonb:=bound->'departments';
DECLARE contextual_department text:=bound->>'contextDepartment';
DECLARE general_tier integer:=(bound->>'tier')::integer;
DECLARE row_tier integer:=public.sensitivity_rank(scope_row.sensitivity);
DECLARE label text;
DECLARE project uuid;
DECLARE has_department boolean:=false;
DECLARE in_context boolean:=false;
BEGIN
  IF bound IS NULL OR visibility IS NULL OR row_tier IS NULL
    OR scope_row.workspace_id::text IS DISTINCT FROM basis#>>'{principalStamp,workspaceId}'
    OR scope_row.user_id IS NOT NULL AND scope_row.user_id::text IS DISTINCT FROM visibility->>'userId'
    OR scope_row.assistant_id IS NOT NULL AND visibility->'assistants'<>'null' AND NOT (visibility->'assistants' ? scope_row.assistant_id::text)
  THEN RETURN false; END IF;
  FOREACH label IN ARRAY scope_row.compartments LOOP
    IF label IS NULL THEN RETURN false; END IF;
    IF label LIKE 'team:%' THEN
      has_department:=true;
      in_context:=in_context OR substr(label,6)=contextual_department;
      IF row_tier>(CASE WHEN department_caps='null' THEN general_tier ELSE coalesce((department_caps->>substr(label,6))::int,0) END) THEN RETURN false; END IF;
    ELSIF label LIKE 'project:%' THEN
      IF NOT (bound->'projectLabels' ? substr(label,9)) THEN RETURN false; END IF;
    ELSIF bound->'otherLabels'<>'null' AND NOT (bound->'otherLabels' ? label) THEN RETURN false;
    END IF;
  END LOOP;
  IF has_department AND contextual_department IS NOT NULL AND NOT in_context OR NOT has_department AND row_tier>general_tier THEN RETURN false; END IF;
  FOREACH project IN ARRAY scope_row.project_ids LOOP
    IF project IS NULL OR bound->'projectIds'<>'null' AND NOT (bound->'projectIds' ? project::text) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_scope_admitted(jsonb,public.crm_summary_scope_classes) FROM PUBLIC,app_user;

-- A changed stamp or expired captured edge may be irrelevant or widen the
-- old domain. Recompile only then. Still require fresh covering authority;
-- the caller separately checks every original source and policy obligation.
CREATE FUNCTION public.crm_summary_principal_current(w uuid,actor uuid,original jsonb,at_time timestamptz) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE live_stamp jsonb:=public.crm_summary_principal_stamp(w,actor);
DECLARE live jsonb;
DECLARE old_visibility jsonb:=original->'visibility';
DECLARE new_visibility jsonb;
BEGIN
  IF live_stamp IS NULL OR original IS NULL OR at_time IS NULL THEN RETURN false; END IF;
  IF live_stamp=original->'principalStamp' AND (original->>'nextChange' IS NULL OR at_time<(original->>'nextChange')::timestamptz) THEN RETURN true; END IF;
  live:=public.crm_summary_capture_principal(w,actor,at_time);
  new_visibility:=live->'visibility';
  RETURN coalesce(live->>'mode'=original->>'mode'
    AND (old_visibility->>'userId' IS NULL OR new_visibility->>'userId'=old_visibility->>'userId')
    AND (new_visibility->'assistants'='null' OR old_visibility->'assistants'<>'null' AND (new_visibility->'assistants') @> (old_visibility->'assistants'))
    AND public.application_query_bounds_contain(live->'nativeBounds',original->'nativeBounds'),false);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_principal_current(uuid,uuid,jsonb,timestamptz) FROM PUBLIC,app_user;
COMMIT;
