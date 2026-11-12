-- [COMP:api/native-chat-read-cost] Complete canonical metadata with packed adjacency.
CREATE OR REPLACE FUNCTION public.native_retained_metadata(w uuid, roots jsonb, selectors jsonb, discovery boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 nodes jsonb;frontier jsonb;next_nodes jsonb;edges jsonb:='[]';batch jsonb;
 privacy_nodes jsonb;privacy_frontier jsonb;privacy_edges jsonb:='[]';privacy_parents jsonb;recording_epochs jsonb;
 native_metadata jsonb;field_metadata jsonb;domains jsonb;candidates jsonb;point_metadata jsonb;parents jsonb;
 derivations jsonb;context jsonb;locks jsonb;witness jsonb;remaining jsonb;ready jsonb;order_json jsonb:='[]';
 reasons text[]:='{}';step integer:=0;counts jsonb;media_node jsonb;media_lineage jsonb;media_graph jsonb;
 graph jsonb;privacy_graph jsonb;prior_nodes integer;
BEGIN
 -- These are eligibility/profile gates only, not all actor permissions.
 IF w IS NULL OR actor IS NULL OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR nullif(current_setting('app.programmatic_candidate_source',true),'') IS NOT NULL
  OR nullif(current_setting('app.workflow_schedule_review',true),'') IS NOT NULL
  OR nullif(current_setting('app.system_bypass',true),'') IS NOT NULL
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)<>w::text
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)<>actor::text
  OR acting IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assistants WHERE workspace_id=w AND id=acting)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.session_messages'::regclass WHERE r.rolname=session_user
    AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
 THEN RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','profile_unavailable');END IF;
 IF (SELECT count(p.oid)=15 AND bool_and(encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=m.digest)
  FROM (VALUES ('application_scope_source_edges(uuid,text,uuid,text)','eb8966087803239c93bcdac1736ba917251adaed34c244feb3f80bc80d2c9077'),
('knowledge_version_source_edges(uuid,text,uuid,text)','f4deb0d7b7ef41db5dc1d2fedabcef545c836b9f8a78f48d55a2c7413e62f1cf'),
('application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','23d72c938e15ccb1877e6deabc9b75cd44c92f2539b0afd1c0456517086d6a03'),
('application_native_source_edges_dispatch(uuid,text,uuid,text)','e8df0ffdc3f459a5c4bbf6be0703d087ca4e02ad8bf04ce0b0e536dbb82566ca'),
('scope_source_ancestors(uuid,text,uuid)','cabe0f65f8e31b0123ebe2328d72f314ee1b82795cfa5cf66deb57c792384282'),
('scope_source_ancestors_before_workflow_run(uuid,text,uuid)','36bdb461a66fb00b81a5f0f6672b48dcc150858328b035b1ba1da0c3ed3715c8'),
('scope_source_ancestors_before_browser_session(uuid,text,uuid)','c5a684292738319265321ce21b76ea01ba775eb216af66ae992c190d39eedc5c'),
('scope_source_ancestors_before_browser_profile(uuid,text,uuid)','6b775f0025f9dc1be7fb3d6f230d7b0dec53dcb68de66e28c2f0c4326c5f9a48'),
('recording_source_read_allowed(uuid,text,uuid)','8a584e976f5e93fa624fc4e5442a5e62f7cd8efb90317f85d7168d03b1b6bcc1'),
('session_recording_read_allowed(uuid)','d23352b30977749dd2dad03504c1dab5cdeb9aa1b2ef11fc79701bd8714e1886'),
('application_session_eval_point_state(uuid,text,uuid,text[],jsonb)','2d8a9fdc382de4994bddd451dfbf0551e4ed53e6d0c75d7f06065584237700d2'),
('application_session_eval_domain(uuid,text,uuid,text[],jsonb)','47d45fe98cde529fd5bf6c01b9f3fc91cf891219aa94a0ade096fd290053911b'),
('application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','8f01ca980231ecab5963092178ec34d322986d6cd3451b2a037bc721721bae18'),
('application_session_query_parent(uuid,uuid)','85393998bba4fe1af647bbfaade0ae59e364081e4bbea4de1e57ccaf86cbd2e1'),
('application_memory_field_keys()','121516e1933584c3a2137363ff50204139876471c7b9b3e82ac736279c04c58c')) m(signature,digest) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(m.signature)) IS NOT TRUE
 THEN RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','source_contract_changed');END IF;
 IF jsonb_typeof(roots) IS DISTINCT FROM 'array' OR jsonb_array_length(roots) NOT BETWEEN 1 AND 4096
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(roots) r WHERE r-ARRAY['kind','id','version']<>'{}'
    OR r->>'kind' NOT IN('application_field','session_message','session_context_revision','workspace_file') OR NOT r ?& ARRAY['kind','id','version'] OR jsonb_typeof(r->'kind')<>'string' OR jsonb_typeof(r->'id')<>'string'
    OR jsonb_typeof(r->'version')<>'string' OR length(r->>'version') NOT BETWEEN 1 AND 256)
 THEN RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','invalid_roots');END IF;
 SELECT coalesce(jsonb_agg(n ORDER BY public.native_turn_key(n)),'[]') INTO nodes
 FROM(SELECT DISTINCT value||'{"tag":"source"}'::jsonb n FROM jsonb_array_elements(roots)) q;
 -- Selectors are server-owned query metadata, never evidence or permission.
 IF jsonb_typeof(selectors) IS DISTINCT FROM 'array' OR jsonb_array_length(selectors)>2
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(selectors) q WHERE jsonb_typeof(q) IS DISTINCT FROM 'object'
   OR q-ARRAY['type','sessionId','through']<>'{}' OR NOT q ?& ARRAY['type','sessionId','through']
   OR jsonb_typeof(q->'type') IS DISTINCT FROM 'string' OR jsonb_typeof(q->'sessionId') IS DISTINCT FROM 'string'
   OR q->>'type' NOT IN('session_message','session_message_annotation') OR jsonb_typeof(q->'through') IS DISTINCT FROM 'number'
   OR (q->>'through')::numeric IS DISTINCT FROM (q->>'through')::integer::numeric OR (q->>'through')::integer<0
   OR (q->>'sessionId')::uuid IS NULL)
  OR (SELECT count(*) FROM jsonb_array_elements(selectors))<>(SELECT count(DISTINCT q->>'type') FROM jsonb_array_elements(selectors) q)
 THEN RETURN jsonb_build_object('eligibleMetadata',false,'reason','selector_shape');END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(selectors) q WHERE (SELECT count(*) FROM (
  SELECT 1 FROM session_messages m WHERE m.workspace_id=w AND m.session_id=(q->>'sessionId')::uuid
   AND m.sequence_num<=(q->>'through')::integer LIMIT 4097) bounded)>4096)
 THEN RETURN jsonb_build_object('eligibleMetadata',false,'reason','selector_candidate_bound');END IF;
 SELECT jsonb_agg(n ORDER BY native_turn_key(n)) INTO nodes FROM (
  SELECT value n FROM jsonb_array_elements(nodes)
  UNION SELECT jsonb_build_object('tag','point','kind',q->>'type','id',m.id,
   'fields',(SELECT jsonb_agg(k ORDER BY k) FROM unnest(application_session_field_keys(q->>'type')) k))
   FROM jsonb_array_elements(selectors) q JOIN session_messages m
    ON m.workspace_id=w AND m.session_id=(q->>'sessionId')::uuid AND m.sequence_num<=(q->>'through')::integer
 ) complete_candidates;
 graph:=native_retained_graph_closure(w,nodes,false);
 IF graph IS NULL THEN RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','semantic_graph_unavailable');END IF;
 nodes:=graph->'nodes';edges:=graph->'edges';

 -- Include every physical candidate source, not only the original evidence.
 SELECT coalesce(jsonb_agg(n ORDER BY n::text),'[]') INTO privacy_nodes FROM(
  SELECT DISTINCT jsonb_build_object('kind',CASE WHEN n->>'tag'='point' THEN 'session_message' ELSE n->>'kind' END,'id',n->'id') n
  FROM jsonb_array_elements(nodes) n
 ) q;
 -- Canonical point-field identities are payload-independent. Existing
 -- observations may retain older annotation heads, so close their complete
 -- versionless privacy ancestry before selecting the current head's payload.
 -- Use the same physical query-resource universe before and after writes:
 -- current selectors plus every stored domain candidate, including missing and
 -- excluded heads. Plain read/identity field points do not add query resources.
 WITH query_points AS MATERIALIZED(
  SELECT e.child point FROM native_retained_graph_edges(graph,false) e WHERE e.edge_kind='domain_candidate'
  UNION SELECT jsonb_build_object('tag','point','kind',q->>'type','id',m.id,
   'fields',(SELECT jsonb_agg(k ORDER BY k) FROM unnest(application_session_field_keys(q->>'type')) k))
   FROM jsonb_array_elements(selectors) q JOIN session_messages m
    ON m.workspace_id=w AND m.session_id=(q->>'sessionId')::uuid AND m.sequence_num<=(q->>'through')::integer
 ) SELECT jsonb_agg(n ORDER BY n::text) INTO privacy_nodes FROM (
  SELECT value n FROM jsonb_array_elements(privacy_nodes)
  UNION SELECT jsonb_build_object('kind','application_field','id',application_field_resource_uuid(application_field_digest(
   jsonb_build_object('workspaceId',w,'origin','{"kind":"native","moduleKey":"native"}'::jsonb,
    'typeKey',point->>'kind','id',(point->>'id')::uuid,'selection','query','selectedVersion',NULL,'fields',point->'fields',
    'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_field_v1','type',point->>'kind','fields',point->'fields'))))))
   FROM query_points
 ) privacy_seeds;
 privacy_graph:=native_retained_graph_closure(w,privacy_nodes,true);
 IF privacy_graph IS NULL THEN RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','privacy_graph_unavailable');END IF;
 privacy_nodes:=privacy_graph->'nodes';privacy_edges:=privacy_graph->'edges';

 -- Exact six parent-resolution families, preserving a missing nonnull parent.
 WITH n AS MATERIALIZED(SELECT value FROM jsonb_array_elements(privacy_nodes)), p AS (
 SELECT value node,s.id session_id FROM n JOIN sessions s ON value->>'kind'='session' AND s.workspace_id=w AND s.id=(value->>'id')::uuid
 UNION SELECT value,m.session_id FROM n JOIN session_messages m ON value->>'kind'='session_message' AND m.id=(value->>'id')::uuid
  JOIN sessions s ON s.id=m.session_id AND s.workspace_id=w
 UNION SELECT value,r.session_id FROM n JOIN session_context_scope_revisions r ON value->>'kind'='session_context_revision' AND r.workspace_id=w AND r.id=(value->>'id')::uuid
 UNION SELECT value,s.session_id FROM n JOIN session_state s ON value->>'kind'='session_state' AND s.id=(value->>'id')::uuid
 UNION SELECT value,e.session_id FROM n JOIN episodic_memories e ON value->>'kind'='episodic_memory' AND e.id=(value->>'id')::uuid
 UNION SELECT value,e.session_id FROM n JOIN analytics_events e ON value->>'kind'='feedback_event' AND e.id=(value->>'id')::uuid
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('node',p.node,'sessionId',p.session_id,'exists',s.id IS NOT NULL,
  'held',s.recording_privacy_held,'recordingRevision',s.recording_revision,
  'legacyRecording',s.channel_type='telegram' AND s.anchor_kind='channel' AND s.channel_id ~ '^-[0-9]+(:topic:[0-9]+|:discussion:[0-9]+)?$') ORDER BY p.node::text,p.session_id),'[]')
 INTO privacy_parents FROM p LEFT JOIN sessions s ON s.id=p.session_id;
 -- This is optimization eligibility metadata, not actor or source admission.
 -- Every recording parent in the complete privacy closure must be an exact
 -- active Work epoch. Held, Personal and unreviewed legacy parents still fall back.
 WITH parent_ids AS(SELECT DISTINCT (p->>'sessionId')::uuid id FROM jsonb_array_elements(privacy_parents) p
  WHERE p->>'sessionId' IS NOT NULL), certificates AS(
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
 ) SELECT coalesce(jsonb_object_agg(id::text,certificate),'{}'::jsonb) INTO recording_epochs FROM certificates;
 SELECT coalesce(jsonb_agg(p||jsonb_build_object('recordingEpoch',recording_epochs->(p->>'sessionId'))
  ORDER BY (p->'node')::text,p->>'sessionId'),'[]'::jsonb) INTO privacy_parents FROM jsonb_array_elements(privacy_parents) p;

 IF EXISTS(SELECT 1 FROM jsonb_array_elements(privacy_nodes) n WHERE n->>'kind' NOT IN('session','application_field','application_query_domain','session_message','session_context_revision','workspace_file','episode','recording'))
 THEN reasons:=array_append(reasons,'unsupported_versionless_ancestry');END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(privacy_parents) p WHERE p->>'sessionId' IS NOT NULL AND
   (p->>'exists' IS DISTINCT FROM 'true' OR p->>'held' IS DISTINCT FROM 'false' OR ((p->>'recordingRevision' IS NOT NULL OR p->>'legacyRecording'='true') AND p#>>'{recordingEpoch,eligible}' IS DISTINCT FROM 'true')))
 THEN reasons:=array_append(reasons,'recording_or_held_parent');END IF;
 -- No body/content/name/attachment bytes are read in these metadata relations.
 WITH n AS(SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'tag'='source')
 SELECT coalesce(jsonb_agg(jsonb_build_object('node',n.value,'resource',to_jsonb(r),'observation',to_jsonb(o)) ORDER BY n.value::text),'[]')
 INTO field_metadata FROM n LEFT JOIN application_field_resources r ON r.workspace_id=w AND r.id=(n.value->>'id')::uuid
 LEFT JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=r.id AND o.version=n.value->>'version'
 WHERE n.value->>'kind'='application_field';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(field_metadata) f WHERE f->>'resource' IS NULL OR f->>'observation' IS NULL
  OR f#>'{resource,origin}' IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
  OR f#>>'{resource,type_key}' NOT IN('session_message','session_message_annotation','memory')
  OR f#>>'{resource,type_key}'='memory' AND f#>>'{resource,selection}' IS DISTINCT FROM 'query_domain'
  OR f#>>'{resource,selection}' NOT IN('read','query','identity','query_domain') OR f#>>'{resource,selected_version}' IS NOT NULL
  OR jsonb_typeof(f#>'{resource,fields}') IS DISTINCT FROM 'array'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(f#>'{resource,fields}') k WHERE NOT k=ANY(CASE f#>>'{resource,type_key}'
    WHEN 'session_message' THEN ARRAY['id','role','content','sequenceNum','createdAt','senderUserId','senderAssistantId','channelMessageId','attachments']
    WHEN 'session_message_annotation' THEN ARRAY['id','sequenceNum','topicLabel','topicConfidence','replyToText']
    WHEN 'memory' THEN public.application_memory_field_keys() ELSE '{}'::text[] END)))
 THEN reasons:=array_append(reasons,'unsupported_or_missing_field');END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('node',n,'domain',to_jsonb(q)) ORDER BY n::text),'[]') INTO domains
 FROM jsonb_array_elements(nodes) n LEFT JOIN application_query_domains q ON q.workspace_id=w AND q.id=(n->>'id')::uuid
 WHERE n->>'tag'='source' AND n->>'kind'='application_query_domain';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(domains) d WHERE d->>'domain' IS NULL
  OR d#>'{domain,origin}' IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
  OR d#>>'{domain,type_key}' NOT IN('session_message','session_message_annotation','memory')
  OR d#>>'{domain,identity}' IS DISTINCT FROM d#>>'{node,version}'
  OR CASE WHEN d#>>'{domain,type_key}'='memory' THEN
    d#>>'{domain,domain,kind}' IS DISTINCT FROM 'memory_query_domain_v1'
    OR (d#>'{domain,domain}')-ARRAY['kind','fields','bounds','visibility','includeRetained','candidates','policies']<>'{}'
    OR d#>'{domain,domain,candidates}' IS DISTINCT FROM '[]'::jsonb OR d#>'{domain,domain,policies}' IS DISTINCT FROM '[]'::jsonb
   ELSE d#>>'{domain,domain,kind}' IS DISTINCT FROM 'session_query_domain_v1'
    OR (d#>'{domain,domain}')-ARRAY['kind','sessionId','throughSequence','fields','bounds','visibility','parentFingerprint','candidates','points']<>'{}' END)
 THEN reasons:=array_append(reasons,'unsupported_or_missing_domain');END IF;
 -- Strict empty-Memory cohort only. Absence is established in this same snapshot,
 -- not inferred from source ancestry or a formerly empty saved candidate list.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(field_metadata) f WHERE f#>>'{resource,type_key}'='memory')
 AND(NOT(CASE
 WHEN NOT EXISTS(SELECT 1 FROM memories WHERE workspace_id=w) THEN true
 WHEN current_setting('app.agent_shared_audience',true) IS NOT DISTINCT FROM 'true' THEN
  application_memory_statement_helpers_current() IS TRUE
  AND (SELECT count(*)<=4096 AND coalesce(bool_and(private_row.user_id IS NOT NULL),false)
   FROM(SELECT user_id FROM memories WHERE workspace_id=w LIMIT 4097) private_row)
 ELSE false
END)
  OR EXISTS(SELECT 1 FROM application_native_resource_owners WHERE workspace_id=w AND origin='{"kind":"native","moduleKey":"native"}' AND resource_type='memory'))
 THEN reasons:=array_append(reasons,'nonempty_or_owned_memory_cohort');END IF;
 WITH n AS(SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'tag'='source'), rows AS(
 SELECT value node,jsonb_build_object('exists',m.id IS NOT NULL,'id',m.id,'sessionId',m.session_id,'sequence',m.sequence_num,
  'workspaceId',m.workspace_id,'userId',m.user_id,'assistantId',m.assistant_id,'version',m.scope_version,'held',m.scope_held,
  'sensitivity',m.sensitivity,'compartments',m.compartments,'projectIds',m.project_ids) metadata
 FROM n LEFT JOIN session_messages m ON m.workspace_id=w AND m.id=(value->>'id')::uuid WHERE value->>'kind'='session_message'
 UNION ALL SELECT value,jsonb_build_object('exists',r.id IS NOT NULL,'id',r.id,'sessionId',r.session_id,'parentId',r.parent_id,'parentKind',r.parent_kind,
  'workspaceId',r.workspace_id,'userId',r.user_id,'assistantId',r.assistant_id,'version',r.scope_version,'held',r.scope_held,
  'sensitivity',r.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids,
  'contentPresent',EXISTS(SELECT 1 FROM session_context_revision_contents c WHERE c.workspace_id=w AND c.revision_id=r.id),
  'frame',CASE WHEN r.parent_kind='turn_frame' THEN (SELECT to_jsonb(f) FROM native_turn_frames f WHERE f.workspace_id=w AND f.id=r.id) ELSE NULL END)
 FROM n LEFT JOIN session_context_scope_revisions r ON r.workspace_id=w AND r.id=(value->>'id')::uuid WHERE value->>'kind'='session_context_revision'
 UNION ALL SELECT value,jsonb_build_object('exists',f.id IS NOT NULL,'id',f.id,'workspaceId',f.workspace_id,'userId',f.user_id,'assistantId',f.assistant_id,
  'version',f.scope_version,'held',f.scope_held,'sensitivity',f.sensitivity,'compartments',f.compartments,'projectIds',f.project_ids,
  'validTo',f.valid_to,'retractedAt',f.retracted_at,'supersededBy',f.superseded_by,'purpose',f.purpose,'hasDerivation',EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='workspace_file' AND d.resource_id=f.id))
 FROM n LEFT JOIN workspace_files f ON f.workspace_id=w AND f.id=(value->>'id')::uuid WHERE value->>'kind'='workspace_file'

 UNION ALL SELECT value,jsonb_build_object('exists',e.id IS NOT NULL,'id',e.id,'workspaceId',e.workspace_id,'userId',e.user_id,'assistantId',e.assistant_id,
  'version',e.scope_version::text,'held',e.scope_held,'sensitivity',e.sensitivity,'compartments',e.compartments,'projectIds',e.project_ids,
  'validTo',NULL,'retractedAt',NULL,'sourceKind',e.source_kind)
 FROM n LEFT JOIN episodes e ON e.workspace_id=w AND e.id=(value->>'id')::uuid WHERE value->>'kind'='episode'
 UNION ALL SELECT value,jsonb_build_object('exists',r.id IS NOT NULL,'id',r.id,'workspaceId',r.workspace_id,'userId',r.user_id,'assistantId',r.assistant_id,
  'version',r.scope_version::text,'held',r.scope_held,'sensitivity',r.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids,
  'validTo',r.valid_to,'retractedAt',r.retracted_at,'mediaFileId',r.media_file_id,'binding',(SELECT jsonb_build_object(
   'recordingId',b.recording_id,'workspaceId',b.workspace_id,'fileId',b.file_id,'fileVersion',b.file_version,'supersededBy',b.superseded_by)
   FROM recording_intake_bindings b WHERE b.workspace_id=w AND b.recording_id=r.id))
 FROM n LEFT JOIN recordings r ON r.workspace_id=w AND r.id=(value->>'id')::uuid WHERE value->>'kind'='recording'
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('node',node,'metadata',metadata) ORDER BY node::text),'[]') INTO native_metadata FROM rows;
 -- Canonical media is an opaque primitive subtree, never a field/policy shortcut.
 FOR media_node IN SELECT value FROM jsonb_array_elements(native_metadata) n
  WHERE n#>>'{node,kind}' IN('episode','recording') OR n#>>'{metadata,hasDerivation}'='true' LOOP
  IF media_node#>>'{node,kind}'='episode' AND (media_node#>>'{metadata,sourceKind}' IS DISTINCT FROM 'recording'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(native_metadata) peer WHERE peer#>>'{node,kind}'='recording'
    AND peer#>>'{node,id}'=media_node#>>'{node,id}'))
   OR media_node#>>'{node,kind}'='recording' AND (media_node#>'{metadata,binding}' IS NULL OR media_node#>'{metadata,binding}'='null'::jsonb
    OR media_node#>>'{metadata,binding,supersededBy}' IS NOT NULL
    OR media_node#>>'{metadata,binding,fileId}' IS DISTINCT FROM media_node#>>'{metadata,mediaFileId}'
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(native_metadata) peer WHERE peer#>>'{node,kind}'='episode'
     AND peer#>>'{node,id}'=media_node#>>'{node,id}')) THEN
   RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','unsupported_media_metadata');END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO media_lineage
   FROM application_scope_lineage(w,ARRAY[media_node#>>'{node,kind}'],ARRAY[(media_node#>>'{node,id}')::uuid],ARRAY[media_node#>>'{node,version}']) n;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(media_lineage) n WHERE n->>'kind' NOT IN('workspace_file','episode','recording')) THEN
   RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','unsupported_media_ancestry');END IF;
  WITH RECURSIVE physical(n) AS (
   SELECT media_node->'node'
   UNION SELECT e.child FROM physical p JOIN native_retained_graph_edges(graph,false) e ON e.parent=p.n
  ) SELECT coalesce(jsonb_agg(n-'tag' ORDER BY n->>'kind',n->>'id',n->>'version'),'[]') INTO media_graph FROM physical;
  IF media_graph IS DISTINCT FROM media_lineage THEN RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','media_ancestry_coverage');END IF;
 END LOOP;

 IF EXISTS(SELECT 1 FROM jsonb_array_elements(native_metadata) n WHERE n#>>'{metadata,exists}' IS DISTINCT FROM 'true'
  OR n#>>'{node,kind}'='session_context_revision' AND((n#>>'{metadata,parentKind}' NOT IN('message_annotation','turn_frame') OR n#>>'{metadata,parentKind}'='turn_frame' AND native_turn_frame_pair(w,(n#>>'{node,id}')::uuid) IS NOT TRUE) OR n#>>'{metadata,version}' IS DISTINCT FROM '1' OR n#>>'{metadata,contentPresent}' IS DISTINCT FROM 'true')
  OR n#>>'{node,kind}'='workspace_file' AND(n#>>'{metadata,purpose}'='engineering_archive'
   OR EXISTS(SELECT 1 FROM workspace_file_session_bindings b WHERE b.file_id=(n#>>'{node,id}')::uuid)
   OR EXISTS(SELECT 1 FROM office_generation_file_bindings b WHERE b.file_id=(n#>>'{node,id}')::uuid)))
 THEN reasons:=array_append(reasons,'unsupported_native_metadata');END IF;
 WITH ids AS(
 SELECT (q->>'sessionId')::uuid id FROM jsonb_array_elements(selectors) q UNION
 SELECT (p->>'sessionId')::uuid id FROM jsonb_array_elements(privacy_parents) p WHERE p->>'sessionId' IS NOT NULL
 UNION SELECT (d#>>'{domain,domain,sessionId}')::uuid FROM jsonb_array_elements(domains) d WHERE d#>>'{domain,domain,sessionId}' IS NOT NULL
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'exists',s.id IS NOT NULL,'workspaceId',s.workspace_id,'assistantId',s.assistant_id,
  'userId',s.user_id,'visibility',s.visibility,'anchorKind',s.anchor_kind,'anchorRef',s.anchor_ref,'mode',s.mode,'channelType',s.channel_type,
  'channelId',s.channel_id,'appId',s.app_id,'contextGroupId',s.context_group_id,'contextProjectId',s.context_project_id,
  'contextCompartments',s.context_compartments,'effectiveClearance',s.effective_clearance,'recordingHeld',s.recording_privacy_held,'recordingEpoch',recording_epochs->(s.id::text)) ORDER BY i.id),'[]')
 INTO parents FROM ids i LEFT JOIN sessions s ON s.id=i.id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',d.user_id,'assistant_id',d.assistant_id,'sensitivity',d.sensitivity,'compartments',d.compartments,'project_ids',d.project_ids) ORDER BY d.id),'[]') INTO derivations FROM scope_derivations d
 WHERE d.workspace_id=w AND EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'tag'='source' AND n->>'kind'=d.resource_kind AND (n->>'id')::uuid=d.resource_id);
 -- Linear graph operations after source-key materialization; cycles fall back.
 order_json:=native_retained_graph_topology(graph);
 IF order_json IS NULL THEN reasons:=array_append(reasons,'semantic_cycle');END IF;
 context:=jsonb_build_object('workspaceId',w,'actor',actor,'actingAssistant',acting,'sessionUser',session_user,
  'settings',(SELECT jsonb_object_agg(k,current_setting(k,true)) FROM unnest(ARRAY[
  'app.current_user_id','app.agent_actor_id','app.agent_workspace_id','app.agent_clearance','app.agent_compartments',
  'app.agent_project_ids','app.agent_visibility_assistants','app.agent_shared_audience','app.v2_active','app.v2_assistant_id',
  'app.v2_binding','app.v2_cap','app.v2_context_department','app.application_id','app.public_share_root','app.system_bypass']) k));
 counts:=jsonb_build_object('semanticNodes',jsonb_array_length(nodes),'semanticEdges',jsonb_array_length(edges),'privacyNodes',jsonb_array_length(privacy_nodes),
  'privacyEdges',jsonb_array_length(privacy_edges),'points',(SELECT count(*) FROM jsonb_array_elements(nodes) n WHERE n->>'tag'='point'),'domains',jsonb_array_length(domains));
 witness:=jsonb_build_object('context',context,'graph',graph,'privacyGraph',privacy_graph,'nativeMetadata',native_metadata,
  'sessionParents',parents,'derivations',derivations);
 IF discovery THEN RETURN jsonb_build_object('eligibleMetadata',cardinality(reasons)=0,'authorizationEvaluated',false,'payloadSelected',false,
  'reasons',to_jsonb(reasons),'witness',jsonb_build_object('context',context,'nativeMetadata',native_metadata,'sessionParents',parents));END IF;
 RETURN jsonb_build_object('eligibleMetadata',cardinality(reasons)=0,'authorizationEvaluated',false,'payloadSelected',false,
  'reasons',to_jsonb(reasons),'counts',counts,'evaluationOrder',order_json,'witness',witness,
  'hasMemory',EXISTS(SELECT 1 FROM jsonb_array_elements(field_metadata) f WHERE f#>>'{resource,type_key}'='memory'));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN
 RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'payloadSelected',false,'reason','malformed_metadata');
END $function$
