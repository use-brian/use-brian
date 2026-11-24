BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;

-- [COMP:api/delivery-authority] An approved group is a distinct receiver. Check
-- every current parent/topic binding, including those from another active bot.
CREATE FUNCTION public.telegram_knowledge_group_bindings(w uuid,address text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $bindings$
DECLARE
 binding jsonb;
 bindings jsonb:='[]';
 expires timestamptz;
 parent_address text:=split_part(address,':',1);
BEGIN
 PERFORM ci.id FROM channel_integrations ci JOIN channels c ON c.id=ci.channel_id
  WHERE c.workspace_id=w AND ci.channel_type='telegram'
  ORDER BY ci.id FOR SHARE OF c,ci NOWAIT;
 FOR binding IN
  SELECT entry FROM channel_integrations ci JOIN channels c ON c.id=ci.channel_id
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(ci.config->'deliveryAudienceBindings','[]')) entry
  WHERE c.workspace_id=w AND ci.channel_type='telegram' AND ci.status='active' AND c.status='active'
   AND entry->>'version'='1' AND entry->>'channelId' IN (address,parent_address)
 LOOP
  IF binding->'version' IS DISTINCT FROM '1'::jsonb OR binding->>'audienceType' IS DISTINCT FROM 'group'
   OR binding->>'recipientUserId' IS NOT NULL OR sensitivity_rank(binding->>'clearance') IS NULL
   OR jsonb_typeof(binding->'compartments') IS DISTINCT FROM 'array'
   OR jsonb_typeof(binding->'projectIds') IS DISTINCT FROM 'array'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(binding->'compartments') label
    WHERE jsonb_typeof(label)<>'string' OR btrim(label#>>'{}')='')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(binding->'projectIds') project
    WHERE jsonb_typeof(project)<>'string' OR NOT pg_input_is_valid(project#>>'{}','uuid')) THEN RETURN NULL; END IF;
  expires:=(binding->>'expiresAt')::timestamptz;
  IF expires IS NOT NULL AND (NOT isfinite(expires) OR expires<=clock_timestamp()) THEN RETURN NULL; END IF;
  PERFORM 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=(binding->>'approvedByUserId')::uuid
   AND m.role IN ('owner','admin') FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  bindings:=bindings||jsonb_build_array(jsonb_build_object('clearance',binding->'clearance','expires',expires,
   'compartments',binding->'compartments','projects',binding->'projectIds',
   'companyWide',binding->'companyWide'='true'::jsonb AND binding->'compartments'='[]' AND binding->'projectIds'='[]'));
 END LOOP;
 RETURN nullif(bindings,'[]'::jsonb);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $bindings$;

-- The original linked speaker proves the read and the current room proves the
-- recipient. This facade returns only exact immutable evidence and live labels.
CREATE FUNCTION public.capture_verified_telegram_knowledge_evidence(
 w uuid,sid uuid,actor uuid,responder uuid,address text,integration uuid,bot text,epoch bigint,
 envelope_version bigint,lease uuid,speaker text,incoming_id text,roots jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $telegram_knowledge$
DECLARE
 s sessions;
 room conversation_envelopes;
 channel uuid;
 recording_owner uuid;
 deny_assistant uuid;
 bindings jsonb;
 binding jsonb;
 floor_tier text;
 floor_compartments jsonb;
 floor_projects jsonb;
 group_bounds jsonb;
 point_ids uuid[];
 point_versions text[];
 point_proofs jsonb;
 native_origin constant jsonb:='{"kind":"native","moduleKey":"native"}';
 search_fields constant text[]:=ARRAY['content','id','path','sourceId','summary','tags','title'];
 field record;
 root record;
 snapshot jsonb;
 domains jsonb:='[]';
 current_sources jsonb:='[]';
 native_sources jsonb:='[]';
 immutable_sources jsonb:='[]';
BEGIN
 IF num_nulls(w,sid,actor,responder,address,integration,bot,epoch,envelope_version,lease,speaker,incoming_id)<>0
  OR actor IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
  OR actor IS DISTINCT FROM nullif(current_setting('app.agent_actor_id',true),'')::uuid
  OR w IS DISTINCT FROM nullif(current_setting('app.agent_workspace_id',true),'')::uuid
  OR responder IS DISTINCT FROM nullif(current_setting('app.v2_assistant_id',true),'')::uuid
  OR current_setting('app.agent_shared_audience',true) IS DISTINCT FROM 'true'
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR address !~ '^-[0-9]+(:(topic|discussion):[0-9]+)?$'
  OR speaker !~ '^[0-9]+$' OR incoming_id !~ '^[0-9]+$'
  OR roots IS NOT NULL AND (jsonb_typeof(roots) IS DISTINCT FROM 'array' OR jsonb_array_length(roots) NOT BETWEEN 1 AND 4096)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.sessions'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
 THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_to_recordset(roots) AS r(kind text,id uuid,version text)
  WHERE r.kind IS NULL OR r.kind NOT IN ('application_field','knowledge_entry') OR r.id IS NULL OR r.version IS NULL)
  OR (SELECT count(DISTINCT (r.kind,r.id)) FROM jsonb_to_recordset(roots) AS r(kind text,id uuid,version text))<>jsonb_array_length(roots)
 THEN RETURN NULL; END IF;

 PERFORM id FROM workspaces WHERE id=w FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor FOR SHARE NOWAIT;
 IF NOT FOUND OR assistant_placement_visible(actor,responder) IS NOT TRUE THEN RETURN NULL; END IF;
 -- The signed ingress also accepts a linked account routed to another bot
 -- when its human is a member of the current bot's workspace.
 PERFORM 1 FROM linked_identities l WHERE l.provider='telegram' AND l.provider_id=speaker AND l.user_id=actor FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT c.id,ci.recording_owner_user_id INTO channel,recording_owner FROM channel_integrations ci JOIN channels c ON c.id=ci.channel_id
  WHERE ci.id=integration AND ci.channel_type='telegram' AND c.channel_type='telegram' AND c.workspace_id=w
   AND ci.status='active' AND c.status='active' AND ci.bot_user_id=bot AND ci.identity_generation=epoch
  FOR SHARE OF c,ci NOWAIT;
 IF NOT FOUND OR (SELECT ca.assistant_id FROM channel_assistants ca WHERE ca.channel_id=channel
  AND (ca.external_surface_id IS NULL OR ca.external_surface_id IN(address,split_part(address,':',1)))
  ORDER BY CASE WHEN ca.external_surface_id=address THEN 0 WHEN ca.external_surface_id=split_part(address,':',1) THEN 1 ELSE 2 END
  LIMIT 1 FOR SHARE NOWAIT) IS DISTINCT FROM responder THEN RETURN NULL; END IF;

 SELECT * INTO s FROM sessions WHERE workspace_id=w AND id=sid FOR SHARE NOWAIT;
 IF NOT FOUND OR s.channel_type IS DISTINCT FROM 'telegram' OR s.channel_id IS DISTINCT FROM address
  OR s.anchor_kind IS DISTINCT FROM 'channel' OR s.archived_at IS NOT NULL OR s.recording_privacy_held IS TRUE
  OR scope_review_state_held('session',sid) OR s.turn_lease_token IS DISTINCT FROM lease OR s.last_turn_lease_token IS DISTINCT FROM lease
  OR s.status IS DISTINCT FROM 'running' OR s.cancel_requested_at IS NOT NULL OR s.turn_heartbeat_at IS NULL
  OR s.turn_heartbeat_at<=clock_timestamp()-interval '90 seconds' OR coalesce(s.turn_assistant_id,s.assistant_id) IS DISTINCT FROM responder
 THEN RETURN NULL; END IF;
 IF s.recording_revision IS NOT NULL THEN
  PERFORM 1 FROM channel_recording_policies p JOIN workspace_members m ON m.workspace_id=w AND m.user_id=p.owner_user_id
   WHERE p.workspace_id=w AND p.id=s.recording_policy_id AND p.session_id=sid AND p.revision=s.recording_revision
    AND p.enabled AND p.destination='workspace' AND p.integration_id=integration AND p.bot_id=bot AND p.conversation_id=address
    AND p.owner_user_id=recording_owner AND p.owner_user_id=s.user_id
   FOR SHARE OF p,m NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
 ELSIF s.provider_conversation_context IS NOT TRUE OR s.provider_context_generation IS DISTINCT FROM epoch
  OR s.provider_context_identity->>'integrationId' IS DISTINCT FROM integration::text
  OR s.provider_context_identity->>'botId' IS DISTINCT FROM bot
  OR EXISTS(SELECT 1 FROM channel_recording_policies p WHERE p.workspace_id=w AND p.bot_id=bot AND p.conversation_id=address AND NOT p.enabled)
 THEN RETURN NULL; END IF;
 PERFORM 1 FROM session_messages m WHERE m.workspace_id=w AND m.session_id=sid AND m.role='user'
  AND m.sender_user_id=actor AND m.channel_message_id=incoming_id AND NOT m.scope_held
  AND NOT scope_review_state_held('session_message',m.id) FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO room FROM conversation_envelopes WHERE workspace_id=w AND session_id=sid FOR SHARE NOWAIT;
 IF NOT FOUND OR room.visibility IS DISTINCT FROM 'workspace' OR room.version IS DISTINCT FROM envelope_version
  OR room.starter_user_id IS DISTINCT FROM s.user_id OR conversation_member_read_allowed(w,sid,actor) IS NOT TRUE THEN RETURN NULL; END IF;

 bindings:=telegram_knowledge_group_bindings(w,address);
 IF bindings IS NULL THEN RETURN NULL; END IF;
 SELECT CASE WHEN a.kind='primary' THEN NULL ELSE a.id END INTO deny_assistant
 FROM assistants a WHERE a.workspace_id=w AND a.id=responder;
 IF NOT FOUND THEN RETURN NULL; END IF;
 floor_tier:=room.cap;
 floor_compartments:=to_jsonb(room.compartments);
 floor_projects:=to_jsonb(conversation_hard_project_ids(room.compartments));
 FOR binding IN SELECT value FROM jsonb_array_elements(bindings) LOOP
  IF (binding->>'expires')::timestamptz<=clock_timestamp() THEN RETURN NULL; END IF;
  IF sensitivity_rank(binding->>'clearance')<sensitivity_rank(floor_tier) THEN floor_tier:=binding->>'clearance'; END IF;
  IF (binding->>'companyWide')::boolean IS NOT TRUE THEN
   floor_compartments:=application_query_set_intersection(floor_compartments,binding->'compartments');
   floor_projects:=application_query_set_intersection(floor_projects,binding->'projects');
  END IF;
 END LOOP;
 IF roots IS NULL THEN RETURN jsonb_build_object('floor',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,
  'sensitivity',floor_tier,'compartments',floor_compartments,'projectIds',floor_projects)); END IF;
 IF application_knowledge_search_context(w) IS NULL THEN RETURN NULL; END IF;
 group_bounds:=application_query_scope_cap(sensitivity_rank(floor_tier),floor_compartments,floor_projects);
 IF application_query_scope_valid(group_bounds) IS NOT TRUE THEN RETURN NULL; END IF;

 SELECT array_agg(r.id),array_agg(r.version) INTO point_ids,point_versions
 FROM jsonb_to_recordset(roots) AS r(kind text,id uuid,version text)
 JOIN application_field_resources f ON f.workspace_id=w AND f.id=r.id
 WHERE r.kind='application_field' AND f.origin=native_origin AND f.type_key='knowledge_entry'
  AND f.selection='query' AND f.fields=search_fields;
 SELECT coalesce(jsonb_object_agg(p.resource_id::text||':'||p.observation_version,p.snapshot),'{}') INTO point_proofs
 FROM application_knowledge_exact_field_proofs(w,point_ids,point_versions) p;

 FOR field IN
  SELECT r.*,f.resource_id AS parent_id,f.selection,f.origin,f.type_key,f.fields,f.selected_version,
   o.source_scope,o.source_kind,o.source_id,o.source_version,o.owner_id,d.domain,d.identity AS domain_identity
  FROM jsonb_to_recordset(roots) AS r(kind text,id uuid,version text)
  LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=r.id
  LEFT JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=r.id AND o.version=r.version
  LEFT JOIN application_query_domains d ON d.workspace_id=w AND d.id=f.resource_id AND d.origin=native_origin AND d.type_key='knowledge_entry'
  WHERE r.kind='application_field' ORDER BY f.selection DESC,r.id
 LOOP
  IF field.origin IS DISTINCT FROM native_origin OR field.type_key IS DISTINCT FROM 'knowledge_entry'
   OR field.fields IS DISTINCT FROM search_fields OR field.selected_version IS NOT NULL OR field.owner_id IS NOT NULL
   OR field.source_scope IS NULL OR field.source_scope->>'userId' IS NOT NULL OR field.source_scope->>'assistantId' IS NOT NULL
   OR EXISTS(SELECT 1 FROM application_field_observation_sources o WHERE o.workspace_id=w AND o.resource_id=field.id AND o.version=field.version)
   OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='application_field' AND d.resource_id=field.id)
  THEN RETURN NULL; END IF;
  IF field.selection='query_domain' THEN
   IF field.domain->>'kind' IS DISTINCT FROM 'knowledge_search_domain_v1' OR field.domain->>'includeRetained' IS DISTINCT FROM 'false'
    OR field.source_kind IS DISTINCT FROM 'application_query_domain' OR field.source_id IS DISTINCT FROM field.parent_id
    OR field.source_version IS DISTINCT FROM field.domain_identity
    OR field.domain->>'denyAssistantId' IS DISTINCT FROM deny_assistant::text
    OR application_query_scope_union_contains(field.domain->'bounds',jsonb_build_array(group_bounds),4096)->>'contains' IS DISTINCT FROM 'true'
   THEN RETURN NULL; END IF;
   snapshot:=read_admitted_application_field_snapshot(w,field.id,field.version);
   domains:=domains||jsonb_build_array(field.domain);
  ELSIF field.selection='query' THEN
   snapshot:=point_proofs->(field.id::text||':'||field.version);
   IF snapshot IS NULL OR NOT EXISTS(SELECT 1 FROM knowledge_entries k CROSS JOIN LATERAL jsonb_array_elements(domains) d
    WHERE k.workspace_id=w AND k.id=field.source_id AND k.id=field.parent_id AND k.scope_version::text=field.source_version
     AND (k.source_id IS NULL OR NOT (d->'disabledSources') ? k.source_id::text)
     AND application_query_scope_admits_point(d->'bounds',field.source_scope) IS TRUE) THEN RETURN NULL; END IF;
   native_sources:=native_sources||jsonb_build_array(field.source_scope||jsonb_build_object(
    'resourceKind','knowledge_entry','resourceId',field.source_id,'version',field.source_version));
  ELSE RETURN NULL; END IF;
  IF snapshot->>'held' IS DISTINCT FROM 'false' OR snapshot->>'version' IS DISTINCT FROM field.version
   OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL
   OR (snapshot-ARRAY['resourceKind','resourceId','version','held','validTo','retractedAt']) IS DISTINCT FROM field.source_scope
  THEN RETURN NULL; END IF;
  immutable_sources:=immutable_sources||jsonb_build_array(field.source_scope||jsonb_build_object(
   'resourceKind','application_field','resourceId',field.id,'version',field.version));
 END LOOP;
 IF jsonb_array_length(domains)=0 THEN RETURN NULL; END IF;
 FOR root IN SELECT * FROM jsonb_to_recordset(roots) AS r(kind text,id uuid,version text) WHERE kind='knowledge_entry' LOOP
  IF NOT native_sources@>jsonb_build_array(jsonb_build_object('resourceId',root.id,'version',root.version)) THEN RETURN NULL; END IF;
 END LOOP;
 current_sources:=immutable_sources||native_sources;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(bindings) entry WHERE (entry->>'expires')::timestamptz<=clock_timestamp())
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(current_sources) source
   WHERE sensitivity_rank(source->>'sensitivity')>sensitivity_rank(floor_tier)
    OR NOT source->'compartments'<@floor_compartments OR NOT source->'projectIds'<@floor_projects)
 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('current',current_sources,'immutable',immutable_sources);
EXCEPTION WHEN lock_not_available OR invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $telegram_knowledge$;

-- The provider adapter supplies the room floor it just proved in this reader
-- transaction. Intersect it with the original native bounds before scanning or
-- freezing the query domain. The separate port can only narrow the native read.
DO $group_search$
DECLARE
 previous constant regprocedure:='public.read_native_knowledge_search(uuid,uuid,text,integer,boolean,uuid,text,text[],uuid[])'::regprocedure;
 signature constant text:='public.read_native_knowledge_search(w uuid, deny_assistant uuid, query_text text, result_limit integer, restrict_source boolean, requested_source uuid, clearance text, allowed_compartments text[], allowed_projects uuid[])';
 point constant text:=$guard$ IF context IS NULL THEN RETURN NULL; END IF;$guard$;
 definition text;
BEGIN
 IF (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p
  WHERE p.oid=previous AND p.proowner=current_user::regrole::oid AND p.prosecdef)
  IS DISTINCT FROM '7dff36a232c83d82bc32b1248e436ac2bb1328e4759af96789ce72dee07f2d12'
 THEN RAISE EXCEPTION 'telegram_knowledge_search_predecessor_changed'; END IF;
 definition:=pg_get_functiondef(previous);
 IF cardinality(string_to_array(definition,signature))<>2 OR cardinality(string_to_array(definition,point))<>2
 THEN RAISE EXCEPTION 'telegram_knowledge_search_source_changed'; END IF;
 definition:=replace(definition,signature,
  'public.read_native_group_knowledge_search(w uuid, deny_assistant uuid, query_text text, result_limit integer, restrict_source boolean, requested_source uuid, clearance text, allowed_compartments text[], allowed_projects uuid[], verified_group_floor jsonb)');
 EXECUTE replace(definition,point,$guard$ IF context IS NULL THEN RETURN NULL; END IF;
 IF current_setting('app.agent_shared_audience',true) IS DISTINCT FROM 'true'
  OR verified_group_floor->>'workspaceId' IS DISTINCT FROM w::text
  OR verified_group_floor->>'userId' IS NOT NULL OR verified_group_floor->>'assistantId' IS NOT NULL
  OR entity_derivation_envelope_valid(verified_group_floor) IS NOT TRUE THEN RETURN NULL; END IF;
 context:=jsonb_set(context,'{bounds}',application_query_scope_intersection(context->'bounds',application_query_scope_cap(
  sensitivity_rank(verified_group_floor->>'sensitivity'),verified_group_floor->'compartments',verified_group_floor->'projectIds')));
 IF application_query_scope_valid(context->'bounds') IS NOT TRUE THEN RETURN NULL; END IF;$guard$);
END $group_search$;

REVOKE ALL ON FUNCTION public.telegram_knowledge_group_bindings(uuid,text),
 public.capture_verified_telegram_knowledge_evidence(uuid,uuid,uuid,uuid,text,uuid,text,bigint,bigint,uuid,text,text,jsonb),
 public.read_native_group_knowledge_search(uuid,uuid,text,integer,boolean,uuid,text,text[],uuid[],jsonb) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.capture_verified_telegram_knowledge_evidence(uuid,uuid,uuid,uuid,text,uuid,text,bigint,bigint,uuid,text,text,jsonb),
 public.read_native_group_knowledge_search(uuid,uuid,text,integer,boolean,uuid,text,text[],uuid[],jsonb) TO app_user;

COMMIT;
