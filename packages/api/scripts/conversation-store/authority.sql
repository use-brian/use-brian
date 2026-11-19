-- [COMP:api/authority-lease] One canonical owner for fresh session metadata.
CREATE FUNCTION read_session_department_facts(uuid,uuid,uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $facts$
WITH member AS MATERIALIZED (
    SELECT role, clearance FROM workspace_members WHERE workspace_id=$1 AND user_id=$2
  ), active_projects AS MATERIALIZED (
    SELECT s.project_id FROM project_shared_scopes s JOIN workspaces w ON w.id=s.workspace_id
    WHERE s.workspace_id=$1 AND s.status='active' AND w.project_shared_spaces
  ) SELECT jsonb_build_object(
    'member', (SELECT to_jsonb(m) FROM member m),
    'assistant', (SELECT jsonb_build_object('clearance',a.clearance) FROM assistants a
      WHERE a.id=$3 AND a.workspace_id=$1 AND public.assistant_placement_visible($2,a.id)),
    'edges', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'kind',e.principal_kind,'id',coalesce(e.user_id,e.assistant_id),
      'departmentId',e.department_id,'clearance',e.clearance,'expiresAt',e.expires_at))
      FROM department_edges e WHERE e.workspace_id=$1
        AND ((e.user_id=$2 AND EXISTS(SELECT 1 FROM member)) OR e.assistant_id=$3)), '[]'::jsonb),
    'activeProjects', coalesce((SELECT jsonb_agg(project_id ORDER BY project_id) FROM active_projects), '[]'::jsonb),
    'projectEdges', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'kind',e.principal_kind,'id',coalesce(e.user_id,e.assistant_id),
      'projectId',e.project_id,'expiresAt',e.expires_at))
      FROM project_shared_members e WHERE e.workspace_id=$1 AND EXISTS(SELECT 1 FROM active_projects)
        AND ((e.user_id=$2 AND EXISTS(SELECT 1 FROM member)) OR e.assistant_id=$3)), '[]'::jsonb)
    ) AS snapshot
$facts$;
REVOKE ALL ON FUNCTION read_session_department_facts(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_session_department_facts(uuid,uuid,uuid) TO app_user;
CREATE FUNCTION read_session_authority_facts(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $facts$
SELECT jsonb_build_object(
    'scope', jsonb_build_object(
      'assignedTeams', coalesce((SELECT jsonb_agg(jsonb_build_object('readAll',g.read_all,'own',g.compartment_key,'grant',cg.compartment_key))
        FROM workspace_group_assistants ga JOIN workspace_groups g ON g.id=ga.group_id
        LEFT JOIN workspace_group_compartment_grants cg ON cg.group_id=g.id
        WHERE ga.assistant_id=$3 AND g.workspace_id=$1 AND g.kind='team'
          AND EXISTS(SELECT 1 FROM assistants WHERE id=$3 AND team_scope_mode='assigned')), '[]'::jsonb),
      'assignedProjects', coalesce((SELECT jsonb_agg(p.id ORDER BY p.id) FROM assistant_project_grants apg
        JOIN workspace_projects p ON p.id=apg.project_id WHERE apg.assistant_id=$3 AND p.workspace_id=$1
          AND EXISTS(SELECT 1 FROM assistants WHERE id=$3 AND project_scope_mode='assigned')), '[]'::jsonb),
      'team', (SELECT jsonb_build_object('id',g.id,'name',g.name,'key',g.key,'compartmentKey',g.compartment_key,
        'status',g.status,'readAll',g.read_all,'grants',coalesce((SELECT jsonb_agg(cg.compartment_key ORDER BY cg.compartment_key)
          FROM workspace_group_compartment_grants cg WHERE cg.group_id=g.id),'[]'::jsonb))
        FROM workspace_groups g JOIN sessions s ON s.context_group_id=g.id
        WHERE s.id=$4 AND g.workspace_id=$1 AND g.kind='team'),
      'project', (SELECT jsonb_build_object('id',p.id,'name',p.name,'status',p.status,
        'shared',EXISTS(SELECT 1 FROM project_shared_scopes ps WHERE ps.project_id=p.id))
        FROM workspace_projects p JOIN sessions s ON s.context_project_id=p.id WHERE s.id=$4 AND p.workspace_id=$1)),
    'policy', CASE WHEN $9::boolean THEN public.read_application_policy_epoch($1,$2,$3) ELSE NULL END,
    'session', (SELECT jsonb_build_object('id',s.id,'assistantId',s.assistant_id,'userId',s.user_id,
      'contextGroupId',s.context_group_id,'contextProjectId',s.context_project_id,'contextLockedAt',s.context_locked_at,'appOrigin',s.app_origin,'anchorKind',s.anchor_kind,'anchorRef',s.anchor_ref,'channelType',s.channel_type,'channelId',s.channel_id,
      'visibility',s.visibility,'mode',s.mode,'effectiveClearance',s.effective_clearance,'contextCompartments',s.context_compartments)
      FROM sessions s WHERE s.id=$4 AND session_recording_read_allowed(s.id)),
    'assistant', (SELECT jsonb_build_object('id',a.id,'workspaceId',a.workspace_id,'kind',a.kind,
      'clearance',a.clearance,'compartments',a.compartments,'defaultCompartments',a.default_compartments,
      'teamScopeMode',a.team_scope_mode,'defaultWorkspaceGroupId',a.default_workspace_group_id,
      'projectScopeMode',a.project_scope_mode,'defaultProjectId',a.default_project_id)
      FROM assistants a WHERE a.id=$3),
    'member', (SELECT jsonb_build_object('role',m.role,'clearance',m.clearance,
      'readCompartments',effective_member_read_compartments(m.user_id,m.workspace_id),
      'mutationCompartments',effective_member_team_compartments(m.user_id,m.workspace_id),
      'departmentReadV2',(SELECT to_jsonb(w)->>'department_read_v2' FROM workspaces w WHERE w.id=$1))
      FROM workspace_members m WHERE m.workspace_id=$1 AND m.user_id=$2),
    'department', CASE WHEN $8::boolean AND EXISTS(SELECT 1 FROM workspaces WHERE id=$1 AND department_read_v2)
      THEN (SELECT snapshot FROM (SELECT read_session_department_facts($1,$2,$3) AS snapshot) department_facts) ELSE NULL END,
    'credentialCurrent', CASE WHEN $5::uuid IS NULL THEN true ELSE $7::uuid=$2 AND EXISTS(
      SELECT 1 FROM users u JOIN auth_sessions s ON s.user_id=u.id
      WHERE u.id=$2 AND u.auth_version=$6 AND s.id=$5 AND s.auth_version=$6
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) END
    ) AS facts
$facts$;
REVOKE ALL ON FUNCTION read_session_authority_facts(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean) FROM PUBLIC;
