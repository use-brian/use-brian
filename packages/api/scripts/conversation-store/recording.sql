-- [COMP:api/native-turn-frame] Explicit current recording-epoch admission.
-- This owns the channel/member/route fences formerly hidden in reader eligibility.
-- A false result is not historical erasure or source admission.
CREATE FUNCTION conversation_recording_scope(w uuid,session_ids jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE epochs jsonb;initial jsonb;pass integer;
BEGIN
 FOR pass IN 1..2 LOOP
 WITH parent_ids AS(SELECT value::uuid id FROM jsonb_array_elements_text(session_ids)), certificates AS(
 SELECT s.id,jsonb_build_object('eligible',coalesce(
  s.workspace_id=w AND NOT s.recording_privacy_held AND s.visibility='workspace'
  AND s.channel_type='telegram' AND s.anchor_kind='channel' AND s.anchor_ref=s.channel_id
  AND s.recording_revision IS NOT NULL AND s.recording_policy_id=policy.id
  AND policy.workspace_id=w AND policy.session_id=s.id AND policy.revision=s.recording_revision
  AND policy.enabled AND policy.destination='workspace' AND policy.project_id IS NOT DISTINCT FROM s.context_project_id
  AND policy.conversation_id=s.channel_id AND policy.owner_user_id=s.user_id
  AND ci.id=policy.integration_id AND ci.status='active' AND ci.channel_type='telegram'
  AND ci.bot_user_id=policy.bot_id AND ci.recording_owner_user_id=policy.owner_user_id
  AND c.id=ci.channel_id AND c.workspace_id=w AND c.status='active' AND c.channel_type='telegram'
  AND owner_member.user_id=policy.owner_user_id AND a.id=s.assistant_id AND a.workspace_id=w
  AND routing.assistant_id=s.assistant_id AND audience.allowed
  AND (SELECT count(*) FROM channel_assistants same_route WHERE same_route.channel_id=c.id
   AND same_route.external_surface_id IS NOT DISTINCT FROM routing.external_surface_id)=1
  AND (policy.project_id IS NULL OR project.id=policy.project_id AND project.workspace_id=w
   AND project.status='active' AND project_scope.status='active'
   AND workspace.department_read_v2 AND workspace.project_shared_spaces
   AND project_member_live(policy.project_id,'user',policy.owner_user_id)
   AND project_member_live(policy.project_id,'assistant',s.assistant_id)),false),
  'policy',to_jsonb(policy),
  'integration',jsonb_build_object('id',ci.id,'channelId',ci.channel_id,'channelType',ci.channel_type,
   'status',ci.status,'botId',ci.bot_user_id,'recorderId',ci.recording_owner_user_id),
  'channel',jsonb_build_object('id',c.id,'workspaceId',c.workspace_id,'channelType',c.channel_type,
   'status',c.status,'clearance',c.clearance,'capabilities',c.enabled_capabilities),
  'owner',jsonb_build_object('userId',owner_member.user_id,'role',owner_member.role,
   'clearance',owner_member.clearance,'compartments',owner_member.compartments),
  'assistant',jsonb_build_object('id',a.id,'workspaceId',a.workspace_id,'clearance',a.clearance,
   'compartments',a.compartments,'departmentId',a.placement_department_id),
  'routing',jsonb_build_object('id',routing.id,'channelId',routing.channel_id,
   'assistantId',routing.assistant_id,'surfaceId',routing.external_surface_id),
  'audiences',audience.bindings,
  'project',jsonb_build_object('id',project.id,'workspaceId',project.workspace_id,'status',project.status,
   'sharedStatus',project_scope.status,'enabled',workspace.project_shared_spaces AND workspace.department_read_v2,
   'recorderMember',CASE WHEN policy.project_id IS NOT NULL THEN project_member_live(policy.project_id,'user',policy.owner_user_id) ELSE NULL END,
   'assistantMember',CASE WHEN policy.project_id IS NOT NULL THEN project_member_live(policy.project_id,'assistant',s.assistant_id) ELSE NULL END)) certificate
 FROM parent_ids ids JOIN sessions s ON s.id=ids.id
 LEFT JOIN channel_recording_policies policy ON policy.id=s.recording_policy_id
 LEFT JOIN channel_integrations ci ON ci.id=policy.integration_id
 LEFT JOIN channels c ON c.id=ci.channel_id
 LEFT JOIN workspace_members owner_member ON owner_member.workspace_id=w AND owner_member.user_id=policy.owner_user_id
 LEFT JOIN assistants a ON a.id=s.assistant_id
 LEFT JOIN workspaces workspace ON workspace.id=w
 LEFT JOIN workspace_projects project ON project.id=policy.project_id
 LEFT JOIN project_shared_scopes project_scope ON project_scope.project_id=policy.project_id
 LEFT JOIN LATERAL(SELECT ca.id,ca.channel_id,ca.assistant_id,ca.external_surface_id FROM channel_assistants ca
  WHERE ca.channel_id=c.id AND(ca.external_surface_id IN(s.channel_id,split_part(s.channel_id,':',1)) OR ca.external_surface_id IS NULL)
  ORDER BY CASE WHEN ca.external_surface_id=s.channel_id THEN 1 WHEN ca.external_surface_id=split_part(s.channel_id,':',1) THEN 2 ELSE 3 END LIMIT 1) routing ON true
 LEFT JOIN LATERAL(
  -- Match the canonical provider-group audience: every active bot's exact
  -- topic AND parent approval participates, with the same company-wide rule.
  SELECT count(*)>0 AND coalesce(bool_and(coalesce(
   binding->'version'='1'::jsonb AND binding->>'audienceType'='group' AND binding->>'recipientUserId' IS NULL
   AND (binding->'companyWide' IS NULL OR jsonb_typeof(binding->'companyWide')='boolean')
   AND binding->>'clearance' IN('public','internal','confidential')
   AND sensitivity_rank(binding->>'clearance')>=sensitivity_rank(s.effective_clearance)
   AND(binding->>'expiresAt' IS NULL OR (binding->>'expiresAt')::timestamptz>clock_timestamp())
   AND approver.role IN('owner','admin')
   AND jsonb_typeof(binding->'compartments')='array' AND jsonb_typeof(binding->'projectIds')='array'
   AND (binding->'companyWide' IS DISTINCT FROM 'true'::jsonb OR binding->'compartments'='[]'::jsonb AND binding->'projectIds'='[]'::jsonb)
   AND ((binding->'companyWide'='true'::jsonb AND binding->'compartments'='[]'::jsonb AND binding->'projectIds'='[]'::jsonb)
    OR to_jsonb(s.context_compartments)<@(binding->'compartments')
     AND(s.context_project_id IS NULL OR binding->'projectIds' ? s.context_project_id::text)),false)),false) allowed,
   coalesce(jsonb_agg(jsonb_build_object('integrationId',other_ci.id,'channelId',other_c.id,
    'binding',binding,'approver',jsonb_build_object('userId',approver.user_id,'role',approver.role))
    ORDER BY other_ci.id,binding::text),'[]'::jsonb) bindings
  FROM channel_integrations other_ci JOIN channels other_c ON other_c.id=other_ci.channel_id
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(other_ci.config->'deliveryAudienceBindings','[]'::jsonb)) binding
  LEFT JOIN workspace_members approver ON approver.workspace_id=w AND approver.user_id=(binding->>'approvedByUserId')::uuid
  WHERE other_c.workspace_id=w AND other_c.status='active' AND other_ci.status='active' AND other_ci.channel_type='telegram'
   AND binding->>'version'='1' AND binding->>'channelId' IN(s.channel_id,split_part(s.channel_id,':',1))
 ) audience ON true
 WHERE s.recording_revision IS NOT NULL OR s.channel_type='telegram' AND s.anchor_kind='channel'
  AND s.channel_id ~ '^-[0-9]+(:topic:[0-9]+|:discussion:[0-9]+)?$'
 ) SELECT coalesce(jsonb_object_agg(id::text,certificate),'{}'::jsonb) INTO epochs FROM certificates;

 IF EXISTS(SELECT 1 FROM jsonb_each(epochs) entry WHERE entry.value->>'eligible' IS DISTINCT FROM 'true') THEN RETURN false;END IF;
 IF pass=1 THEN
  initial:=epochs;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id IN(
  SELECT (p#>>'{owner,userId}')::uuid FROM jsonb_each(epochs) parent(key,p)
  UNION SELECT (audience#>>'{approver,userId}')::uuid FROM jsonb_each(epochs) parent(key,p)
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{audiences}','[]'::jsonb)) audience
 ) ORDER BY user_id FOR SHARE NOWAIT;
 -- A channel key lock also fences a new route inserted through its FK.
 PERFORM id FROM channels WHERE workspace_id=w AND id IN(
  SELECT (p#>>'{channel,id}')::uuid FROM jsonb_each(epochs) parent(key,p)
  UNION SELECT (audience->>'channelId')::uuid FROM jsonb_each(epochs) parent(key,p)
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{audiences}','[]'::jsonb)) audience
 ) ORDER BY id FOR UPDATE NOWAIT;
 PERFORM id FROM channel_integrations WHERE id IN(
  SELECT (p#>>'{integration,id}')::uuid FROM jsonb_each(epochs) parent(key,p)
  UNION SELECT (audience->>'integrationId')::uuid FROM jsonb_each(epochs) parent(key,p)
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{audiences}','[]'::jsonb)) audience
 ) ORDER BY id FOR SHARE NOWAIT;
 PERFORM id FROM channel_assistants WHERE channel_id IN(
  SELECT (p#>>'{channel,id}')::uuid FROM jsonb_each(epochs) parent(key,p)
 ) ORDER BY id FOR SHARE NOWAIT;
 PERFORM id FROM channel_recording_policies WHERE workspace_id=w AND id IN(
  SELECT (p#>>'{policy,id}')::uuid FROM jsonb_each(epochs) parent(key,p)
 ) ORDER BY id FOR SHARE NOWAIT;

 ELSE
  IF epochs IS DISTINCT FROM initial THEN RETURN false;END IF;
 END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN lock_not_available OR invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $body$;
REVOKE ALL ON FUNCTION conversation_recording_scope(uuid,jsonb) FROM PUBLIC,app_user;
