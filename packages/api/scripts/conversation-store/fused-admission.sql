-- [COMP:api/fused-admission] Fused admission: the compiled members of the capture owner (8289).
-- Source text only. 8289 installs these statements unchanged; the installation
-- authenticator compiles the same text into pg_temp and compares every member.
-- Provenance: derived from the installed canonical bodies of the 8287 chain by exact
-- counted substitutions and anchored cuts (fused-admission prototype, receipt
-- m1-fused-admission-adoption.md), then reduced to the compiled path: no derived
-- fallback, no test switch, no stored requirement. fused-admission-pins.json holds
-- the prosrc sha256 of every canonical body this text compiles or cuts, with fingerprint
-- and object-identifier literals normalized so the digest is installation-independent;
-- the authenticator refuses when one of them changes, so a successor that changes a
-- compiled canonical body must change its compiled form in the same migration.
--
-- Contract of every compiled form: when it returns, its value equals the canonical
-- form's value for the same inputs and state. It raises where the canonical form
-- raises, where the canonical form catches an exception, and on every branch it does
-- not compile (fused_c_decline). capture_conversation_evidence then answers the whole
-- capture with capture_conversation_evidence_generic, the unchanged predecessor body.
--
--   fused_f_capture   statements A (identity, input, policy epoch, context), B (graph,
--                     membership, dispatch, recording privacy, deadline, dag structure,
--                     per-node rows, principal facts), the driver and D (the single
--                     registry fence with the caller's pinned guard fingerprint).
--   fused_c_*         inlinable SQL (no SECURITY DEFINER, no SET, not STRICT): no statement.
--   fused_l_*         compiled leaves: one statement each, with the canonical row locks.
--   fused_f_*         shell helpers and verbatim copies made inlinable.
-- Every member is owner-only and a registry member; app_user executes none of them.
CREATE TYPE fused_node_pre AS (resource jsonb, observation jsonb, review_held boolean,
 obs_sources jsonb, domain_resource jsonb, message_exists boolean,
 derivations jsonb, deriv_entities jsonb, fields text[]);
CREATE FUNCTION fused_c_uuidp(identity text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $u$
BEGIN RETURN (pg_catalog.substr(identity,1,8)||'-'||pg_catalog.substr(identity,9,4)||'-8'||pg_catalog.substr(identity,14,3)||'-8'||pg_catalog.substr(identity,18,3)||'-'||pg_catalog.substr(identity,21,12))::uuid; END $u$;
CREATE FUNCTION fused_f_sst_media(p_kind text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE p_kind WHEN 'memory' THEN 'memories' WHEN 'entity' THEN 'entities'
    WHEN 'entity_link' THEN 'entity_links' WHEN 'task' THEN 'tasks'
    WHEN 'workspace_file' THEN 'workspace_files' WHEN 'episode' THEN 'episodes'
    WHEN 'knowledge_entry' THEN 'knowledge_entries' WHEN 'kb_chunk' THEN 'kb_chunks'
    WHEN 'session_message' THEN 'session_messages'
    WHEN 'feedback_event' THEN 'analytics_events'
    WHEN 'workspace_skill_revision' THEN 'workspace_skill_scope_revisions' END
$function$;
CREATE FUNCTION fused_f_sst_pc(k text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
 SELECT CASE k WHEN 'blueprint_record' THEN 'blueprint_records'
 WHEN 'recording' THEN 'recordings' WHEN 'file_segment' THEN 'file_segments'
 WHEN 'transcript_segment' THEN 'transcript_segments' ELSE fused_f_sst_media(k) END
$function$;
CREATE FUNCTION fused_f_sst_kv(k text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
 SELECT CASE WHEN k='session_context_revision' THEN 'session_context_scope_revisions' ELSE fused_f_sst_pc(k) END
$function$;
CREATE FUNCTION fused_f_sst(k text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
 SELECT CASE WHEN k='knowledge_entry_revision' THEN 'knowledge_entry_scope_revisions' ELSE fused_f_sst_kv(k) END
$function$;
CREATE FUNCTION fused_f_rank(s text) RETURNS integer LANGUAGE sql IMMUTABLE AS $h$
 SELECT CASE s WHEN 'public' THEN 1 WHEN 'internal' THEN 2 WHEN 'confidential' THEN 3 END $h$;
CREATE FUNCTION fused_f_digest(value jsonb) RETURNS text LANGUAGE sql STABLE AS $h$
 SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(value::text,'UTF8')),'hex') $h$;
CREATE FUNCTION fused_f_uuid(identity text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$
 SELECT (pg_catalog.substr(identity,1,8)||'-'||pg_catalog.substr(identity,9,4)||'-8'||pg_catalog.substr(identity,14,3)||'-8'||pg_catalog.substr(identity,18,3)||'-'||pg_catalog.substr(identity,21,12))::uuid $h$;
CREATE FUNCTION fused_f_dept_row_allows(grants jsonb, w uuid, sensitivity text, compartments text[], row_user uuid)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT CASE WHEN w IS NULL OR NOT (grants ? w::text)
    THEN NOT EXISTS (SELECT 1 FROM unnest(coalesce(compartments, '{}'::text[])) AS k WHERE k LIKE 'project:%')
    ELSE coalesce((
    SELECT public.fused_f_rank(sensitivity) IS NOT NULL
       AND (row_user IS NULL OR row_user::text = (g.v ->> 'u'))
       AND CASE WHEN ds.ids IS NULL
                THEN public.fused_f_rank(sensitivity) <= (g.v ->> 'b')::int
                ELSE NOT EXISTS (SELECT 1 FROM unnest(ds.ids) AS d(id)
                                  WHERE NOT coalesce(public.fused_f_rank(sensitivity) <= ((g.v -> 'd') ->> d.id)::int, false))
           END
       AND (jsonb_typeof(g.v -> 'c') IS DISTINCT FROM 'string' OR ds.ids IS NULL OR (g.v ->> 'c') = ANY (ds.ids))
       AND (jsonb_typeof(g.v -> 'k') IS DISTINCT FROM 'array' OR ds.ids IS NULL
            OR ds.ids <@ ARRAY(SELECT jsonb_array_elements_text(g.v -> 'k')))
       AND (ds.projects IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(ds.projects) AS p(id)
              WHERE NOT (coalesce((g.v -> 'p') ? p.id, false) OR coalesce((g.v -> 'o') ? p.id, false))))
       AND (jsonb_typeof(g.v -> 'k') IS DISTINCT FROM 'array' OR ds.projects IS NULL
            OR ds.projects <@ ARRAY(SELECT jsonb_array_elements_text(g.v -> 'k')))
      FROM (SELECT grants -> w::text AS v) g,
           (SELECT array_agg(substr(k, 6)) FILTER (WHERE k LIKE 'team:%') AS ids,
                   array_agg(substr(k, 9)) FILTER (WHERE k LIKE 'project:%') AS projects
              FROM unnest(coalesce(compartments, '{}'::text[])) AS k) ds
  ), false) END
$function$;
CREATE FUNCTION fused_f_member_row_allows(grants jsonb, w uuid, sensitivity text, compartments text[])
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT CASE WHEN jsonb_typeof((grants -> w::text) -> 'v2') = 'object'
    THEN public.fused_f_dept_row_allows(jsonb_build_object(w::text, (grants -> w::text) -> 'v2'), w, sensitivity, compartments, NULL::uuid)
    ELSE NOT EXISTS (SELECT 1 FROM unnest(coalesce(compartments, '{}'::text[])) AS k WHERE k LIKE 'project:%')
      AND coalesce(
      public.fused_f_rank(sensitivity) <= ((grants -> w::text) ->> 'r')::int
      AND (jsonb_typeof((grants -> w::text) -> 'c') = 'null'
           OR (NOT (to_jsonb(coalesce(compartments, '{}'::text[])) @> '[null]'::jsonb)
               AND to_jsonb(coalesce(compartments, '{}'::text[])) <@ ((grants -> w::text) -> 'c'))),
      false)
    END
$function$;
CREATE FUNCTION fused_f_agent_read_scope_allows(row_sensitivity text, row_teams text[], row_projects uuid[])
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE clearance text;
BEGIN
  clearance=nullif(current_setting('app.agent_clearance',true),'');
  IF clearance IS NOT NULL AND (fused_f_rank(clearance) IS NULL OR fused_f_rank(row_sensitivity) IS NULL
    OR fused_f_rank(row_sensitivity)>fused_f_rank(clearance)) THEN RETURN false; END IF;
  RETURN agent_scope_grant_allows('app.agent_compartments',row_teams)
    AND agent_scope_grant_allows('app.agent_project_ids',row_projects::text[]);
END;
$function$;
CREATE FUNCTION fused_f_dept_snapshot(p_actor uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH actor AS (
    SELECT p_actor AS u,
           nullif(current_setting('app.v2_assistant_id', true), '')::uuid AS a,
           nullif(current_setting('app.v2_context_department', true), '') AS c,
           nullif(current_setting('app.v2_binding', true), '')::jsonb AS k,
           CASE WHEN nullif(current_setting('app.v2_cap', true), '') IS NULL THEN 3
                ELSE coalesce(fused_f_rank(current_setting('app.v2_cap', true)), 0) END AS cap
  )
  SELECT coalesce(jsonb_object_agg(m.workspace_id::text, jsonb_build_object(
      'b', least(
             fused_f_rank(CASE WHEN m.role IN ('owner', 'admin') THEN 'confidential' ELSE m.clearance END),
             CASE WHEN actor.a IS NULL THEN 3
                  ELSE coalesce((SELECT fused_f_rank(x.clearance) FROM assistants x
                                  WHERE x.id = actor.a AND x.workspace_id = m.workspace_id), 0) END,
             actor.cap),
      'd', coalesce((
             SELECT jsonb_object_agg(e.department_id::text, least(
                      fused_f_rank(e.clearance),
                      CASE WHEN actor.a IS NULL THEN 3 ELSE coalesce(fused_f_rank(ae.clearance), 0) END,
                      actor.cap))
               FROM department_edges e
               LEFT JOIN department_edges ae
                 ON ae.department_id = e.department_id AND ae.assistant_id = actor.a
                AND (ae.expires_at IS NULL OR ae.expires_at > clock_timestamp())
              WHERE e.workspace_id = m.workspace_id AND e.user_id = actor.u
                AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())), '{}'::jsonb),
      'c', actor.c,
      'k', actor.k,
      'u', actor.u,
      'p', coalesce((
             SELECT jsonb_agg(s.project_id::text ORDER BY s.project_id)
               FROM project_shared_scopes s
              WHERE s.workspace_id = m.workspace_id AND s.status = 'active' AND wk.project_shared_spaces
                AND project_member_live(s.project_id, 'user', actor.u)
                AND (actor.a IS NULL OR project_member_live(s.project_id, 'assistant', actor.a))), '[]'::jsonb),
      'o', coalesce((
             SELECT jsonb_agg(s.project_id::text ORDER BY s.project_id)
               FROM project_shared_scopes s
              WHERE s.workspace_id = m.workspace_id AND s.status = 'active' AND wk.project_shared_spaces
                AND m.role = 'owner'
                AND NOT project_member_live(s.project_id, 'user', actor.u)
                AND (actor.a IS NULL OR project_member_live(s.project_id, 'assistant', actor.a))), '[]'::jsonb))), '{}'::jsonb)
    FROM actor
    JOIN workspace_members m ON m.user_id = actor.u
    JOIN workspaces wk ON wk.id = m.workspace_id AND wk.department_read_v2
$function$;
CREATE FUNCTION fused_f_dept_grants_for(p_actor uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN nullif(current_setting('app.current_user_id',true),'') IS NULL
    OR nullif(current_setting('app.current_user_id',true),'')::uuid=p_actor
    THEN fused_f_dept_snapshot(p_actor) ELSE '{}'::jsonb END
$function$;
CREATE FUNCTION fused_f_dept_grants()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT fused_f_dept_grants_for(nullif(current_setting('app.current_user_id',true),'')::uuid)
$function$;
CREATE FUNCTION fused_f_member_principal_grants(p_actor uuid, mutation boolean, only_workspace uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH departments AS MATERIALIZED (SELECT fused_f_dept_snapshot(p_actor) AS grants)
  SELECT coalesce(jsonb_object_agg(m.workspace_id::text, jsonb_build_object(
      'r', fused_f_rank(CASE WHEN m.role IN ('owner','admin') THEN 'confidential' ELSE m.clearance END),
      'c', to_jsonb(CASE WHEN mutation THEN effective_member_team_compartments(m.user_id, m.workspace_id)
                         ELSE effective_member_read_compartments(m.user_id, m.workspace_id) END),
      'v2', CASE WHEN mutation THEN (departments.grants -> m.workspace_id::text) - 'o'
                 ELSE departments.grants -> m.workspace_id::text END)), '{}'::jsonb)
    FROM workspace_members m CROSS JOIN departments
   WHERE m.user_id = p_actor
     AND (only_workspace IS NULL OR m.workspace_id = only_workspace)
$function$;
CREATE FUNCTION fused_f_member_operation_grants(mutation boolean, only_workspace uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT fused_f_member_principal_grants(nullif(current_setting('app.current_user_id',true),'')::uuid,mutation,only_workspace)
$function$;
CREATE FUNCTION fused_f_turn_key(n jsonb) RETURNS text LANGUAGE sql STABLE AS $k$
 SELECT CASE n->>'tag'
 WHEN 'source' THEN jsonb_build_array('source',n->>'kind',n->>'id',n->>'version')::text
 WHEN 'point' THEN jsonb_build_array('point',n->>'kind',n->>'id',n->'fields')::text
 ELSE NULL END $k$;
CREATE FUNCTION fused_f_adjacent(w uuid, n jsonb) RETURNS TABLE(child jsonb) LANGUAGE sql STABLE AS $a$
 SELECT jsonb_build_object('tag','source','kind',s.source_kind,'id',s.source_id,'version',s.source_version)
  FROM public.scope_derivations d JOIN public.scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
  WHERE n->>'tag'='source' AND n->>'kind' IN('application_field','session_message','session_context_revision','application_query_domain','private_transcript')
   AND d.workspace_id=w AND d.resource_kind=n->>'kind' AND d.resource_id=(n->>'id')::uuid
 UNION SELECT jsonb_build_object('tag','source','kind',o.source_kind,'id',o.source_id,'version',o.source_version)
  FROM public.application_field_observations o WHERE n->>'tag'='source' AND n->>'kind'='application_field' AND o.workspace_id=w AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version'
 UNION SELECT jsonb_build_object('tag','source','kind',o.source_kind,'id',o.source_id,'version',o.source_version)
  FROM public.application_field_observation_sources o WHERE n->>'tag'='source' AND n->>'kind'='application_field' AND o.workspace_id=w AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version'
 UNION SELECT jsonb_build_object('tag','point','kind',r.type_key,'id',r.resource_id,'fields',r.fields)
  FROM public.application_field_resources r WHERE n->>'tag'='source' AND n->>'kind'='application_field'
   AND r.workspace_id=w AND r.id=(n->>'id')::uuid AND r.origin='{"kind":"native","moduleKey":"native"}'
   AND r.type_key IN('session_message','session_message_annotation') AND r.selection IN('query','identity','read') AND r.selected_version IS NULL
 UNION SELECT jsonb_build_object('tag','point','kind',q.type_key,'id',m.id,'fields',q.domain->'fields')
  FROM public.application_query_domains q JOIN public.session_messages m ON m.workspace_id=w AND m.session_id=(q.domain->>'sessionId')::uuid
   AND m.sequence_num<=(q.domain->>'throughSequence')::integer
  WHERE n->>'tag'='source' AND n->>'kind'='application_query_domain' AND q.workspace_id=w AND q.id=(n->>'id')::uuid
   AND q.origin='{"kind":"native","moduleKey":"native"}' AND q.type_key IN('session_message','session_message_annotation')
 UNION SELECT jsonb_build_object('tag','source','kind','session_message','id',m.id,'version',m.scope_version::text)
  FROM public.session_messages m WHERE n->>'tag'='point' AND m.workspace_id=w AND m.id=(n->>'id')::uuid
 UNION SELECT jsonb_build_object('tag','source','kind','session_context_revision','id',r.id,'version',r.scope_version::text)
  FROM public.session_message_annotation_heads h JOIN public.session_context_scope_revisions r ON r.workspace_id=w AND r.id=h.scope_revision_id
   AND r.session_id=h.session_id AND r.parent_kind='message_annotation' AND r.parent_id=h.message_id
  WHERE n->>'tag'='point' AND n->>'kind'='session_message_annotation' AND h.workspace_id=w AND h.message_id=(n->>'id')::uuid
$a$;
CREATE FUNCTION fused_f_visible(facts jsonb, w uuid, s jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fa_body$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 teams text[]; projects uuid[]; grants jsonb; v2 boolean;
BEGIN
 IF actor IS NULL OR jsonb_typeof(s)<>'object' OR s->>'workspaceId' IS DISTINCT FROM w::text
  OR NOT(s ?& ARRAY['sensitivity','compartments','projectIds','userId','assistantId'])
  OR coalesce(s->>'sensitivity','') NOT IN('public','internal','confidential')
  OR jsonb_typeof(s->'compartments') IS DISTINCT FROM 'array'
  OR jsonb_typeof(s->'projectIds') IS DISTINCT FROM 'array'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'compartments') x WHERE jsonb_typeof(x)<>'string')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'projectIds') x WHERE jsonb_typeof(x)<>'string')
  OR (s->>'userId' IS NOT NULL AND s->>'userId'<>actor::text)
  OR (s->>'userId' IS NOT NULL AND current_setting('app.agent_shared_audience',true)='true')
  OR NOT (CASE WHEN facts->>'w'=w::text AND facts->>'actor'=actor::text THEN (facts->>'member')::boolean
    ELSE EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) END)
  THEN RETURN false; END IF;
 teams:=ARRAY(SELECT jsonb_array_elements_text(s->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(s->'projectIds')::uuid);
 IF agent_visibility_allows(w,(s->>'userId')::uuid,(s->>'assistantId')::uuid) IS NOT TRUE
  OR agent_scope_grant_allows('app.agent_project_ids',projects::text[]) IS NOT TRUE THEN RETURN false; END IF;
 IF facts->>'w'=w::text THEN v2:=(facts->>'v2')::boolean; ELSE SELECT department_read_v2 INTO v2 FROM workspaces WHERE id=w; END IF;
 IF v2 THEN
  grants:=CASE WHEN facts->>'actor'=actor::text AND facts ? 'dept' THEN facts->'dept' ELSE fused_f_dept_grants() END;
  IF NOT(grants ? w::text) OR fused_f_dept_row_allows(grants,w,s->>'sensitivity',teams,(s->>'userId')::uuid) IS NOT TRUE THEN RETURN false; END IF;
  IF nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL
    AND current_setting('app.v2_active',true) IS DISTINCT FROM 'true'
    AND nullif(current_setting('app.v2_assistant_id',true),'') IS NULL THEN
   IF cardinality(teams)>0 AND nullif(current_setting('app.agent_compartments',true),'') IS NULL THEN RETURN false; END IF;
   IF fused_f_agent_read_scope_allows(s->>'sensitivity',teams,projects) IS NOT TRUE THEN RETURN false; END IF;
  END IF;
 ELSE
  IF fused_f_member_row_allows(CASE WHEN facts->>'w'=w::text AND facts->>'actor'=actor::text AND facts ? 'ops' THEN facts->'ops' ELSE fused_f_member_operation_grants(false,w) END,w,s->>'sensitivity',teams) IS NOT TRUE
    OR fused_f_agent_read_scope_allows(s->>'sensitivity',teams,projects) IS NOT TRUE THEN RETURN false; END IF;
 END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $fa_body$;
CREATE FUNCTION fused_f_dag(facts jsonb, w uuid, p_nodes jsonb, p_edges jsonb, p_positions jsonb, p_positions_bad boolean,
 p_reverse_edges jsonb, p_degrees integer[], p_children jsonb, p_slots jsonb, p_deadline timestamptz, p_privacy_count bigint, p_privacy_denied jsonb,
 p_archive_count bigint, p_archive_denied jsonb, p_recording boolean, p_pre fused_node_pre[]) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET plan_cache_mode=force_generic_plan AS $fa_body$
DECLARE fa_r jsonb;fa_j integer;fa_k integer;fa_c jsonb;fa_os application_field_observation_sources;fa_sd scope_derivations;seeds jsonb;nodes jsonb;edges jsonb;children jsonb;memo jsonb:='{}';slots jsonb;completed jsonb[];flat jsonb;privacy jsonb;
 current_node jsonb;k text;kind text;node_id uuid;node_version text;entity_id uuid;result jsonb;source jsonb;node_value jsonb;envelope jsonb;valid boolean;
 positions jsonb;reverse_edges jsonb;degree_map jsonb;degrees integer[];queue integer[]:='{}';cursor_index integer:=1;item integer;parent_index integer;node_count integer;
 resource application_field_resources;observation application_field_observations;fields text[];dependency record;policy jsonb;mask jsonb;type_key text;deadline timestamptz;
BEGIN
 nodes:=p_nodes;edges:=p_edges;
 IF jsonb_array_length(nodes)>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 IF jsonb_array_length(edges)>65536 OR pg_column_size(nodes)+pg_column_size(edges)>16777216 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 -- Intern the existing node set once. The old graph facade sorted, repacked
 -- and decoded the same nodes/edges before constructing this dependency queue.
 node_count:=jsonb_array_length(nodes);
 positions:=p_positions;
 IF p_positions_bad THEN
  RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 reverse_edges:=p_reverse_edges;degrees:=p_degrees;
 FOR item IN 1..node_count LOOP IF degrees[item]=0 THEN queue:=array_append(queue,item);END IF;END LOOP;
 WHILE cursor_index<=cardinality(queue) LOOP
  item:=queue[cursor_index];cursor_index:=cursor_index+1;
  FOR fa_j IN 0..jsonb_array_length(coalesce(reverse_edges->item::text,'[]'))-1 LOOP parent_index:=(coalesce(reverse_edges->item::text,'[]')->>fa_j)::integer;
   degrees[parent_index]:=degrees[parent_index]-1;
   IF degrees[parent_index]=0 THEN queue:=array_append(queue,parent_index);END IF;
  END LOOP;
 END LOOP;
 IF cardinality(queue)<>node_count THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 children:=p_children;
 deadline:=p_deadline;
 IF p_privacy_count>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 IF p_archive_count>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 privacy:=jsonb_build_object('denied',p_privacy_denied,'archiveDenied',p_archive_denied,'recordingEligible',p_recording);
 memo:=jsonb_build_object('privacyDenied',privacy->'denied','archiveDenied',privacy->'archiveDenied','recordingEligible',privacy->'recordingEligible','validUntil',deadline,'hasExternal',false,
  'points','{}'::jsonb,'domains','{}'::jsonb,'envelopes','{}'::jsonb,'current','{}'::jsonb);
 -- Expanded PostgreSQL arrays update completed slots without copying every
 -- earlier point, envelope and source at each graph vertex.
 slots:=p_slots;
 completed:=array_fill(NULL::jsonb,ARRAY[jsonb_array_length(nodes)*2]);
 FOREACH item IN ARRAY queue LOOP
  current_node:=nodes->(item-1);k:=fused_f_turn_key(current_node);kind:=current_node->>'kind';node_id:=(current_node->>'id')::uuid;node_version:=current_node->>'version';node_value:=NULL;source:=NULL;envelope:=NULL;
  IF current_node->>'tag'='point' THEN
   fields:=p_pre[item].fields;
   IF NOT (memo->'privacyDenied') ? ('application_field:'||fused_c_uuidp(fused_f_digest(jsonb_build_object(
    'workspaceId',w,'origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey',kind,'id',node_id,
    'selection','query','selectedVersion',NULL,'fields',fields,'fieldIdentity',fused_f_digest(jsonb_build_object('kind','session_field_v1','type',kind,'fields',fields)))))) THEN
    IF kind='session_message' THEN result:=fused_l_point(facts,w,kind,node_id,fields,memo,slots,completed);node_value:=result->'value'; ELSE RAISE EXCEPTION 'fused_admission_declined' USING ERRCODE='P0001'; END IF;
   END IF;
   completed[(slots->>('points:'||jsonb_build_array(kind,node_id,fields)::text))::integer]:=node_value;
   IF kind IN('session_message','session_message_annotation') THEN envelope:=fused_l_envelope_session(facts,w,kind,node_id,'query',fields,memo,slots,completed)->'value'; ELSE RAISE EXCEPTION 'fused_admission_declined' USING ERRCODE='P0001'; END IF;
   completed[(slots->>('envelopes:'||jsonb_build_array(kind,node_id,fields)::text))::integer]:=envelope;
  ELSIF kind='application_field' THEN
   fa_r:=NULL;resource:=jsonb_populate_record(NULL::application_field_resources,p_pre[item].resource);observation:=jsonb_populate_record(NULL::application_field_observations,p_pre[item].observation);
   IF resource.id IS NOT NULL AND observation.resource_id IS NOT NULL AND NOT p_pre[item].review_held THEN
    IF resource.origin='{"kind":"native","moduleKey":"native"}' AND (resource.type_key IN('session_message','session_message_annotation')
     OR resource.type_key='memory' AND resource.selection IN('read','query','identity','query_domain')) THEN
     IF resource.selected_version IS NULL THEN
      IF resource.type_key='memory' AND resource.selection='query_domain' THEN
       fa_r:=fused_l_envelope_memory(facts,w,resource.type_key,resource.resource_id,resource.selection,resource.fields,memo,observation.source_scope);envelope:=fa_r->'value';
      ELSIF resource.type_key IN('session_message','session_message_annotation') THEN
       fa_r:=fused_l_envelope_session(facts,w,resource.type_key,resource.resource_id,resource.selection,resource.fields,memo,slots,completed,observation.source_scope);envelope:=fa_r->'value';
      ELSE RAISE EXCEPTION 'fused_admission_declined' USING ERRCODE='P0001'; END IF;
      valid:=envelope IS NOT NULL AND envelope->>'identity'=resource.identity
       AND (envelope#>>'{state,policyVersion}'=observation.policy_version
        OR resource.type_key='memory' AND envelope#>>'{state,legacyPolicyVersion}'=observation.policy_version)
       AND CASE WHEN fa_r ? 'fa_vis' THEN (fa_r->'fa_vis'->>0)::boolean AND (fa_r->'fa_vis'->>1)::boolean ELSE fused_f_visible(facts,w,observation.source_scope) AND fused_f_visible(facts,w,envelope->'source') END;
      FOR fa_k IN 0..jsonb_array_length(p_pre[item].obs_sources)-1 LOOP fa_os:=jsonb_populate_record(NULL::application_field_observation_sources,p_pre[item].obs_sources->fa_k);dependency:=fa_os;
       IF dependency.source_kind='application_field' THEN source:=completed[(slots->>('field:'||dependency.source_id||':'||dependency.source_version))::integer]->'value';
       ELSE source:=completed[(slots->>('current:external_source:'||dependency.source_id||':'||dependency.source_version))::integer];END IF;
       IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR dependency.source_kind='external_source' AND source->>'version' IS DISTINCT FROM dependency.source_version THEN valid:=false;END IF;
      END LOOP;
      IF valid THEN node_value:=(envelope->'source')||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);END IF;
     END IF;
    ELSE node_value:=application_recorded_field_state_before_session_eval(w,node_id,node_version,0);END IF;
   END IF;
   completed[(slots->>('field:'||node_id||':'||node_version))::integer]:=jsonb_build_object('value',node_value,'envelope',envelope,'external','[]'::jsonb);
  ELSIF kind='application_query_domain' THEN
   resource:=jsonb_populate_record(NULL::application_field_resources,p_pre[item].domain_resource);
   IF resource.origin='{"kind":"native","moduleKey":"native"}' AND resource.type_key IN('session_message','session_message_annotation') THEN
    result:=fused_l_domain(facts,w,resource.type_key,node_id,resource.fields,memo,slots,completed);
    completed[(slots->>('domains:'||node_id))::integer]:=result-'memo';
   END IF;
  ELSE
   valid:=true;
   IF (memo->'privacyDenied') ? (kind||':'||node_id) THEN valid:=false;
   ELSIF kind='external_source' THEN
    source:=external_source_snapshot(w,node_id);valid:=source IS NOT NULL AND source->>'held'='false' AND source->>'version'=node_version;
   ELSIF kind='session_message' THEN
    source:=fused_l_message_snapshot(facts,w,node_id,memo->'archiveDenied');valid:=source IS NOT NULL AND source->>'held'='false'
     OR NOT p_pre[item].message_exists;
   ELSIF kind='session_context_revision' THEN
    source:=conversation_revision_snapshot(w,node_id,memo->'archiveDenied');valid:=source IS NOT NULL AND source->>'held'='false';
   ELSIF fused_f_sst(kind) IS NOT NULL OR kind IN('private_transcript','crm_event','page_event_changed','page_event_destination','page_live_changed','page_live_destination') THEN
    IF kind='private_transcript' THEN source:=fused_l_transcript(w,node_id); ELSE source:=read_admitted_native_scope_snapshot(w,kind,node_id); END IF;
    IF kind IN('session_context_revision','crm_event','private_transcript') AND source IS NULL OR source IS NOT NULL AND source->>'held' IS DISTINCT FROM 'false' THEN valid:=false;END IF;
    IF kind='private_transcript' AND source->>'version' IS DISTINCT FROM node_version THEN valid:=false;END IF;
   END IF;
   FOR fa_j IN 0..jsonb_array_length(coalesce(children->k,'[]'))-1 LOOP CONTINUE WHEN (children->k->fa_j)->>'tag' IS DISTINCT FROM 'source'; fa_c:=children->k->fa_j;
    IF fa_c->>'kind'='application_field' THEN
     IF completed[(slots->>('field:'||(fa_c->>'id')||':'||(fa_c->>'version')))::integer]#>>'{value,held}' IS DISTINCT FROM 'false' THEN valid:=false;END IF;
    ELSIF fa_c->>'kind'<>'application_query_domain' AND completed[(slots->>('native:'||(fa_c->>'kind')||':'||(fa_c->>'id')||':'||(fa_c->>'version')))::integer]->>'value' IS DISTINCT FROM 'true' THEN valid:=false;END IF;
   END LOOP;
   FOR fa_k IN 0..jsonb_array_length(p_pre[item].derivations)-1 LOOP fa_sd:=jsonb_populate_record(NULL::scope_derivations,p_pre[item].derivations->fa_k);dependency:=fa_sd;
    IF nullif(current_setting('app.application_id',true),'') IS NOT NULL OR fused_f_visible(facts,w,jsonb_build_object('workspaceId',w,
     'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,'compartments',dependency.compartments,'projectIds',dependency.project_ids)) IS NOT TRUE THEN valid:=false;END IF;
    FOR fa_j IN 0..jsonb_array_length(coalesce(p_pre[item].deriv_entities->(dependency.id::text),'[]'))-1 LOOP
     type_key:=p_pre[item].deriv_entities->(dependency.id::text)->fa_j->>0;entity_id:=(p_pre[item].deriv_entities->(dependency.id::text)->fa_j->>1)::uuid;
     policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}',type_key,entity_id::text);
     IF policy->>'registered' IS DISTINCT FROM 'false' THEN
      mask:=application_current_native_field_policy(w,'{"kind":"native","moduleKey":"native"}',type_key,entity_id);
      IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' OR mask->>'held' IS DISTINCT FROM 'false'
       OR NOT coalesce(policy#>'{metadata,fieldKeys}'<@(mask->'readFields'),false) THEN valid:=false;END IF;
     END IF;
    END LOOP;
   END LOOP;
   node_id:=(current_node->>'id')::uuid;
   completed[(slots->>('native:'||kind||':'||node_id||':'||node_version))::integer]:=jsonb_build_object('value',valid,'external','[]'::jsonb);
   completed[(slots->>('current:'||kind||':'||node_id||':'||node_version))::integer]:=source;
  END IF;
 END LOOP;
 IF clock_timestamp()>=deadline THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('memo',memo,'completed',to_jsonb(completed));
END $fa_body$;
CREATE FUNCTION fused_f_capture(w uuid, roots jsonb, authority jsonb, cohorts jsonb, guard_pin text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET plan_cache_mode=force_generic_plan AS $fa_body$
DECLARE fa_roots_in jsonb:=roots;fa_sel_valid jsonb;fa_memory_ids uuid[];fa_mid uuid;fa_identity_bad boolean;fa_roots_null boolean;fa_roots_invalid boolean;fa_roots_qd boolean;fa_history_root boolean;
 fa_unsupported boolean;fa_memory_qd boolean;fa_selectors jsonb;fa_selector jsonb;fa_k integer;fa_m integer;fa_privacy_count bigint;fa_privacy_denied jsonb;fa_session_ids jsonb;
 fa_archive_count bigint;fa_archive_denied jsonb;fa_recording_candidates boolean;fa_recording boolean;fa_deadline timestamptz;fa_positions jsonb;fa_positions_bad boolean;
 fa_reverse_edges jsonb;fa_degrees integer[];fa_children jsonb;fa_slots jsonb;fa_pre fused_node_pre[];fa_out jsonb;fa_completed jsonb;
 fa_pin_ok boolean;fa_guard boolean;fa_closure_ok boolean;fa_ctx_now jsonb;fa_policy_now jsonb;fa_mem_now jsonb;
 graph jsonb;facts jsonb;physical jsonb;memo jsonb;n jsonb;source jsonb;immutable jsonb:='[]';currents jsonb:='[]';observation application_field_observations;key text;context jsonb;policy_revision jsonb;dependency record;authority_facts jsonb;groups jsonb;membership jsonb;cohort integer;proofs jsonb:='[]';selector record;candidate record;candidate_sources jsonb:='[]';attempts integer:=0;
BEGIN
 -- Statement A: identity, input validation, policy epoch and context.
 -- Cohorts: the canonical validation and union (identity first, as the canonical owner orders it).
 IF cohorts IS NOT NULL THEN IF nullif(current_setting('app.current_user_id',true),'') IS NULL OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF; END IF;
 IF cohorts IS NOT NULL THEN
  IF roots IS NOT NULL OR authority IS NOT NULL OR jsonb_typeof(cohorts) IS DISTINCT FROM 'array'
   OR jsonb_array_length(cohorts)<>2 THEN RAISE EXCEPTION 'invalid_scope_source' USING ERRCODE='22023';END IF;
  FOR groups IN SELECT value FROM jsonb_array_elements(cohorts) LOOP
   IF jsonb_typeof(groups) IS DISTINCT FROM 'array' OR jsonb_array_length(groups) NOT BETWEEN 1 AND 4096
   THEN RAISE EXCEPTION 'invalid_scope_source' USING ERRCODE='22023';END IF;
  END LOOP;
  SELECT jsonb_agg(DISTINCT item.node) INTO roots FROM jsonb_array_elements(cohorts) g CROSS JOIN jsonb_array_elements(g) item(node);
 END IF;
 SELECT fa_i.bad,fa_r.shape_null,fa_v.invalid,fa_q.qd,fa_h.history,fa_x.policy,fa_x.ctx
 INTO fa_identity_bad,fa_roots_null,fa_roots_invalid,fa_roots_qd,fa_history_root,policy_revision,context
 FROM (SELECT nullif(current_setting('app.current_user_id',true),'') IS NULL OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) bad) fa_i
 CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(roots)='array' THEN jsonb_array_length(roots) NOT BETWEEN 1 AND 4096 ELSE true END shape_null) fa_r
 CROSS JOIN LATERAL (SELECT CASE WHEN NOT fa_r.shape_null THEN EXISTS(SELECT 1 FROM jsonb_array_elements(roots) AS input(root) WHERE jsonb_typeof(input.root) IS DISTINCT FROM 'object' OR input.root-ARRAY['kind','id','version']<>'{}'
  OR NOT input.root ?& ARRAY['kind','id','version'] OR jsonb_typeof(input.root->'kind') IS DISTINCT FROM 'string'
  OR jsonb_typeof(input.root->'version') IS DISTINCT FROM 'string' OR length(input.root->>'version') NOT BETWEEN 1 AND 256
  OR jsonb_typeof(input.root->'id') IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(input.root->>'id','uuid')) END invalid) fa_v
 CROSS JOIN LATERAL (SELECT CASE WHEN fa_v.invalid IS FALSE THEN EXISTS(SELECT 1 FROM jsonb_array_elements(roots) root WHERE root->>'kind'='application_query_domain') END qd) fa_q
 CROSS JOIN LATERAL (SELECT CASE WHEN fa_q.qd IS FALSE AND cohorts IS NULL THEN jsonb_array_length(roots)=1 AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=(roots->0->>'id')::uuid
  AND roots->0->>'kind'='application_field' AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') END history) fa_h
 CROSS JOIN LATERAL (SELECT (SELECT jsonb_build_array(c.revision,p.revision)
  FROM application_policy_contract_epoch c CROSS JOIN application_policy_workspace_epochs p
  WHERE c.singleton AND p.workspace_id=w) policy,(SELECT jsonb_build_object('sessionUser',session_user,'currentUser',current_user,'settings',(SELECT jsonb_object_agg(k,current_setting(k,true)) FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']::text[]) k))) ctx) fa_x;
 IF fa_identity_bad THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 groups:=coalesce(cohorts,jsonb_build_array(roots));
 IF fa_roots_null THEN PERFORM fused_f_fence(guard_pin); RETURN NULL;END IF;
 IF fa_roots_invalid THEN RAISE EXCEPTION 'invalid_scope_source' USING ERRCODE='22023';END IF;
 IF fa_roots_qd THEN PERFORM fused_f_fence(guard_pin); RETURN NULL;END IF;
 IF policy_revision IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF fa_history_root THEN RETURN '{"fusedRoute":"generic"}'::jsonb;END IF;
 -- One acquisition: membership is projected from the same adjacency conversation_dag evaluates.
 -- Statement B: dispatch, recording privacy, recording-scope candidates, deadline, dag structure, per-node rows.
 SELECT fa_gr.graph,fa_mb.membership,fa_p.physical,fa_d.unsupported,fa_d.memory_qd,fa_d.selectors,
  fa_pv.node_count,fa_pv.denied,fa_pv.session_ids,fa_pv.archive_count,fa_pv.archive_denied,fa_rc.candidates,fa_dl.deadline,
  fa_st.positions,fa_st.positions_bad,fa_st.reverse_edges,fa_st.degrees,fa_st.children,fa_st.slots,fa_pf.pre,fa_sv.sel_valid,fa_sv.memory_ids,
  (SELECT fa_cf.f FROM fused_c_facts4(w,fa_d.memory_qd) fa_cf)
 INTO graph,membership,physical,fa_unsupported,fa_memory_qd,fa_selectors,fa_privacy_count,fa_privacy_denied,fa_session_ids,fa_archive_count,fa_archive_denied,fa_recording_candidates,
  fa_deadline,fa_positions,fa_positions_bad,fa_reverse_edges,fa_degrees,fa_children,fa_slots,fa_pre,fa_sel_valid,fa_memory_ids,facts
 FROM (SELECT fa_g0.graph FROM fused_f_graph_t(w,roots) fa_g0 OFFSET 0) fa_gr
 CROSS JOIN LATERAL (SELECT CASE WHEN fa_gr.graph->>'supported' IS DISTINCT FROM 'true' THEN '[]'::jsonb WHEN cohorts IS NULL THEN fa_gr.graph->'membership'
   ELSE (SELECT fa_cm.m FROM fused_f_cohort_membership(groups,fa_gr.graph->'edges') fa_cm) END membership,
  CASE WHEN fa_gr.graph->>'supported'='true' THEN fa_gr.graph->'nodes' ELSE '[]'::jsonb END nodes,
  CASE WHEN fa_gr.graph->>'supported'='true' THEN fa_gr.graph->'edges' ELSE '[]'::jsonb END edges OFFSET 0) fa_mb
 CROSS JOIN LATERAL (SELECT coalesce(jsonb_agg(DISTINCT member.node-'cohort'),'[]') physical FROM jsonb_array_elements(fa_mb.membership) member(node) OFFSET 0) fa_p
 CROSS JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(fa_p.physical) x WHERE x->>'kind' NOT IN('application_field','application_query_domain','session_message','session_context_revision','memory','workspace_file','episode','recording','private_transcript'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(fa_p.physical) x JOIN application_field_resources f ON f.workspace_id=w AND f.id=(x->>'id')::uuid
   WHERE x->>'kind'='application_field' AND (f.origin IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
    OR f.type_key NOT IN('session_message','session_message_annotation','memory') OR f.type_key='memory' AND f.selection='history')) unsupported,EXISTS(SELECT 1 FROM jsonb_array_elements(fa_p.physical) x JOIN application_field_resources f
  ON f.workspace_id=w AND f.id=(x->>'id')::uuid WHERE x->>'kind'='application_field'
  AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='query_domain') memory_qd,
  (SELECT coalesce(jsonb_agg(fa_sel.domain),'[]') FROM (SELECT DISTINCT q.domain FROM jsonb_to_recordset(fa_p.physical) n(kind text,id uuid,version text)
   JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id AND n.kind='application_field'
   JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=f.id AND o.version=n.version
   JOIN application_query_domains q ON q.workspace_id=w AND q.id=f.resource_id AND q.type_key=f.type_key AND q.origin=f.origin
   WHERE f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='query_domain') fa_sel) selectors OFFSET 0) fa_d
 CROSS JOIN LATERAL (SELECT (SELECT coalesce(jsonb_agg((SELECT v FROM fused_c_scope_valid(x.value->'bounds')) ORDER BY x.ord),'[]') FROM jsonb_array_elements(fa_d.selectors) WITH ORDINALITY x(value,ord)) sel_valid,
  CASE WHEN fa_d.memory_qd THEN (SELECT coalesce(array_agg(fa_mm.id ORDER BY fa_mm.id),'{}') FROM memories fa_mm WHERE fa_mm.workspace_id=w) END memory_ids) fa_sv
 CROSS JOIN LATERAL fused_f_privacy(w,fa_mb.nodes) fa_pv
 CROSS JOIN LATERAL fused_f_recording_candidates(w,fa_pv.session_ids) fa_rc
 CROSS JOIN LATERAL fused_f_deadline(w,fa_mb.nodes) fa_dl
 CROSS JOIN LATERAL fused_f_structure(fa_mb.nodes,fa_mb.edges) fa_st
 CROSS JOIN LATERAL fused_f_prefetch(w,fa_mb.nodes) fa_pf;

 IF graph->>'supported' IS DISTINCT FROM 'true' THEN RETURN '{"fusedRoute":"generic"}'::jsonb;END IF;
 IF jsonb_array_length(membership)>8192 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 IF jsonb_array_length(physical)>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 -- Separate purpose/family adapters own independent source receipts and Memory
 -- history qualification. This operation does not speculate through those APIs.
 IF fa_unsupported THEN PERFORM fused_f_fence(guard_pin); RETURN NULL;END IF;
 -- Stored result ancestry omits source-denied semantic candidates. Preserve
 -- the Memory family's complete-current-cohort discovery before claiming a
 -- native proof; metadata alone cannot substitute for external admission.
 IF fa_memory_qd THEN
  -- The canonical closure already owns ancestry. The old cohort facade
  -- walked it again through a 100-root API and refused larger valid captures.
  FOR fa_k IN 0..jsonb_array_length(fa_selectors)-1 LOOP fa_selector:=fa_selectors->fa_k;
   IF fa_selector->>'kind' IS DISTINCT FROM 'memory_query_domain_v1' OR (fa_sel_valid->>fa_k)::boolean IS NOT TRUE
   THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
   IF fa_selector->>'includeRetained' IS DISTINCT FROM 'true' THEN CONTINUE;END IF;
   FOREACH fa_mid IN ARRAY fa_memory_ids LOOP
    attempts:=attempts+1;IF attempts>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
    source:=read_scope_source(w,'memory',fa_mid);
    IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR application_query_scope_admits_point(fa_selector->'bounds',source) IS NOT TRUE THEN CONTINUE;END IF;
    candidate_sources:=candidate_sources||jsonb_build_array(jsonb_build_object('kind','memory','id',fa_mid,'version',source->'version'));
   END LOOP;
  END LOOP;
  IF jsonb_array_length(candidate_sources)>0 THEN FOR dependency IN SELECT array_agg(cohort_source.node->>'kind') kinds,
   array_agg((cohort_source.node->>'id')::uuid) ids,array_agg(cohort_source.node->>'version') versions
   FROM jsonb_array_elements(candidate_sources) WITH ORDINALITY cohort_source(node,ord)
   GROUP BY (cohort_source.ord-1)/100 LOOP
   IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,dependency.kinds,dependency.ids,dependency.versions)) THEN PERFORM fused_f_fence(guard_pin); RETURN NULL;END IF;
  END LOOP; END IF;
 END IF;
 -- Principal facts were read once in statement B; every verdict is evaluated in the statement that uses it.
 IF fa_recording_candidates THEN fa_recording:=conversation_recording_scope(w,fa_session_ids); ELSE fa_recording:=true; END IF;
 fa_out:=fused_f_dag(facts,w,graph->'nodes',graph->'edges',fa_positions,fa_positions_bad,fa_reverse_edges,fa_degrees,fa_children,fa_slots,fa_deadline,
  fa_privacy_count,fa_privacy_denied,fa_archive_count,fa_archive_denied,fa_recording,fa_pre);
 memo:=fa_out->'memo';fa_completed:=fa_out->'completed';
 -- A denied semantic query candidate can become readable through an independent
 -- source. Its coordinator must reevaluate that complete candidate cohort.
 IF memo->>'hasExternal'='true' OR memo->>'recordingEligible' IS DISTINCT FROM 'true' THEN PERFORM fused_f_fence(guard_pin); RETURN NULL;END IF;
 FOR cohort IN 1..jsonb_array_length(groups) LOOP
 immutable:='[]';currents:='[]';
 FOR fa_m IN 0..jsonb_array_length(membership)-1 LOOP CONTINUE WHEN (membership->fa_m->>'cohort')::integer IS DISTINCT FROM cohort; n:=(membership->fa_m)-'cohort';
  IF n->>'kind'='application_query_domain' THEN CONTINUE;END IF;
  IF n->>'kind'='application_field' THEN
   source:=fa_completed->((fa_slots->>('field:'||(n->>'id')||':'||(n->>'version')))::integer-1)->'value';
   IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN PERFORM fused_f_fence(guard_pin); RETURN jsonb_build_object('admitted',false);END IF;
   observation:=jsonb_populate_record(NULL::application_field_observations,fa_pre[(fa_positions->>jsonb_build_array('source',n->>'kind',n->>'id',n->>'version')::text)::integer].observation);
   IF observation.resource_id IS NULL THEN RAISE EXCEPTION 'query returned no rows' USING ERRCODE='P0002';END IF;
   immutable:=immutable||jsonb_build_array(observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version));
  ELSE
   IF fa_completed->((fa_slots->>('native:'||(n->>'kind')||':'||(n->>'id')||':'||(n->>'version')))::integer-1)->>'value' IS DISTINCT FROM 'true' THEN PERFORM fused_f_fence(guard_pin); RETURN jsonb_build_object('admitted',false);END IF;
   source:=fa_completed->((fa_slots->>('current:'||(n->>'kind')||':'||(n->>'id')||':'||(n->>'version')))::integer-1);
   IF source IS NULL OR source='null'::jsonb THEN CONTINUE;END IF;
   source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId','sensitivity',source->'sensitivity',
    'compartments',source->'compartments','projectIds',source->'projectIds','resourceKind',n->'kind','resourceId',n->'id','version',source->'version');
   IF n->>'kind'='session_context_revision' THEN
    IF source->>'version' IS DISTINCT FROM n->>'version' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
    immutable:=immutable||jsonb_build_array(source);
   END IF;
  END IF;
  currents:=currents||jsonb_build_array(source-ARRAY['held','validTo','retractedAt']);
 END LOOP;
 proofs:=proofs||jsonb_build_array(jsonb_build_object('immutable',immutable,'current',currents));
 END LOOP;
 IF authority IS NOT NULL THEN
  IF jsonb_typeof(authority) IS DISTINCT FROM 'array' OR jsonb_array_length(authority)<>9
   OR authority->>0 IS DISTINCT FROM w::text OR authority->>1 IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')
  THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 END IF;
 -- Statement D: the single registry fence (guard pin, guard over every member) and the closing checks.
 SELECT fa_c.pin_ok,fa_g.guard,fa_g.closure_ok,fa_g.ctx,fa_g.policy,fa_g.mem_ctx,fa_g.auth INTO fa_pin_ok,fa_guard,fa_closure_ok,fa_ctx_now,fa_policy_now,fa_mem_now,authority_facts
 FROM (SELECT (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure)
  IS NOT DISTINCT FROM guard_pin pin_ok) fa_c
 CROSS JOIN LATERAL (SELECT CASE WHEN fa_c.pin_ok THEN native_turn_helpers_current() END guard,
  CASE WHEN fa_c.pin_ok THEN true END closure_ok,(SELECT jsonb_build_object('sessionUser',session_user,'currentUser',current_user,'settings',(SELECT jsonb_object_agg(k,current_setting(k,true)) FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']::text[]) k))) ctx,(SELECT jsonb_build_array(c.revision,p.revision)
  FROM application_policy_contract_epoch c CROSS JOIN application_policy_workspace_epochs p
  WHERE c.singleton AND p.workspace_id=w) policy,
  CASE WHEN facts ? 'memCtx' THEN (SELECT fa_cm.ctx FROM (SELECT f FROM fused_c_principal_facts(w) OFFSET 0) fa_cp CROSS JOIN LATERAL fused_c_memory_context(w,fa_cp.f) fa_cm) END mem_ctx,
  CASE WHEN authority IS NOT NULL THEN (SELECT fa_af.facts FROM fused_c_authority_facts((authority->>0)::uuid,(authority->>1)::uuid,(authority->>2)::uuid,(authority->>3)::uuid,(authority->>4)::uuid,(authority->>5)::integer,(authority->>6)::uuid,(authority->>7)::boolean,(authority->>8)::boolean) fa_af) END auth) fa_g;

 IF NOT fa_pin_ok THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF fa_guard IS NOT TRUE OR fa_closure_ok IS NOT TRUE OR fa_ctx_now IS DISTINCT FROM context
  OR policy_revision IS DISTINCT FROM fa_policy_now
  OR clock_timestamp()>=(memo->>'validUntil')::timestamptz
  OR facts ? 'memCtx' AND fa_mem_now IS DISTINCT FROM (CASE WHEN facts->'memCtx'='null'::jsonb THEN NULL ELSE facts->'memCtx' END)
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;

 RETURN jsonb_build_object('admitted',true)||CASE WHEN cohorts IS NULL THEN proofs->0 ELSE jsonb_build_object('cohorts',proofs) END
  ||CASE WHEN authority IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('authority',authority_facts) END;
END $fa_body$;
CREATE FUNCTION fused_f_privacy(w uuid, nodes jsonb) RETURNS TABLE(node_count bigint, denied jsonb, session_ids jsonb, archive_count bigint, archive_denied jsonb)
LANGUAGE sql STABLE AS $fa$
SELECT p1.node_count,p1.denied,p1.session_ids,p2.archive_count,p2.archive_denied FROM (
 WITH RECURSIVE points AS MATERIALIZED(
  SELECT n->>'kind' kind,(n->>'id')::uuid id,fused_c_uuidp(fused_f_digest(jsonb_build_object(
   'workspaceId',w,'origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey',n->>'kind','id',n->>'id',
   'selection','query','selectedVersion',NULL,'fields',n->'fields','fieldIdentity',fused_f_digest(jsonb_build_object(
    'kind','session_field_v1','type',n->>'kind','fields',n->'fields'))))) field_id
  FROM jsonb_array_elements(nodes) n WHERE n->>'tag'='point'
 ), edges(parent_kind,parent_id,child_kind,child_id) AS NOT MATERIALIZED(
  SELECT d.resource_kind,d.resource_id,s.source_kind,s.source_id FROM scope_derivations d
   JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id WHERE d.workspace_id=w
  UNION ALL SELECT 'application_field',o.resource_id,o.source_kind,o.source_id FROM application_field_observations o WHERE o.workspace_id=w
  UNION ALL SELECT 'application_field',o.resource_id,o.source_kind,o.source_id FROM application_field_observation_sources o WHERE o.workspace_id=w
  UNION ALL SELECT 'application_field',f.id,'session_message',f.resource_id FROM application_field_resources f
   WHERE f.workspace_id=w AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND f.type_key IN('session_message','session_message_annotation')
  UNION ALL SELECT 'application_field',p.field_id,'session_message',p.id FROM points p
  UNION ALL SELECT 'application_field',p.field_id,'session_context_revision',h.scope_revision_id FROM points p
   JOIN session_message_annotation_heads h ON h.workspace_id=w AND h.message_id=p.id WHERE p.kind='session_message_annotation'
 ), closure(kind,id) AS(
  SELECT n->>'kind',(n->>'id')::uuid FROM jsonb_array_elements(nodes) n WHERE n->>'tag'='source'
  UNION SELECT 'application_field',field_id FROM points
  UNION SELECT e.child_kind,e.child_id FROM closure c JOIN edges e ON e.parent_kind=c.kind AND e.parent_id=c.id
 ), reached AS MATERIALIZED(SELECT * FROM closure LIMIT 4097), parents(kind,id,session_id) AS MATERIALIZED(
  SELECT n.kind,n.id,s.id FROM reached n JOIN sessions s ON n.kind='session' AND s.id=n.id AND s.workspace_id=w
  UNION SELECT n.kind,n.id,m.session_id FROM reached n JOIN session_messages m ON n.kind='session_message' AND m.id=n.id
   JOIN sessions s ON s.id=m.session_id WHERE s.workspace_id=w
  UNION SELECT n.kind,n.id,r.session_id FROM reached n JOIN session_context_scope_revisions r ON n.kind='session_context_revision' AND r.id=n.id AND r.workspace_id=w
  UNION SELECT n.kind,n.id,s.session_id FROM reached n JOIN session_state s ON n.kind='session_state' AND s.id=n.id
  UNION SELECT n.kind,n.id,e.session_id FROM reached n JOIN episodic_memories e ON n.kind='episodic_memory' AND e.id=n.id
  UNION SELECT n.kind,n.id,e.session_id FROM reached n JOIN analytics_events e ON n.kind='feedback_event' AND e.id=n.id
 ), checked AS MATERIALIZED(
  SELECT session_id,coalesce((SELECT NOT fa_s.recording_privacy_held FROM sessions fa_s WHERE fa_s.id=p.session_id),false) allowed FROM(SELECT DISTINCT session_id FROM parents WHERE session_id IS NOT NULL) p
 ), denied(kind,id) AS(
  SELECT p.kind,p.id FROM parents p JOIN checked c USING(session_id) WHERE NOT c.allowed
  UNION SELECT e.parent_kind,e.parent_id FROM denied d JOIN edges e ON e.child_kind=d.kind AND e.child_id=d.id
   JOIN reached r ON r.kind=e.parent_kind AND r.id=e.parent_id
 ) SELECT (SELECT count(*) FROM reached),coalesce(jsonb_object_agg(kind||':'||id,true),'{}'),(SELECT coalesce(jsonb_agg(session_id),'[]') FROM checked) FROM denied
) p1(node_count,denied,session_ids) CROSS JOIN (
 WITH RECURSIVE causal_edges(parent_kind,parent_id,child_kind,child_id) AS NOT MATERIALIZED(
  SELECT d.resource_kind,d.resource_id,s.source_kind,s.source_id FROM scope_derivations d
   JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id WHERE d.workspace_id=w
  UNION ALL SELECT 'file_segment',f.id,'workspace_file',f.file_id FROM file_segments f WHERE f.workspace_id=w
 ), closure(kind,id) AS(
  SELECT 'session_message', (n->>'id')::uuid FROM jsonb_array_elements(nodes) n
   WHERE n->>'kind'='session_message' OR n->>'tag'='point' AND n->>'kind'='session_message_annotation'
  UNION SELECT 'session_message',r.parent_id FROM jsonb_array_elements(nodes) n JOIN session_context_scope_revisions r
   ON r.workspace_id=w AND r.id=(n->>'id')::uuid WHERE n->>'kind'='session_context_revision' AND r.parent_kind='message_annotation'
  UNION SELECT e.child_kind,e.child_id FROM closure c JOIN causal_edges e ON e.parent_kind=c.kind AND e.parent_id=c.id
 ), reached AS MATERIALIZED(SELECT * FROM closure LIMIT 4097), denied(kind,id) AS(
  SELECT r.kind,r.id FROM reached r JOIN workspace_files f ON r.kind='workspace_file' AND f.workspace_id=w AND f.id=r.id
   WHERE f.purpose='engineering_archive'
  UNION SELECT e.parent_kind,e.parent_id FROM denied d JOIN causal_edges e ON e.child_kind=d.kind AND e.child_id=d.id
   JOIN reached r ON r.kind=e.parent_kind AND r.id=e.parent_id
 ) SELECT (SELECT count(*) FROM reached),coalesce(jsonb_object_agg(kind||':'||id,true),'{}') FROM denied
) p2(archive_count,archive_denied)
$fa$;
CREATE FUNCTION fused_f_recording_candidates(w uuid, session_ids jsonb) RETURNS TABLE(candidates boolean) LANGUAGE sql STABLE AS $fa$
SELECT EXISTS(SELECT 1 FROM (SELECT value::uuid id FROM jsonb_array_elements_text(session_ids)) ids JOIN sessions s ON s.id=ids.id
 WHERE s.recording_revision IS NOT NULL OR s.channel_type='telegram' AND s.anchor_kind='channel'
  AND s.channel_id ~ '^-[0-9]+(:topic:[0-9]+|:discussion:[0-9]+)?$')
$fa$;
CREATE FUNCTION fused_f_deadline(w uuid, nodes jsonb) RETURNS TABLE(deadline timestamptz) LANGUAGE sql STABLE AS $fa$
 SELECT coalesce(min(t),'infinity'::timestamptz) FROM (
 SELECT expires_at t FROM department_edges WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT starts_at FROM workspace_access_grants WHERE starts_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM workspace_access_grants WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM project_shared_members WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT starts_at FROM application_native_role_assignments WHERE starts_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM application_native_role_assignments WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM office_artifacts WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT audience_deadlines.expires_at FROM (SELECT CASE WHEN pg_input_is_valid(binding->>'expiresAt','timestamp with time zone')
   THEN (binding->>'expiresAt')::timestamptz ELSE NULL END AS expires_at
  FROM channel_integrations ci JOIN channels c ON c.id=ci.channel_id
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ci.config->'deliveryAudienceBindings')='array'
   THEN ci.config->'deliveryAudienceBindings' ELSE '[]'::jsonb END) binding
  WHERE c.workspace_id=w AND c.status='active' AND ci.status='active') audience_deadlines
  WHERE audience_deadlines.expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM external_source_authorizations
  WHERE workspace_id=w AND transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()
   AND operation_id::text=nullif(current_setting('app.external_source_operation_id',true),'')
   AND observation_id IN(SELECT (n->>'id')::uuid FROM jsonb_array_elements(nodes) n
    WHERE n->>'kind'='external_source')
 UNION ALL SELECT to_timestamp((o.observation#>>'{retention,expiresAt}')::numeric/1000)
  FROM external_source_observations o JOIN jsonb_array_elements(nodes) n
   ON n->>'kind'='external_source' AND o.workspace_id=w AND o.id=(n->>'id')::uuid
  WHERE o.observation#>>'{retention,mode}'='released_snapshot') transitions
$fa$;
CREATE FUNCTION fused_f_structure(nodes jsonb, edges jsonb) RETURNS TABLE(positions jsonb, positions_bad boolean, reverse_edges jsonb, degree_map jsonb, degrees integer[], children jsonb, slots jsonb)
LANGUAGE sql STABLE AS $fa$
SELECT a.positions,b.bad,c.reverse_edges,c.degree_map,d.degrees,e.children,f.slots FROM
 ( SELECT jsonb_object_agg(fused_f_turn_key(n),position)
 FROM jsonb_array_elements(nodes) WITH ORDINALITY row(n,position)) a(positions)
 CROSS JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE fused_f_turn_key(n) IS NULL)
  OR (SELECT count(*) FROM jsonb_object_keys(a.positions))<>jsonb_array_length(nodes)) b(bad)
 CROSS JOIN LATERAL ( WITH indexed AS MATERIALIZED(
  SELECT DISTINCT (a.positions->>fused_f_turn_key(e->'parent'))::integer p,
   (a.positions->>fused_f_turn_key(e->'child'))::integer c FROM jsonb_array_elements(edges) e
 ), reverse AS(SELECT c,jsonb_agg(p) parents FROM indexed GROUP BY c), degree AS(SELECT p,count(*) n FROM indexed GROUP BY p)
 SELECT (SELECT jsonb_object_agg(c,parents) FROM reverse),(SELECT jsonb_object_agg(p,n) FROM degree)
) c(reverse_edges,degree_map)
 CROSS JOIN LATERAL ( SELECT coalesce(array_agg(coalesce((c.degree_map->>i::text)::integer,0) ORDER BY i),'{}') FROM generate_series(1,jsonb_array_length(nodes)) i) d(degrees)
 CROSS JOIN LATERAL ( SELECT coalesce(jsonb_object_agg(key,items),'{}') FROM(
  SELECT fused_f_turn_key(e->'parent') key,jsonb_agg(e->'child') items FROM jsonb_array_elements(edges) e GROUP BY 1
 ) grouped) e(children)
 CROSS JOIN LATERAL ( SELECT jsonb_object_agg(label,slot) FROM jsonb_array_elements(nodes) WITH ORDINALITY row(n,position)
 CROSS JOIN LATERAL (
  SELECT CASE WHEN n->>'tag'='point' THEN 'points:'||jsonb_build_array(n->>'kind',n->>'id',n->'fields')::text
   WHEN n->>'kind'='application_field' THEN 'field:'||(n->>'id')||':'||(n->>'version')
   WHEN n->>'kind'='application_query_domain' THEN 'domains:'||(n->>'id')
   ELSE 'native:'||(n->>'kind')||':'||(n->>'id')||':'||(n->>'version') END label,position*2-1 slot
  UNION ALL SELECT CASE WHEN n->>'tag'='point' THEN 'envelopes:'||jsonb_build_array(n->>'kind',n->>'id',n->'fields')::text
   ELSE 'current:'||(n->>'kind')||':'||(n->>'id')||':'||(n->>'version') END,position*2
 ) aliases) f(slots)
$fa$;
CREATE FUNCTION fused_f_prefetch(w uuid, nodes jsonb) RETURNS TABLE(pre fused_node_pre[]) LANGUAGE sql STABLE AS $fa$
SELECT coalesce(array_agg(ROW(
  CASE WHEN x.n->>'tag'='source' AND x.n->>'kind'='application_field' THEN (SELECT to_jsonb(r) FROM application_field_resources r WHERE r.workspace_id=w AND r.id=(x.n->>'id')::uuid) END,
  CASE WHEN x.n->>'tag'='source' AND x.n->>'kind'='application_field' THEN (SELECT to_jsonb(o) FROM application_field_observations o WHERE o.workspace_id=w AND o.resource_id=(x.n->>'id')::uuid AND o.version=x.n->>'version') END,
  CASE WHEN x.n->>'tag'='source' AND x.n->>'kind'='application_field' THEN EXISTS(SELECT 1 FROM scope_resource_states s
    WHERE s.resource_kind='application_field' AND s.resource_id=(x.n->>'id')::uuid AND s.review_state='held') END,
  CASE WHEN x.n->>'tag'='source' AND x.n->>'kind'='application_field' THEN coalesce((SELECT jsonb_agg(to_jsonb(o)) FROM application_field_observation_sources o WHERE o.workspace_id=w AND o.resource_id=(x.n->>'id')::uuid AND o.version=x.n->>'version'),'[]') END,
  CASE WHEN x.n->>'tag'='source' AND x.n->>'kind'='application_query_domain' THEN (SELECT to_jsonb(r) FROM application_field_resources r WHERE r.workspace_id=w AND r.resource_id=(x.n->>'id')::uuid AND r.selection='query_domain' LIMIT 1) END,
  CASE WHEN x.n->>'tag'='source' AND x.n->>'kind'='session_message' THEN EXISTS(SELECT 1 FROM session_messages m WHERE m.workspace_id=w AND m.id=(x.n->>'id')::uuid) END,
  CASE WHEN x.n->>'tag'='source' AND x.n->>'kind' NOT IN('application_field','application_query_domain') THEN coalesce((SELECT jsonb_agg(to_jsonb(d)) FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind=x.n->>'kind' AND d.resource_id=(x.n->>'id')::uuid),'[]') END,
  CASE WHEN x.n->>'tag'='source' AND x.n->>'kind' NOT IN('application_field','application_query_domain') THEN coalesce((SELECT jsonb_object_agg(d.id::text,(SELECT coalesce(jsonb_agg(jsonb_build_array(e.kind,e.id)),'[]') FROM scope_derivation_sources ds JOIN entities e ON e.workspace_id=w AND e.id=ds.source_id
     WHERE ds.workspace_id=w AND ds.derivation_id=d.id AND ds.source_kind='entity' AND e.kind IN('company','person','deal'))) FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind=x.n->>'kind' AND d.resource_id=(x.n->>'id')::uuid),'{}') END,
  CASE WHEN x.n->>'tag'='point' THEN ARRAY(SELECT jsonb_array_elements_text(x.n->'fields')) END
 )::fused_node_pre ORDER BY x.position),'{}') FROM jsonb_array_elements(nodes) WITH ORDINALITY x(n,position)
$fa$;
CREATE FUNCTION fused_f_graph_t(w uuid, roots jsonb) RETURNS TABLE(graph jsonb) LANGUAGE sql STABLE AS $g$
WITH RECURSIVE closure(n) AS(
  SELECT r.value||'{"tag":"source"}'::jsonb FROM jsonb_array_elements(roots) r
  UNION SELECT e.child FROM closure c CROSS JOIN LATERAL fused_f_adjacent(w,c.n) e
), bounded AS MATERIALIZED(SELECT n FROM closure LIMIT 4097),
edges AS MATERIALIZED(SELECT b.n parent,e.child FROM bounded b CROSS JOIN LATERAL fused_f_adjacent(w,b.n) e LIMIT 65537),
membership(kind,id,version) AS(
  SELECT r->>'kind',(r->>'id')::uuid,r->>'version' FROM jsonb_array_elements(roots) r
  UNION SELECT e.child->>'kind',(e.child->>'id')::uuid,e.child->>'version' FROM membership m JOIN edges e
   ON e.parent->>'tag'='source' AND e.child->>'tag'='source' AND e.parent->>'kind'=m.kind AND e.parent->>'id'=m.id::text AND e.parent->>'version'=m.version
), projected AS MATERIALIZED(SELECT * FROM membership LIMIT 4097)
SELECT jsonb_build_object(
 'supported',(SELECT count(*) FROM bounded)<=4096 AND (SELECT count(*) FROM edges)<=65536 AND (SELECT count(*) FROM projected)<=4096
  AND NOT EXISTS(SELECT 1 FROM bounded b WHERE b.n->>'tag'='source' AND (b.n->>'kind' NOT IN('application_field','session_message','session_context_revision','application_query_domain','private_transcript')
   OR b.n->>'kind'='application_field' AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=(b.n->>'id')::uuid
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))),
 'nodes',(SELECT coalesce(jsonb_agg(n),'[]') FROM bounded),
 'edges',(SELECT coalesce(jsonb_agg(jsonb_build_object('parent',parent,'child',child,'edge_kind','derivation')),'[]') FROM edges),
 'membership',(SELECT coalesce(jsonb_agg(jsonb_build_object('cohort',1,'kind',kind,'id',id,'version',version)),'[]') FROM projected))
$g$;
CREATE FUNCTION fused_f_cohort_membership(groups jsonb, edges jsonb) RETURNS TABLE(m jsonb) LANGUAGE sql STABLE AS $fa$
 WITH RECURSIVE closure(cohort,kind,id,version) AS(
  SELECT g.position,r->>'kind',(r->>'id')::uuid,r->>'version'
   FROM jsonb_array_elements(groups) WITH ORDINALITY g(roots,position) CROSS JOIN jsonb_array_elements(g.roots) r
  UNION SELECT c.cohort,e->'child'->>'kind',(e->'child'->>'id')::uuid,e->'child'->>'version' FROM closure c JOIN jsonb_array_elements(edges) e
   ON e->'parent'->>'tag'='source' AND e->'child'->>'tag'='source' AND e->'parent'->>'kind'=c.kind AND e->'parent'->>'id'=c.id::text AND e->'parent'->>'version'=c.version
 ) SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') FROM(SELECT * FROM closure LIMIT 8193) c
$fa$;
CREATE FUNCTION fused_f_fence(guard_pin text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fa$
DECLARE ok boolean;
BEGIN
 SELECT CASE WHEN (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure)
  IS NOT DISTINCT FROM guard_pin THEN native_turn_helpers_current() IS TRUE ELSE false END INTO ok;
 IF ok IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
END $fa$;
CREATE FUNCTION fused_c_decline(reason text, kind anyelement) RETURNS anyelement LANGUAGE plpgsql VOLATILE AS $f$
BEGIN RAISE EXCEPTION 'fused_admission_declined: %', reason USING ERRCODE='P0001'; END $f$;
CREATE FUNCTION fused_c_memory_field_keys() RETURNS text[] LANGUAGE sql STABLE AS $f$
 SELECT ARRAY['id','assistant_id','user_id','app_id','workspace_id','scope','tags','summary','detail','confidence','sensitivity','compartments','project_ids','scope_version','scope_held','source','source_session_id','recall_count','useful_recall_count','last_recalled_at','created_at','updated_at','created_by_user_id','created_by_assistant_id','source_episode_id','verified_by_user_id','verified_at','valid_from','valid_to','superseded_by','retracted_at','retracted_reason','retracted_by','original_scope','original_sensitivity','original_summary','learning']::text[]
$f$;
CREATE FUNCTION fused_c_project_member_live(p_project uuid, p_kind text, p_principal uuid) RETURNS TABLE(v boolean) LANGUAGE sql STABLE AS $f$
  SELECT EXISTS (SELECT 1 FROM public.project_shared_members e
    WHERE e.project_id = p_project AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())
      AND CASE WHEN p_kind = 'user' THEN e.user_id = p_principal ELSE e.assistant_id = p_principal END)
$f$;
CREATE FUNCTION fused_c_placement_visible(p_actor uuid, p_assistant uuid) RETURNS TABLE(v boolean) LANGUAGE sql STABLE AS $f$
  SELECT EXISTS (
    SELECT 1 FROM public.assistants a WHERE a.id = p_assistant
      AND (a.placement_department_id IS NULL OR EXISTS (
        SELECT 1 FROM public.department_edges e
        JOIN public.workspace_members m ON m.workspace_id=e.workspace_id AND m.user_id=e.user_id
        JOIN public.workspace_groups g ON g.workspace_id=e.workspace_id AND g.id=e.department_id
        WHERE e.workspace_id=a.workspace_id AND e.department_id=a.placement_department_id
          AND e.user_id=p_actor AND g.status='active'
          AND (e.expires_at IS NULL OR e.expires_at>clock_timestamp())
      ))
  )
$f$;
CREATE FUNCTION fused_c_dept_snapshot(p_actor uuid) RETURNS TABLE(v jsonb) LANGUAGE sql STABLE AS $f$
  WITH actor AS (
    SELECT p_actor AS u,
           nullif(current_setting('app.v2_assistant_id', true), '')::uuid AS a,
           nullif(current_setting('app.v2_context_department', true), '') AS c,
           nullif(current_setting('app.v2_binding', true), '')::jsonb AS k,
           CASE WHEN nullif(current_setting('app.v2_cap', true), '') IS NULL THEN 3
                ELSE coalesce(fused_f_rank(current_setting('app.v2_cap', true)), 0) END AS cap
  )
  SELECT coalesce(jsonb_object_agg(m.workspace_id::text, jsonb_build_object(
      'b', least(
             fused_f_rank(CASE WHEN m.role IN ('owner', 'admin') THEN 'confidential' ELSE m.clearance END),
             CASE WHEN actor.a IS NULL THEN 3
                  ELSE coalesce((SELECT fused_f_rank(x.clearance) FROM assistants x
                                  WHERE x.id = actor.a AND x.workspace_id = m.workspace_id), 0) END,
             actor.cap),
      'd', coalesce((
             SELECT jsonb_object_agg(e.department_id::text, least(
                      fused_f_rank(e.clearance),
                      CASE WHEN actor.a IS NULL THEN 3 ELSE coalesce(fused_f_rank(ae.clearance), 0) END,
                      actor.cap))
               FROM department_edges e
               LEFT JOIN department_edges ae
                 ON ae.department_id = e.department_id AND ae.assistant_id = actor.a
                AND (ae.expires_at IS NULL OR ae.expires_at > clock_timestamp())
              WHERE e.workspace_id = m.workspace_id AND e.user_id = actor.u
                AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())), '{}'::jsonb),
      'c', actor.c,
      'k', actor.k,
      'u', actor.u,
      'p', coalesce((
             SELECT jsonb_agg(s.project_id::text ORDER BY s.project_id)
               FROM project_shared_scopes s
              WHERE s.workspace_id = m.workspace_id AND s.status = 'active' AND wk.project_shared_spaces
                AND (SELECT v FROM fused_c_project_member_live(s.project_id, 'user', actor.u))
                AND (actor.a IS NULL OR (SELECT v FROM fused_c_project_member_live(s.project_id, 'assistant', actor.a)))), '[]'::jsonb),
      'o', coalesce((
             SELECT jsonb_agg(s.project_id::text ORDER BY s.project_id)
               FROM project_shared_scopes s
              WHERE s.workspace_id = m.workspace_id AND s.status = 'active' AND wk.project_shared_spaces
                AND m.role = 'owner'
                AND NOT (SELECT v FROM fused_c_project_member_live(s.project_id, 'user', actor.u))
                AND (actor.a IS NULL OR (SELECT v FROM fused_c_project_member_live(s.project_id, 'assistant', actor.a)))), '[]'::jsonb))), '{}'::jsonb)
    FROM actor
    JOIN workspace_members m ON m.user_id = actor.u
    JOIN workspaces wk ON wk.id = m.workspace_id AND wk.department_read_v2
$f$;
CREATE FUNCTION fused_c_dept_grants_for(p_actor uuid) RETURNS TABLE(v jsonb) LANGUAGE sql STABLE AS $f$
  SELECT CASE WHEN nullif(current_setting('app.current_user_id',true),'') IS NULL
    OR nullif(current_setting('app.current_user_id',true),'')::uuid=p_actor
    THEN (SELECT v FROM fused_c_dept_snapshot(p_actor)) ELSE '{}'::jsonb END
$f$;
CREATE FUNCTION fused_c_dept_grants() RETURNS TABLE(v jsonb) LANGUAGE sql STABLE AS $f$
  SELECT (SELECT v FROM fused_c_dept_grants_for(nullif(current_setting('app.current_user_id',true),'')::uuid))
$f$;
CREATE FUNCTION fused_c_member_team(p_user_id uuid, p_workspace_id uuid) RETURNS TABLE(v text[]) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN m.role IS NULL THEN ARRAY[]::text[]
  WHEN m.role IN ('owner','admin') THEN NULL
  WHEN m.team_scope_mode='legacy' THEN m.compartments
  WHEN t.has_read_all THEN NULL
  WHEN m.compartments IS NOT NULL THEN (SELECT COALESCE(array_agg(value ORDER BY value), ARRAY[]::text[]) FROM unnest(t.result) AS value WHERE value = ANY(m.compartments))
  ELSE COALESCE(t.result, ARRAY[]::text[]) END
 FROM (SELECT 1) one
 LEFT JOIN public.workspace_members m ON m.user_id = p_user_id AND m.workspace_id = p_workspace_id
 CROSS JOIN LATERAL (
  SELECT COALESCE(bool_or(g.read_all), false) has_read_all,
         COALESCE(array_agg(DISTINCT grant_key ORDER BY grant_key) FILTER (WHERE grant_key IS NOT NULL), ARRAY[]::text[]) result
    FROM public.workspace_group_members gm
    JOIN public.workspace_groups g ON g.id = gm.group_id
    LEFT JOIN LATERAL (
      SELECT g.compartment_key AS grant_key
      UNION
      SELECT gcg.compartment_key
        FROM public.workspace_group_compartment_grants gcg
       WHERE gcg.group_id = g.id
    ) grants ON true
   WHERE gm.user_id = p_user_id
     AND g.workspace_id = p_workspace_id
     AND g.kind = 'team') t
$f$;
CREATE FUNCTION fused_c_member_read(p_user_id uuid, p_workspace_id uuid) RETURNS TABLE(v text[]) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=p_workspace_id AND user_id=p_user_id) THEN ARRAY[]::text[]
  WHEN b.base IS NULL THEN NULL
  ELSE (SELECT coalesce(array_agg(DISTINCT key ORDER BY key),ARRAY[]::text[]) FROM (
    SELECT unnest(b.base) AS key
    UNION
    SELECT target.compartment_key FROM workspace_access_grants grant_row
      JOIN workspace_groups target ON target.id=grant_row.target_team_id AND target.workspace_id=grant_row.workspace_id AND target.status='active'
      WHERE grant_row.workspace_id=p_workspace_id AND grant_row.revoked_at IS NULL
        AND grant_row.starts_at<=clock_timestamp() AND (grant_row.expires_at IS NULL OR grant_row.expires_at>clock_timestamp())
        AND ((grant_row.beneficiary_kind='member' AND grant_row.beneficiary_id=p_user_id)
          OR (grant_row.beneficiary_kind='team' AND EXISTS(
            SELECT 1 FROM workspace_group_members gm JOIN workspace_groups beneficiary ON beneficiary.id=gm.group_id
             WHERE gm.group_id=grant_row.beneficiary_id AND gm.user_id=p_user_id AND beneficiary.workspace_id=p_workspace_id AND beneficiary.status='active'
          )))
  ) keys) END
 FROM (SELECT v base FROM fused_c_member_team(p_user_id,p_workspace_id) OFFSET 0) b
$f$;
CREATE FUNCTION fused_c_member_principal_grants(p_actor uuid, mutation boolean, only_workspace uuid) RETURNS TABLE(v jsonb) LANGUAGE sql STABLE AS $f$
  WITH departments AS MATERIALIZED (SELECT (SELECT v FROM fused_c_dept_snapshot(p_actor)) AS grants)
  SELECT coalesce(jsonb_object_agg(m.workspace_id::text, jsonb_build_object(
      'r', fused_f_rank(CASE WHEN m.role IN ('owner','admin') THEN 'confidential' ELSE m.clearance END),
      'c', to_jsonb(CASE WHEN mutation THEN (SELECT v FROM fused_c_member_team(m.user_id, m.workspace_id))
                         ELSE (SELECT v FROM fused_c_member_read(m.user_id, m.workspace_id)) END),
      'v2', CASE WHEN mutation THEN (departments.grants -> m.workspace_id::text) - 'o'
                 ELSE departments.grants -> m.workspace_id::text END)), '{}'::jsonb)
    FROM workspace_members m CROSS JOIN departments
   WHERE m.user_id = p_actor
     AND (only_workspace IS NULL OR m.workspace_id = only_workspace)
$f$;
CREATE FUNCTION fused_c_member_operation_grants(mutation boolean, only_workspace uuid) RETURNS TABLE(v jsonb) LANGUAGE sql STABLE AS $f$
  SELECT (SELECT v FROM fused_c_member_principal_grants(nullif(current_setting('app.current_user_id',true),'')::uuid,mutation,only_workspace))
$f$;
CREATE FUNCTION fused_c_dept_row_allows(grants jsonb, w uuid, sensitivity text, compartments text[], row_user uuid) RETURNS TABLE(v boolean) LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN w IS NULL OR NOT (grants ? w::text)
    THEN NOT EXISTS (SELECT 1 FROM unnest(coalesce(compartments, '{}'::text[])) AS k WHERE k LIKE 'project:%')
    ELSE coalesce((
    SELECT fused_f_rank(sensitivity) IS NOT NULL
       AND (row_user IS NULL OR row_user::text = (g.v ->> 'u'))
       AND CASE WHEN ds.ids IS NULL
                THEN fused_f_rank(sensitivity) <= (g.v ->> 'b')::int
                ELSE NOT EXISTS (SELECT 1 FROM unnest(ds.ids) AS d(id)
                                  WHERE NOT coalesce(fused_f_rank(sensitivity) <= ((g.v -> 'd') ->> d.id)::int, false))
           END
       AND (jsonb_typeof(g.v -> 'c') IS DISTINCT FROM 'string' OR ds.ids IS NULL OR (g.v ->> 'c') = ANY (ds.ids))
       AND (jsonb_typeof(g.v -> 'k') IS DISTINCT FROM 'array' OR ds.ids IS NULL
            OR ds.ids <@ ARRAY(SELECT jsonb_array_elements_text(g.v -> 'k')))
       AND (ds.projects IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(ds.projects) AS p(id)
              WHERE NOT (coalesce((g.v -> 'p') ? p.id, false) OR coalesce((g.v -> 'o') ? p.id, false))))
       AND (jsonb_typeof(g.v -> 'k') IS DISTINCT FROM 'array' OR ds.projects IS NULL
            OR ds.projects <@ ARRAY(SELECT jsonb_array_elements_text(g.v -> 'k')))
      FROM (SELECT grants -> w::text AS v) g,
           (SELECT array_agg(substr(k, 6)) FILTER (WHERE k LIKE 'team:%') AS ids,
                   array_agg(substr(k, 9)) FILTER (WHERE k LIKE 'project:%') AS projects
              FROM unnest(coalesce(compartments, '{}'::text[])) AS k) ds
  ), false) END
$f$;
CREATE FUNCTION fused_c_member_row_allows(grants jsonb, w uuid, sensitivity text, compartments text[]) RETURNS TABLE(v boolean) LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN jsonb_typeof((grants -> w::text) -> 'v2') = 'object'
    THEN (SELECT v FROM fused_c_dept_row_allows(jsonb_build_object(w::text, (grants -> w::text) -> 'v2'), w, sensitivity, compartments, NULL::uuid))
    ELSE NOT EXISTS (SELECT 1 FROM unnest(coalesce(compartments, '{}'::text[])) AS k WHERE k LIKE 'project:%')
      AND coalesce(
      fused_f_rank(sensitivity) <= ((grants -> w::text) ->> 'r')::int
      AND (jsonb_typeof((grants -> w::text) -> 'c') = 'null'
           OR (NOT (to_jsonb(coalesce(compartments, '{}'::text[])) @> '[null]'::jsonb)
               AND to_jsonb(coalesce(compartments, '{}'::text[])) <@ ((grants -> w::text) -> 'c'))),
      false)
    END
$f$;
CREATE FUNCTION fused_c_agent_scope_grant(setting_name text, required text[]) RETURNS TABLE(v boolean) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN r.raw IS NULL THEN true
  WHEN r.raw::jsonb='null'::jsonb THEN true
  WHEN jsonb_typeof(r.raw::jsonb)<>'array' THEN false
  WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(r.raw::jsonb) value WHERE jsonb_typeof(value)<>'string') THEN false
  ELSE NOT EXISTS(SELECT 1 FROM unnest(coalesce(required,'{}')) value WHERE NOT r.raw::jsonb ? value) END
 FROM (SELECT nullif(current_setting(setting_name,true),'') raw) r
$f$;
CREATE FUNCTION fused_c_agent_read_scope(row_sensitivity text, row_teams text[], row_projects uuid[]) RETURNS TABLE(v boolean) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN c.clearance IS NOT NULL AND (fused_f_rank(c.clearance) IS NULL OR fused_f_rank(row_sensitivity) IS NULL
    OR fused_f_rank(row_sensitivity)>fused_f_rank(c.clearance)) THEN false
  ELSE (SELECT v FROM fused_c_agent_scope_grant('app.agent_compartments',row_teams))
    AND (SELECT v FROM fused_c_agent_scope_grant('app.agent_project_ids',row_projects::text[])) END
 FROM (SELECT nullif(current_setting('app.agent_clearance',true),'') clearance) c
$f$;
CREATE FUNCTION fused_c_visible(f jsonb, w uuid, s jsonb) RETURNS TABLE(v boolean) LANGUAGE sql STABLE AS $f$
 SELECT CASE
  WHEN a.actor IS NULL OR jsonb_typeof(s)<>'object' OR s->>'workspaceId' IS DISTINCT FROM w::text
  OR NOT(s ?& ARRAY['sensitivity','compartments','projectIds','userId','assistantId'])
  OR coalesce(s->>'sensitivity','') NOT IN('public','internal','confidential')
  OR jsonb_typeof(s->'compartments') IS DISTINCT FROM 'array'
  OR jsonb_typeof(s->'projectIds') IS DISTINCT FROM 'array'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'compartments') x WHERE jsonb_typeof(x)<>'string')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'projectIds') x WHERE jsonb_typeof(x)<>'string')
  OR (s->>'userId' IS NOT NULL AND s->>'userId'<>a.actor::text)
  OR (s->>'userId' IS NOT NULL AND current_setting('app.agent_shared_audience',true)='true')
  OR NOT (CASE WHEN f->>'w'=w::text AND f->>'actor'=a.actor::text THEN (f->>'member')::boolean
    ELSE EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=a.actor) END)
  THEN false
  ELSE (SELECT CASE
   WHEN agent_visibility_allows(w,(s->>'userId')::uuid,(s->>'assistantId')::uuid) IS NOT TRUE
    OR (SELECT v FROM fused_c_agent_scope_grant('app.agent_project_ids',tp.projects::text[])) IS NOT TRUE THEN false
   WHEN (CASE WHEN f->>'w'=w::text THEN (f->>'v2')::boolean ELSE (SELECT department_read_v2 FROM workspaces WHERE id=w) END) THEN
    (SELECT CASE WHEN NOT(g.grants ? w::text) OR (SELECT v FROM fused_c_dept_row_allows(g.grants,w,s->>'sensitivity',tp.teams,(s->>'userId')::uuid)) IS NOT TRUE THEN false
      WHEN nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL
       AND current_setting('app.v2_active',true) IS DISTINCT FROM 'true'
       AND nullif(current_setting('app.v2_assistant_id',true),'') IS NULL THEN
       CASE WHEN cardinality(tp.teams)>0 AND nullif(current_setting('app.agent_compartments',true),'') IS NULL THEN false
        WHEN (SELECT v FROM fused_c_agent_read_scope(s->>'sensitivity',tp.teams,tp.projects)) IS NOT TRUE THEN false
        ELSE true END
      ELSE true END
     FROM (SELECT CASE WHEN f->>'actor'=a.actor::text AND f ? 'dept' THEN f->'dept' ELSE (SELECT v FROM fused_c_dept_grants()) END grants OFFSET 0) g)
   ELSE (SELECT CASE WHEN (SELECT v FROM fused_c_member_row_allows(o.ops,w,s->>'sensitivity',tp.teams)) IS NOT TRUE
      OR (SELECT v FROM fused_c_agent_read_scope(s->>'sensitivity',tp.teams,tp.projects)) IS NOT TRUE THEN false ELSE true END
     FROM (SELECT CASE WHEN f->>'w'=w::text AND f->>'actor'=a.actor::text AND f ? 'ops' THEN f->'ops' ELSE (SELECT v FROM fused_c_member_operation_grants(false,w)) END ops OFFSET 0) o)
   END FROM (SELECT ARRAY(SELECT jsonb_array_elements_text(s->'compartments')) teams,
                    ARRAY(SELECT jsonb_array_elements_text(s->'projectIds')::uuid) projects OFFSET 0) tp)
 END
 FROM (SELECT nullif(current_setting('app.current_user_id',true),'')::uuid actor OFFSET 0) a
$f$;
CREATE FUNCTION fused_c_principal_facts(w uuid) RETURNS TABLE(f jsonb) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN x.actor IS NULL THEN '{}'::jsonb
  WHEN (x.f->>'v2')::boolean THEN x.f||jsonb_build_object('dept',(SELECT v FROM fused_c_dept_grants()))
  ELSE x.f||jsonb_build_object('ops',(SELECT v FROM fused_c_member_operation_grants(false,w))) END
 FROM (SELECT a.actor, jsonb_build_object('w',w,'actor',a.actor,'member',EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=a.actor),
   'v2',(SELECT department_read_v2 FROM workspaces WHERE id=w)) f
  FROM (SELECT nullif(current_setting('app.current_user_id',true),'')::uuid actor) a OFFSET 0) x
$f$;
CREATE FUNCTION fused_c_set_intersection(a jsonb, b jsonb) RETURNS TABLE(v jsonb) LANGUAGE sql IMMUTABLE AS $f$
 SELECT CASE WHEN a IS NULL OR b IS NULL THEN NULL WHEN a='null' THEN b WHEN b='null' THEN a
  ELSE (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM (
   SELECT value FROM jsonb_array_elements(a) INTERSECT SELECT value FROM jsonb_array_elements(b)) shared) END
$f$;
CREATE FUNCTION fused_c_normalize(bounds jsonb) RETURNS TABLE(v jsonb) LANGUAGE sql IMMUTABLE AS $f$
 SELECT CASE WHEN bounds IS NULL OR bounds->>'kind' NOT IN('native_legacy','native_department_v2') THEN NULL
  WHEN t.tier IS NULL OR t.tier NOT BETWEEN 0 AND 3 THEN NULL
  WHEN bounds->>'kind'='native_department_v2' THEN bounds
  WHEN bounds->'compartments'='null' THEN jsonb_build_object('kind','native_department_v2','tier',t.tier,'departments','null'::jsonb,'contextDepartment',NULL,
   'projectLabels','[]'::jsonb,'otherLabels',bounds->'compartments','projectIds',bounds->'projectIds')
  WHEN bounds->'compartments' IS NOT NULL AND jsonb_typeof(bounds->'compartments')<>'array' THEN NULL
  ELSE jsonb_build_object('kind','native_department_v2','tier',t.tier,
   'departments',(SELECT coalesce(jsonb_object_agg(substr(value#>>'{}',6),t.tier),'{}') FROM jsonb_array_elements(bounds->'compartments') WHERE value#>>'{}' LIKE 'team:%'),
   'contextDepartment',NULL,'projectLabels','[]'::jsonb,
   'otherLabels',(SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM (
     SELECT DISTINCT value FROM jsonb_array_elements(bounds->'compartments') WHERE value#>>'{}' NOT LIKE 'team:%' AND value#>>'{}' NOT LIKE 'project:%') allowed),
   'projectIds',bounds->'projectIds') END
 FROM (SELECT CASE WHEN pg_input_is_valid(bounds->>'tier','integer') THEN (bounds->>'tier')::int END tier) t
$f$;
CREATE FUNCTION fused_c_scope_cap(rank integer, compartments jsonb, projects jsonb) RETURNS TABLE(v jsonb) LANGUAGE sql IMMUTABLE AS $f$
 SELECT CASE WHEN rank IS NULL OR rank NOT BETWEEN 0 AND 3 OR compartments IS NULL OR projects IS NULL
  OR jsonb_typeof(compartments) NOT IN('array','null') OR jsonb_typeof(projects) NOT IN('array','null') THEN NULL
  WHEN compartments<>'null' AND (jsonb_array_length(compartments)>256 OR EXISTS(SELECT 1 FROM jsonb_array_elements(compartments) item WHERE jsonb_typeof(item)<>'string')) THEN NULL
  WHEN compartments<>'null' AND EXISTS(SELECT 1 FROM jsonb_array_elements(compartments) WHERE value#>>'{}' LIKE 'team:%' AND NOT pg_input_is_valid(substr(value#>>'{}',6),'uuid')) THEN NULL
  WHEN compartments<>'null' AND EXISTS(SELECT 1 FROM jsonb_array_elements(compartments) WHERE value#>>'{}' LIKE 'project:%' AND NOT pg_input_is_valid(substr(value#>>'{}',9),'uuid')) THEN NULL
  WHEN projects<>'null' AND (jsonb_array_length(projects)>256 OR EXISTS(SELECT 1 FROM jsonb_array_elements(projects) item WHERE jsonb_typeof(item)<>'string')) THEN NULL
  WHEN projects<>'null' AND EXISTS(SELECT 1 FROM jsonb_array_elements(projects) WHERE NOT pg_input_is_valid(value#>>'{}','uuid')) THEN NULL
  ELSE jsonb_build_object('kind','native_department_v2','tier',rank,
   'departments',CASE WHEN compartments='null' THEN 'null'::jsonb ELSE (SELECT coalesce(jsonb_object_agg(substr(value#>>'{}',6),rank),'{}') FROM jsonb_array_elements(compartments) WHERE value#>>'{}' LIKE 'team:%') END,
   'contextDepartment',NULL,
   'projectLabels',CASE WHEN compartments='null' THEN 'null'::jsonb ELSE (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM (
     SELECT DISTINCT to_jsonb(substr(value#>>'{}',9)) AS value FROM jsonb_array_elements(compartments) WHERE value#>>'{}' LIKE 'project:%') allowed) END,
   'otherLabels',CASE WHEN compartments='null' THEN 'null'::jsonb ELSE (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM (
     SELECT DISTINCT value FROM jsonb_array_elements(compartments) WHERE value#>>'{}' NOT LIKE 'team:%' AND value#>>'{}' NOT LIKE 'project:%') allowed) END,
   'projectIds',CASE WHEN projects='null' THEN projects ELSE (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM (SELECT DISTINCT value FROM jsonb_array_elements(projects)) allowed) END) END
$f$;
CREATE FUNCTION fused_c_scope_valid(p_scope jsonb) RETURNS TABLE(v boolean) LANGUAGE sql IMMUTABLE AS $f$
 SELECT CASE
  WHEN p_scope->>'kind'='native_legacy' AND (NOT p_scope ?& ARRAY['kind','tier','compartments','projectIds'] OR p_scope-ARRAY['kind','tier','compartments','projectIds']<>'{}'::jsonb
   OR jsonb_typeof(p_scope->'compartments') NOT IN('array','null') OR jsonb_typeof(p_scope->'projectIds') NOT IN('array','null')) THEN false
  ELSE (SELECT CASE
   WHEN scope IS NULL OR jsonb_typeof(scope) IS DISTINCT FROM 'object' OR scope->>'kind' IS DISTINCT FROM 'native_department_v2'
    OR NOT scope ?& ARRAY['kind','tier','departments','contextDepartment','projectLabels','otherLabels','projectIds']
    OR scope-ARRAY['kind','tier','departments','contextDepartment','projectLabels','otherLabels','projectIds']<>'{}'::jsonb
    OR jsonb_typeof(scope->'tier') IS DISTINCT FROM 'number' OR NOT pg_input_is_valid(scope->>'tier','integer') OR (CASE WHEN pg_input_is_valid(scope->>'tier','integer') THEN (scope->>'tier')::int END) NOT BETWEEN 0 AND 3
    OR jsonb_typeof(scope->'departments') NOT IN('object','null') OR jsonb_typeof(scope->'contextDepartment') NOT IN('string','null')
    OR jsonb_typeof(scope->'projectLabels') IS DISTINCT FROM 'array' OR jsonb_array_length(scope->'projectLabels')>256
    OR jsonb_typeof(scope->'otherLabels') NOT IN('array','null') OR jsonb_typeof(scope->'projectIds') NOT IN('array','null') THEN false
   WHEN scope->>'contextDepartment' IS NOT NULL AND NOT pg_input_is_valid(scope->>'contextDepartment','uuid') THEN false
   WHEN scope->'departments'<>'null' AND ((SELECT count(*) FROM jsonb_each(scope->'departments'))>256
    OR EXISTS(SELECT 1 FROM jsonb_each(scope->'departments') item WHERE jsonb_typeof(item.value)<>'number' OR NOT pg_input_is_valid(item.value#>>'{}','integer')
     OR (CASE WHEN pg_input_is_valid(item.value#>>'{}','integer') THEN (item.value#>>'{}')::int END) NOT BETWEEN 0 AND 3)) THEN false
   WHEN scope->'departments'<>'null' AND EXISTS(SELECT 1 FROM jsonb_each(scope->'departments') WHERE NOT pg_input_is_valid(key,'uuid')) THEN false
   WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(scope->'projectLabels') item WHERE jsonb_typeof(item)<>'string') THEN false
   WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(scope->'projectLabels') WHERE NOT pg_input_is_valid(value#>>'{}','uuid')) THEN false
   WHEN scope->'projectIds'<>'null' AND (jsonb_array_length(scope->'projectIds')>256 OR EXISTS(SELECT 1 FROM jsonb_array_elements(scope->'projectIds') item WHERE jsonb_typeof(item)<>'string')) THEN false
   WHEN scope->'projectIds'<>'null' AND EXISTS(SELECT 1 FROM jsonb_array_elements(scope->'projectIds') WHERE NOT pg_input_is_valid(value#>>'{}','uuid')) THEN false
   WHEN scope->'otherLabels'<>'null' AND (jsonb_array_length(scope->'otherLabels')>256
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(scope->'otherLabels') item
     WHERE jsonb_typeof(item)<>'string' OR item#>>'{}' LIKE 'team:%' OR item#>>'{}' LIKE 'project:%')) THEN false
   ELSE true END
   FROM (SELECT CASE WHEN p_scope->>'kind'='native_legacy' THEN (SELECT v FROM fused_c_normalize(p_scope)) ELSE p_scope END scope OFFSET 0) n)
 END
$f$;
CREATE FUNCTION fused_c_union_contains(original jsonb, current_scopes jsonb, budget integer) RETURNS TABLE(v text) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN budget IS NOT NULL AND budget>=5 AND current_scopes=jsonb_build_array(original) AND original IS NOT NULL
   AND (SELECT v FROM fused_c_scope_valid(original)) IS TRUE THEN 'true'
  ELSE application_query_scope_union_contains(original,current_scopes,budget)->>'contains' END
$f$;
CREATE FUNCTION fused_c_principal_query_bounds(w uuid, p_actor uuid, f jsonb) RETURNS TABLE(v jsonb) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN p_actor IS NULL OR agent_visibility_allows(w,NULL,NULL) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.application_query_domains'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN NULL
  WHEN m.member IS NULL THEN NULL
  ELSE (SELECT CASE WHEN s.scope IS NULL OR (SELECT v FROM fused_c_scope_cap((s.scope->>'tier')::int,'null',s.scope->'projectIds')) IS NULL
    OR (SELECT count(*) FROM jsonb_each(CASE WHEN s.scope->'departments'='null' THEN '{}'::jsonb ELSE s.scope->'departments' END))>256
    OR jsonb_array_length(s.scope->'projectLabels')>256 OR s.scope->'otherLabels'<>'null' AND jsonb_array_length(s.scope->'otherLabels')>256 THEN NULL
    ELSE s.scope END
   FROM (SELECT CASE WHEN jsonb_typeof(m.member->'v2')='object' THEN (
     SELECT CASE WHEN b.cap IS NULL OR b.binding IS NULL OR jsonb_typeof(b.binding) NOT IN('array','null')
      OR jsonb_typeof(b.ceiling) NOT IN('array','null')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN b.binding='null' THEN '[]'::jsonb ELSE b.binding END) item WHERE jsonb_typeof(item)<>'string')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN b.ceiling='null' THEN '[]'::jsonb ELSE b.ceiling END) item WHERE jsonb_typeof(item)<>'string') THEN NULL
      WHEN b.v2->>'c' IS NOT NULL AND NOT pg_input_is_valid(b.v2->>'c','uuid') THEN NULL
      ELSE (SELECT CASE WHEN EXISTS(SELECT 1 FROM jsonb_each(d.departments) WHERE NOT pg_input_is_valid(key,'uuid'))
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.labels) WHERE NOT pg_input_is_valid(value#>>'{}','uuid')) THEN NULL
       ELSE jsonb_build_object('kind','native_department_v2','tier',least((b.v2->>'b')::int,b.cap),'departments',d.departments,
        'contextDepartment',b.v2->'c','projectLabels',d.labels,'otherLabels',CASE WHEN b.ceiling='null' THEN 'null'::jsonb ELSE (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM (
         SELECT DISTINCT value FROM jsonb_array_elements(b.ceiling) WHERE value#>>'{}' NOT LIKE 'team:%' AND value#>>'{}' NOT LIKE 'project:%') allowed) END,
        'projectIds',m.projects) END
       FROM (SELECT (SELECT coalesce(jsonb_object_agg(key,least((value#>>'{}')::int,b.cap) ORDER BY key),'{}')
          FROM jsonb_each(b.v2->'d') WHERE (b.binding='null' OR b.binding ? key) AND (b.ceiling='null' OR b.ceiling ? ('team:'||key)) AND least((value#>>'{}')::int,b.cap)>0) departments,
         (SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') FROM (
          SELECT DISTINCT value#>>'{}' AS id FROM jsonb_array_elements((b.v2->'p')||(b.v2->'o'))
          WHERE (b.binding='null' OR b.binding ? (value#>>'{}')) AND (b.ceiling='null' OR b.ceiling ? ('project:'||(value#>>'{}')))) allowed) labels OFFSET 0) d) END
     FROM (SELECT m.member->'v2' v2, m.member->'v2'->'k' binding,
       CASE WHEN nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL AND current_setting('app.v2_active',true) IS DISTINCT FROM 'true'
         AND nullif(current_setting('app.v2_assistant_id',true),'') IS NULL THEN fused_f_rank(current_setting('app.agent_clearance',true)) ELSE 3 END cap,
       CASE WHEN nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL AND current_setting('app.v2_active',true) IS DISTINCT FROM 'true'
         AND nullif(current_setting('app.v2_assistant_id',true),'') IS NULL THEN coalesce(nullif(current_setting('app.agent_compartments',true),'')::jsonb,'[]'::jsonb) ELSE 'null'::jsonb END ceiling OFFSET 0) b)
    ELSE (SELECT CASE WHEN nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL AND fused_f_rank(current_setting('app.agent_clearance',true)) IS NULL THEN NULL
      ELSE (SELECT v FROM fused_c_normalize(jsonb_build_object('kind','native_legacy',
       'tier',CASE WHEN nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL THEN least((m.member->>'r')::int,fused_f_rank(current_setting('app.agent_clearance',true))) ELSE (m.member->>'r')::int END,
       'compartments',li.teams,'projectIds',m.projects))) END
     FROM (SELECT (SELECT v FROM fused_c_set_intersection(m.member->'c',coalesce(nullif(current_setting('app.agent_compartments',true),'')::jsonb,'null'::jsonb))) teams OFFSET 0) li)
    END scope OFFSET 0) s) END
 FROM (SELECT (SELECT v FROM fused_c_member_principal_grants(p_actor,false,w))->w::text member,
   coalesce(nullif(current_setting('app.agent_project_ids',true),'')::jsonb,'null'::jsonb) projects OFFSET 0) m
$f$;
CREATE FUNCTION fused_c_memory_catalog(w uuid) RETURNS TABLE(v jsonb) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM application_native_resource_owners o JOIN application_native_field_contracts c USING(module_key)
  WHERE o.workspace_id=w AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type='memory') THEN '{"registered":false}'::jsonb
  ELSE fused_c_decline('registered memory catalog',NULL::jsonb) END
$f$;
CREATE FUNCTION fused_c_member_field_permissions(w uuid, policy jsonb, member_id uuid) RETURNS TABLE(v jsonb) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=member_id) THEN NULL
  ELSE (WITH roles AS MATERIALIZED (SELECT coalesce(array_agg(DISTINCT a.role_key),'{}') roles FROM application_native_role_assignments a
    WHERE a.workspace_id=w AND a.module_key=policy#>>'{metadata,moduleKey}' AND a.user_id=member_id AND a.status='active'
     AND a.starts_at<=statement_timestamp() AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp()) AND (policy->'roleKeys') ? a.role_key),
   fields AS MATERIALIZED(SELECT value FROM jsonb_array_elements(policy#>'{metadata,fields}')),
   rules AS(SELECT value->'read' rule FROM fields UNION SELECT value->'write' FROM fields),
   decisions AS MATERIALIZED(SELECT rule,NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rule) clause WHERE NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(clause) role WHERE role=ANY((SELECT roles FROM roles)::text[]))) allowed FROM rules)
   SELECT jsonb_build_object(
    'read',ARRAY(SELECT f.value->>'key' FROM fields f JOIN decisions d ON d.rule IS NOT DISTINCT FROM f.value->'read' WHERE d.allowed ORDER BY 1),
    'write',ARRAY(SELECT f.value->>'key' FROM fields f JOIN decisions d ON d.rule IS NOT DISTINCT FROM f.value->'write' WHERE d.allowed ORDER BY 1))) END
$f$;
CREATE FUNCTION fused_c_memory_context(w uuid, f jsonb) RETURNS TABLE(ctx jsonb) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN a.actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS DISTINCT FROM w::text
  OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=a.actor)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.memories'::regclass WHERE r.rolname=session_user
   AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN NULL
  WHEN jsonb_typeof(a.ceilings) IS DISTINCT FROM 'array' OR jsonb_array_length(a.ceilings)>16 THEN NULL
  WHEN jsonb_array_length(a.ceilings)>0 THEN fused_c_decline('memory context ceilings',NULL::jsonb)
  ELSE (SELECT CASE WHEN b.bounds IS NULL OR (SELECT v FROM fused_c_scope_valid(b.bounds)) IS NOT TRUE THEN NULL
   ELSE (SELECT CASE WHEN (SELECT v FROM fused_c_visible(f,w,p.policy#>'{metadata,scope}')) IS NOT TRUE OR jsonb_typeof(p.mask->'read') IS DISTINCT FROM 'array' THEN NULL
     ELSE jsonb_build_object('policy',p.policy,'read',p.mask->'read','bounds',b.bounds,
      'visibility',jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE a.actor END,
       'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb))) END
    FROM (SELECT q.policy,(SELECT v FROM fused_c_member_field_permissions(w,q.policy,a.actor)) mask
     FROM (SELECT jsonb_build_object('registered',true,'held',false,'nativeDefault',true,'roleKeys','[]'::jsonb,
       'metadata',jsonb_build_object('moduleKey','native','origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey','memory',
        'schemaVersion','memory-fields-v1','policyVersion','memory-fields-v1','fieldKeys',k.keys,'fields',k.fields,'scope',k.scope),
       'fingerprint',fused_f_digest(jsonb_build_object('kind','memory-fields-v1','workspaceId',w,'fields',k.fields))) policy
      FROM (SELECT kk.keys,(SELECT jsonb_agg(jsonb_build_object('key',key,'read','[]'::jsonb,'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key) FROM unnest(kk.keys) key) fields,
        jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb) scope
       FROM (SELECT ARRAY(SELECT key FROM unnest(fused_c_memory_field_keys()) key ORDER BY key) keys OFFSET 0) kk
       WHERE (SELECT v FROM fused_c_memory_catalog(w))->>'registered'='false' OFFSET 0) k OFFSET 0) q OFFSET 0) p) END
   FROM (SELECT CASE WHEN nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN NULL
     ELSE (SELECT v FROM fused_c_principal_query_bounds(w,a.actor,f)) END bounds OFFSET 0) b)
 END
 FROM (SELECT nullif(current_setting('app.current_user_id',true),'')::uuid actor,
  coalesce(nullif(current_setting('app.native_query_data_ceilings',true),'')::jsonb,'[]'::jsonb) ceilings OFFSET 0) a
$f$;
CREATE FUNCTION fused_c_facts4(w uuid, need_memory boolean) RETURNS TABLE(f jsonb) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN nullif(current_setting('app.current_user_id',true),'') IS NULL THEN '{}'::jsonb
  ELSE p.f||CASE WHEN need_memory THEN jsonb_build_object('memCtx',(SELECT ctx FROM fused_c_memory_context(w,p.f))) ELSE '{}'::jsonb END END
 FROM (SELECT f FROM fused_c_principal_facts(w) OFFSET 0) p
$f$;
CREATE FUNCTION fused_c_envelope_valid(s jsonb) RETURNS TABLE(v boolean) LANGUAGE sql IMMUTABLE AS $f$
 SELECT CASE WHEN (jsonb_typeof(s)='object'
    AND s ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']
    AND jsonb_typeof(s->'workspaceId')='string' AND (s->>'workspaceId') ~ u.p
    AND (s->'userId'='null'::jsonb OR (jsonb_typeof(s->'userId')='string' AND (s->>'userId') ~ u.p))
    AND (s->'assistantId'='null'::jsonb OR (jsonb_typeof(s->'assistantId')='string' AND (s->>'assistantId') ~ u.p))
    AND jsonb_typeof(s->'sensitivity')='string' AND s->>'sensitivity' IN ('public','internal','confidential')
    AND jsonb_typeof(s->'compartments')='array' AND jsonb_typeof(s->'projectIds')='array') IS NOT TRUE THEN false
  WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(s->'compartments') item
    WHERE (jsonb_typeof(item)='string' AND btrim(item #>> '{}')<>'') IS NOT TRUE)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'projectIds') item
    WHERE (jsonb_typeof(item)='string' AND (item #>> '{}') ~ u.p) IS NOT TRUE) THEN false
  ELSE true END
 FROM (SELECT '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text p) u
$f$;
CREATE FUNCTION fused_l_envelope_memory(facts jsonb, w uuid, t text, i uuid, selection text, fields text[], memo jsonb, obs_scope jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET plan_cache_mode=force_generic_plan AS $f$
BEGIN
 IF t IS DISTINCT FROM 'memory' OR selection IS DISTINCT FROM 'query_domain' OR NOT facts ? 'memCtx' OR coalesce(memo->>'hasExternal','true')='true' THEN
  RETURN fused_c_decline('envelope shape',NULL::jsonb); END IF;
 RETURN (WITH k AS MATERIALIZED (SELECT ARRAY(SELECT DISTINCT key FROM unnest(fields) key ORDER BY key) keys,
   CASE WHEN facts->'memCtx'='null'::jsonb THEN NULL ELSE facts->'memCtx' END ctx),
  fr AS MATERIALIZED (SELECT q.* FROM application_query_domains q, k WHERE q.workspace_id=w AND q.id=i AND q.origin='{"kind":"native","moduleKey":"native"}' AND q.type_key='memory'),
  lk_ws AS MATERIALIZED (SELECT id FROM workspaces WHERE id=w FOR SHARE NOWAIT),
  lk_ce AS MATERIALIZED (SELECT singleton FROM application_policy_contract_epoch WHERE singleton FOR SHARE NOWAIT),
  lk_we AS MATERIALIZED (SELECT workspace_id FROM application_policy_workspace_epochs WHERE workspace_id=w FOR SHARE NOWAIT),
  derivation AS MATERIALIZED (SELECT EXISTS(SELECT 1 FROM pg_proc canonical_proc JOIN pg_proc candidate_proc
   ON candidate_proc.oid='public.application_memory_query_candidate_state(uuid,uuid,text[],jsonb)'::regprocedure
   WHERE canonical_proc.oid='public.application_memory_field_state_before_successor(uuid,uuid,text[])'::regprocedure
    AND array_length(string_to_array(canonical_proc.prosrc,'context:=application_memory_query_context(w);'),1)=2
    AND candidate_proc.prosrc=replace(canonical_proc.prosrc,'context:=application_memory_query_context(w);','context:=admitted_context;')
    AND ROW(candidate_proc.proowner,candidate_proc.prosecdef,candidate_proc.proconfig,candidate_proc.prolang,candidate_proc.provolatile,candidate_proc.proparallel,candidate_proc.proisstrict,candidate_proc.prorettype,candidate_proc.proretset,candidate_proc.prokind,candidate_proc.proleakproof)
     IS NOT DISTINCT FROM ROW(canonical_proc.proowner,canonical_proc.prosecdef,canonical_proc.proconfig,canonical_proc.prolang,canonical_proc.provolatile,canonical_proc.proparallel,canonical_proc.proisstrict,canonical_proc.prorettype,canonical_proc.proretset,canonical_proc.prokind,canonical_proc.proleakproof)) ok),
  -- application_memory_query_domain_state(w,i,keys)
  st AS MATERIALIZED (SELECT CASE
   WHEN NOT EXISTS(SELECT 1 FROM fr) OR (SELECT domain FROM fr)->>'kind' IS DISTINCT FROM 'memory_query_domain_v1'
    OR (SELECT domain FROM fr)-ARRAY['kind','fields','bounds','visibility','includeRetained','candidates','policies']<>'{}'
    OR (SELECT domain FROM fr)->'fields' IS DISTINCT FROM to_jsonb(k.keys) THEN NULL
   WHEN k.ctx IS NULL OR k.ctx#>>'{policy,metadata,schemaVersion}' IS DISTINCT FROM (SELECT schema_version FROM fr)
    OR NOT coalesce(to_jsonb(k.keys)<@(k.ctx->'read'),false)
    OR (SELECT u.v FROM fr, LATERAL fused_c_union_contains(fr.domain->'bounds',jsonb_build_array(k.ctx->'bounds'),4096) u) IS DISTINCT FROM 'true'
    OR (SELECT domain FROM fr)->'visibility' IS DISTINCT FROM k.ctx->'visibility' THEN NULL
   -- application_memory_historical_query_scan(w,keys,bounds,includeRetained,domain)
   WHEN k.keys IS NULL OR NOT k.keys<@fused_c_memory_field_keys() OR (SELECT sv.v FROM fr, LATERAL fused_c_scope_valid(fr.domain->'bounds') sv) IS NOT TRUE
    OR ((SELECT domain FROM fr)->>'includeRetained')::boolean IS NULL THEN NULL
   WHEN NOT EXISTS(SELECT 1 FROM lk_ws) OR NOT EXISTS(SELECT 1 FROM lk_ce) OR NOT EXISTS(SELECT 1 FROM lk_we)
    OR (SELECT ok FROM derivation) IS NOT TRUE OR k.ctx#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' THEN fused_c_decline('scan context',NULL::jsonb)
   WHEN EXISTS(SELECT 1 FROM memories WHERE workspace_id=w) THEN fused_c_decline('memory candidates',NULL::jsonb)
   WHEN '[]'::jsonb IS DISTINCT FROM (SELECT domain FROM fr)->'candidates' OR '[]'::jsonb IS DISTINCT FROM (SELECT domain FROM fr)->'policies' THEN NULL
   ELSE jsonb_build_object('values','{}'::jsonb,'source',k.ctx#>'{policy,metadata,scope}','recordVersion',(SELECT schema_version FROM fr),
    'sourceKind','application_query_domain','sourceId',i,'sourceVersion',(SELECT identity FROM fr),'ownerId',NULL,
    'fieldIdentity',fused_f_digest(jsonb_build_object('kind','memory_query_domain_v1','identity',(SELECT identity FROM fr),'fields',k.keys)),
    'policyVersion',fused_f_digest(jsonb_build_object('kind','memory_query_domain_v1','identity',(SELECT identity FROM fr),'policy',k.ctx#>'{policy,fingerprint}','policies','[]'::jsonb)),
    'references','[]'::jsonb) END state FROM k),
  sc AS MATERIALIZED (SELECT st.state,jsonb_build_object('workspaceId',w,'userId',st.state#>'{source,userId}','assistantId',st.state#>'{source,assistantId}',
   'sensitivity',st.state#>'{source,sensitivity}','compartments',st.state#>'{source,compartments}','projectIds',st.state#>'{source,projectIds}') scope FROM st),
  idn AS MATERIALIZED (SELECT fused_f_digest(jsonb_build_object('workspaceId',w,'origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey',t,'id',i,
   'selection',selection,'selectedVersion',NULL,'fields',k.keys,'fieldIdentity',sc.state->'fieldIdentity')) identity FROM sc,k)
  SELECT CASE WHEN fields IS NULL OR cardinality(k.keys)<>cardinality(fields) THEN '{}'::jsonb
   WHEN sc.state IS NULL OR sc.state='null'::jsonb THEN '{}'::jsonb
   WHEN (SELECT v FROM fused_c_envelope_valid(sc.scope)) IS NOT TRUE THEN '{}'::jsonb
   ELSE jsonb_build_object('value',jsonb_build_object('resourceId',fused_f_uuid(idn.identity),'identity',idn.identity,'origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey',t,'id',i,
    'selection',selection,'selectedVersion',NULL,'fields',k.keys,'fieldIdentity',sc.state->'fieldIdentity','state',sc.state,'children','[]'::jsonb,'sources','[]'::jsonb,
    'source',sc.scope||jsonb_build_object('resourceKind','application_field','resourceId',fused_f_uuid(idn.identity),'version',fused_f_digest(jsonb_build_object('resourceId',fused_f_uuid(idn.identity),
     'recordVersion',sc.state->'recordVersion','sourceVersion',sc.state->'sourceVersion','policyVersion',sc.state->'policyVersion','scope',sc.scope,'sources','[]'::jsonb)))))
    ||CASE WHEN obs_scope IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('fa_vis',jsonb_build_array((SELECT v1.v FROM fused_c_visible(facts,w,obs_scope) v1),
     (SELECT v2.v FROM fused_c_visible(facts,w,sc.scope||jsonb_build_object('resourceKind','application_field','resourceId',fused_f_uuid(idn.identity),'version',fused_f_digest(jsonb_build_object('resourceId',fused_f_uuid(idn.identity),
     'recordVersion',sc.state->'recordVersion','sourceVersion',sc.state->'sourceVersion','policyVersion',sc.state->'policyVersion','scope',sc.scope,'sources','[]'::jsonb)))) v2))) END END
  FROM k,sc,idn);
END $f$;
CREATE FUNCTION fused_l_message_snapshot(facts jsonb, w uuid, i uuid, archive_denied jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET plan_cache_mode=force_generic_plan AS $f$
BEGIN
 RETURN (WITH g AS MATERIALIZED (SELECT nullif(current_setting('app.current_user_id',true),'')::uuid actor,
   nullif(current_setting('app.v2_assistant_id',true),'')::uuid acting),
  ws AS MATERIALIZED (SELECT department_read_v2 v2 FROM workspaces WHERE id=w FOR SHARE),
  mem AS MATERIALIZED (SELECT role FROM workspace_members WHERE workspace_id=w AND user_id=(SELECT actor FROM g) FOR SHARE),
  ast AS MATERIALIZED (SELECT id FROM assistants WHERE workspace_id=w AND id=(SELECT acting FROM g) FOR SHARE),
  par AS MATERIALIZED (SELECT s.* FROM sessions s
   JOIN session_messages m ON m.session_id=s.id
   JOIN assistants a ON a.id=s.assistant_id AND a.workspace_id=w
   WHERE m.id=i AND m.workspace_id=w AND (s.workspace_id IS NULL OR s.workspace_id=w)
   FOR SHARE OF s),
  grp AS MATERIALIZED (SELECT id FROM workspace_groups WHERE id=(SELECT context_group_id FROM par) AND workspace_id=w AND kind='team' AND status='active' FOR SHARE),
  teams AS MATERIALIZED (SELECT id FROM workspace_groups WHERE workspace_id=w AND kind='team' ORDER BY id FOR SHARE),
  edges AS MATERIALIZED (SELECT id FROM department_edges WHERE workspace_id=w AND (user_id=(SELECT actor FROM g) OR assistant_id=(SELECT acting FROM g)) ORDER BY id FOR SHARE),
  msg AS MATERIALIZED (SELECT jsonb_build_object('workspaceId',m.workspace_id,'userId',m.user_id,'assistantId',m.assistant_id,
   'sensitivity',m.sensitivity,'compartments',m.compartments,'projectIds',m.project_ids,'resourceKind','session_message','resourceId',i,
   'version',m.scope_version::text,'held',m.scope_held,'validTo',NULL,'retractedAt',NULL) snapshot
   FROM session_messages m WHERE m.workspace_id=w AND m.id=i AND m.scope_version IS NOT NULL FOR SHARE),
  pj AS MATERIALIZED (SELECT ARRAY(SELECT jsonb_array_elements_text((SELECT snapshot FROM msg)->'projectIds')::uuid)
    ||CASE WHEN (SELECT context_project_id FROM par) IS NOT NULL THEN ARRAY[(SELECT context_project_id FROM par)] ELSE '{}'::uuid[] END projects),
  pl AS MATERIALIZED (SELECT id FROM workspace_projects WHERE workspace_id=w AND id=ANY((SELECT projects FROM pj)::uuid[]) ORDER BY id FOR SHARE)
  SELECT CASE
   WHEN jsonb_typeof(archive_denied) IS DISTINCT FROM 'object' OR archive_denied ? ('session_message:'||i) THEN NULL
   WHEN nullif(current_setting('app.application_id',true),'') IS NOT NULL OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN NULL
   WHEN g.actor IS NULL
    OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w)
    OR (nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>g.actor) THEN NULL
   WHEN NOT EXISTS(SELECT 1 FROM ws) THEN NULL
   WHEN NOT EXISTS(SELECT 1 FROM mem) THEN NULL
   WHEN g.acting IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM ast) OR (SELECT v FROM fused_c_placement_visible(g.actor,g.acting)) IS NOT TRUE) THEN NULL
   WHEN NOT EXISTS(SELECT 1 FROM par) OR ((SELECT visibility FROM par)='personal' AND (SELECT user_id FROM par) IS DISTINCT FROM g.actor)
    OR ((SELECT visibility FROM par)='workspace' AND (SELECT workspace_id FROM par) IS DISTINCT FROM w) THEN NULL
   WHEN (SELECT context_group_id FROM par) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM grp) THEN NULL
   WHEN (SELECT count(*) FROM teams)<0 OR (SELECT count(*) FROM edges)<0 THEN NULL
   WHEN (SELECT vv.v FROM par p, LATERAL fused_c_visible(facts,w,jsonb_build_object(
     'workspaceId',w,'userId',CASE WHEN p.visibility='personal' THEN p.user_id ELSE NULL END,
     'assistantId',NULL,'sensitivity',coalesce(p.effective_clearance,'public'),
     'compartments',to_jsonb(coalesce(p.context_compartments,'{}'::text[])),
     'projectIds',CASE WHEN p.context_project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p.context_project_id) END)) vv) IS NOT TRUE THEN NULL
   WHEN (SELECT snapshot FROM msg) IS NULL OR (SELECT snapshot FROM msg)->>'held' IS DISTINCT FROM 'false'
    OR (SELECT snapshot FROM msg)->>'validTo' IS NOT NULL OR (SELECT snapshot FROM msg)->>'retractedAt' IS NOT NULL
    OR EXISTS(SELECT 1 FROM scope_resource_states s WHERE s.resource_kind='session_message' AND s.resource_id=i AND s.review_state='held')
    OR agent_visibility_allows(w,((SELECT snapshot FROM msg)->>'userId')::uuid,((SELECT snapshot FROM msg)->>'assistantId')::uuid) IS NOT TRUE
    OR (SELECT vv.v FROM msg, LATERAL fused_c_visible(facts,w,msg.snapshot) vv) IS NOT TRUE THEN NULL
   WHEN ((SELECT visibility FROM par)='personal' AND (SELECT snapshot FROM msg)->>'userId' IS DISTINCT FROM (SELECT user_id FROM par)::text)
    OR NOT((SELECT snapshot FROM msg)->'compartments' @> to_jsonb(coalesce((SELECT context_compartments FROM par),'{}'::text[])))
    OR ((SELECT context_project_id FROM par) IS NOT NULL
     AND NOT((SELECT snapshot FROM msg)->'projectIds' @> jsonb_build_array((SELECT context_project_id FROM par))
      OR (SELECT snapshot FROM msg)->'compartments' @> jsonb_build_array('project:'||(SELECT context_project_id FROM par)::text))) THEN NULL
   WHEN (SELECT count(*) FROM pl)<0 THEN NULL
   WHEN EXISTS(SELECT 1 FROM unnest((SELECT projects FROM pj)) p WHERE NOT EXISTS(
     SELECT 1 FROM workspace_projects pr WHERE pr.workspace_id=w AND pr.id=p AND pr.status='active'
      AND ((SELECT v2 FROM ws) OR (SELECT role FROM mem) IN('owner','admin') OR EXISTS(SELECT 1 FROM workspace_project_members pm WHERE pm.project_id=p AND pm.user_id=g.actor)))) THEN NULL
   ELSE (SELECT snapshot FROM msg) END
  FROM g);
END $f$;
CREATE FUNCTION fused_l_transcript(w uuid, i uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET plan_cache_mode=force_generic_plan AS $f$
BEGIN
 RETURN (WITH o AS MATERIALIZED (SELECT * FROM private_transcript_observations WHERE workspace_id=w AND id=i),
  lws AS MATERIALIZED (SELECT id FROM workspaces WHERE id=w FOR SHARE),
  lmem AS MATERIALIZED (SELECT user_id FROM workspace_members WHERE workspace_id=w AND user_id=(SELECT user_id FROM o) FOR SHARE),
  ls AS MATERIALIZED (SELECT * FROM sessions WHERE id=(SELECT session_id FROM o) FOR SHARE),
  lo AS MATERIALIZED (SELECT id FROM private_transcript_observations WHERE id=i FOR SHARE),
  items AS MATERIALIZED (SELECT m.*,entry.value expected FROM jsonb_each_text((SELECT manifest FROM o)) entry
   JOIN session_messages m ON m.id=entry.key::uuid AND m.session_id=(SELECT session_id FROM o) ORDER BY entry.key FOR SHARE OF m)
  SELECT CASE
   WHEN nullif(current_setting('app.application_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM private_transcript_observations x WHERE x.workspace_id=w AND x.id=i
      AND x.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid) THEN NULL
   WHEN NOT EXISTS(SELECT 1 FROM o) THEN '{"held":true}'::jsonb
   WHEN (SELECT count(*) FROM lws)<0 THEN NULL
   WHEN NOT EXISTS(SELECT 1 FROM lmem) THEN '{"held":true}'::jsonb
   WHEN NOT EXISTS(SELECT 1 FROM ls) OR (SELECT user_id FROM ls)<>(SELECT user_id FROM o)
    OR (SELECT jsonb_build_array(s.id,s.user_id,s.assistant_id,s.workspace_id,s.visibility,
       s.channel_type,s.channel_id,s.app_origin,s.anchor_kind,s.mode,s.context_group_id,
       s.context_project_id,s.context_compartments,s.effective_clearance,s.context_binding_origin) FROM ls s) IS DISTINCT FROM (SELECT binding FROM o)
    OR coalesce((SELECT NOT x.recording_privacy_held FROM sessions x WHERE x.id=(SELECT id FROM ls)),false) IS NOT TRUE
    OR EXISTS(SELECT 1 FROM scope_resource_states s WHERE s.resource_kind='session' AND s.resource_id=(SELECT id FROM ls) AND s.review_state='held') IS TRUE
    OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=(SELECT user_id FROM o))
    OR NOT EXISTS(SELECT 1 FROM assistants WHERE id=(SELECT assistant_id FROM ls) AND workspace_id=w) THEN '{"held":true}'::jsonb
   WHEN (SELECT count(*) FROM lo)<0 THEN NULL
   WHEN EXISTS(SELECT 1 FROM jsonb_object_keys((SELECT manifest FROM o)) AS entry(message_id) WHERE NOT EXISTS(SELECT 1 FROM session_messages m WHERE m.id=entry.message_id::uuid AND m.session_id=(SELECT session_id FROM o))) THEN '{"held":true}'::jsonb
   WHEN EXISTS(SELECT 1 FROM items item WHERE item.id IS NULL OR item.scope_held IS TRUE
     OR EXISTS(SELECT 1 FROM scope_resource_states s WHERE s.resource_kind='session_message' AND s.resource_id=item.id AND s.review_state='held') IS TRUE
     OR (SELECT encode(sha256(convert_to(jsonb_build_array(m.id,m.session_id,m.role,m.content,m.sequence_num,
       to_jsonb((to_jsonb(m.created_at AT TIME ZONE 'UTC')#>>'{}')||'+00:00'),
       m.workspace_id,m.user_id,m.assistant_id,m.sensitivity,m.compartments,m.project_ids,m.scope_version,m.scope_held,
       m.sender_user_id,m.sender_assistant_id)::text,'UTF8')),'hex') FROM session_messages m WHERE m.id=item.id) IS DISTINCT FROM item.expected) THEN '{"held":true}'::jsonb
   ELSE (SELECT jsonb_build_object('workspaceId',w,'resourceKind','private_transcript','resourceId',i,'version','1',
    'userId',x.user_id,'assistantId',NULL,'sensitivity',x.sensitivity,'compartments',x.compartments,'projectIds',x.project_ids,
    'held',false,'validTo',NULL,'retractedAt',NULL) FROM o x) END);
END $f$;
CREATE FUNCTION fused_c_policy_epoch(w uuid, actor uuid, acting uuid) RETURNS TABLE(v jsonb) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM workspaces WHERE id=w)
  OR NOT EXISTS(SELECT 1 FROM users WHERE id=actor)
  OR NOT EXISTS(SELECT 1 FROM assistants WHERE id=acting AND workspace_id=w) THEN NULL
  WHEN EXISTS(SELECT 1 FROM application_native_field_contracts c WHERE EXISTS(
   SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w AND o.module_key=c.module_key)) THEN fused_c_decline('policy epoch contracts',NULL::jsonb)
  ELSE jsonb_build_object('version',1,'workspaceId',w,'principalId',actor,'assistantId',acting,
   'workspaceRevision',coalesce((SELECT e.revision::text FROM application_policy_workspace_epochs e WHERE e.workspace_id=w),'0'),
   'contractRevision',(SELECT e.revision::text FROM application_policy_contract_epoch e),
   'timedState',fused_f_digest(jsonb_build_object(
    'roles',(SELECT jsonb_agg(a.id ORDER BY a.id) FROM application_native_role_assignments a WHERE a.workspace_id=w
     AND a.status='active' AND a.starts_at<=statement_timestamp() AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp())),
    'departments',(SELECT jsonb_agg(d.id ORDER BY d.id) FROM department_edges d WHERE d.workspace_id=w AND (d.expires_at IS NULL OR d.expires_at>statement_timestamp())),
    'projects',(SELECT jsonb_agg(p.id ORDER BY p.id) FROM project_shared_members p WHERE p.workspace_id=w AND (p.expires_at IS NULL OR p.expires_at>statement_timestamp())))),
   'modules','[]'::jsonb) END
$f$;
CREATE FUNCTION fused_c_session_department_facts(uuid, uuid, uuid) RETURNS TABLE(snapshot jsonb) LANGUAGE sql STABLE AS $f$
WITH member AS MATERIALIZED (
    SELECT role, clearance FROM workspace_members WHERE workspace_id=$1 AND user_id=$2
  ), active_projects AS MATERIALIZED (
    SELECT s.project_id FROM project_shared_scopes s JOIN workspaces w ON w.id=s.workspace_id
    WHERE s.workspace_id=$1 AND s.status='active' AND w.project_shared_spaces
  ) SELECT jsonb_build_object(
    'member', (SELECT to_jsonb(m) FROM member m),
    'assistant', (SELECT jsonb_build_object('clearance',a.clearance) FROM assistants a
      WHERE a.id=$3 AND a.workspace_id=$1 AND (SELECT v FROM fused_c_placement_visible($2,a.id))),
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
$f$;
CREATE FUNCTION fused_c_authority_facts(uuid, uuid, uuid, uuid, uuid, integer, uuid, boolean, boolean) RETURNS TABLE(facts jsonb) LANGUAGE sql STABLE AS $f$
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
    'policy', CASE WHEN $9::boolean THEN (SELECT v FROM fused_c_policy_epoch($1,$2,$3)) ELSE NULL END,
    'session', (SELECT jsonb_build_object('id',s.id,'assistantId',s.assistant_id,'userId',s.user_id,
      'contextGroupId',s.context_group_id,'contextProjectId',s.context_project_id,'contextLockedAt',s.context_locked_at,'appOrigin',s.app_origin,'anchorKind',s.anchor_kind,'anchorRef',s.anchor_ref,'channelType',s.channel_type,'channelId',s.channel_id,
      'visibility',s.visibility,'mode',s.mode,'effectiveClearance',s.effective_clearance,'contextCompartments',s.context_compartments)
      FROM sessions s WHERE s.id=$4 AND coalesce((SELECT NOT x.recording_privacy_held FROM sessions x WHERE x.id=s.id),false)),
    'assistant', (SELECT jsonb_build_object('id',a.id,'workspaceId',a.workspace_id,'kind',a.kind,
      'clearance',a.clearance,'compartments',a.compartments,'defaultCompartments',a.default_compartments,
      'teamScopeMode',a.team_scope_mode,'defaultWorkspaceGroupId',a.default_workspace_group_id,
      'projectScopeMode',a.project_scope_mode,'defaultProjectId',a.default_project_id)
      FROM assistants a WHERE a.id=$3),
    'member', (SELECT jsonb_build_object('role',m.role,'clearance',m.clearance,
      'readCompartments',(SELECT v FROM fused_c_member_read(m.user_id,m.workspace_id)),
      'mutationCompartments',(SELECT v FROM fused_c_member_team(m.user_id,m.workspace_id)),
      'departmentReadV2',(SELECT to_jsonb(w)->>'department_read_v2' FROM workspaces w WHERE w.id=$1))
      FROM workspace_members m WHERE m.workspace_id=$1 AND m.user_id=$2),
    'department', CASE WHEN $8::boolean AND EXISTS(SELECT 1 FROM workspaces WHERE id=$1 AND department_read_v2)
      THEN (SELECT snapshot FROM fused_c_session_department_facts($1,$2,$3)) ELSE NULL END,
    'credentialCurrent', CASE WHEN $5::uuid IS NULL THEN true ELSE $7::uuid=$2 AND EXISTS(
      SELECT 1 FROM users u JOIN auth_sessions s ON s.user_id=u.id
      WHERE u.id=$2 AND u.auth_version=$6 AND s.id=$5 AND s.auth_version=$6
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) END
    ) AS facts
$f$;
CREATE FUNCTION fused_c_personal_audience(s sessions) RETURNS boolean LANGUAGE sql STABLE AS $f$
 SELECT s.visibility='personal' AND s.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
$f$;
CREATE FUNCTION fused_c_workspace_audience(s sessions) RETURNS TABLE(v boolean) LANGUAGE sql STABLE AS $f$
 SELECT s.visibility='workspace' AND s.workspace_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=s.workspace_id
   AND wm.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
   AND fused_f_rank(s.effective_clearance)<=fused_f_rank(wm.clearance)
   AND ((SELECT v FROM fused_c_member_team(wm.user_id,wm.workspace_id)) IS NULL
    OR s.context_compartments <@ (SELECT v FROM fused_c_member_team(wm.user_id,wm.workspace_id))))
 AND (s.anchor_kind<>'doc_thread' OR EXISTS(
  SELECT 1 FROM comment_threads ct JOIN saved_views p ON p.id=ct.page_id AND p.workspace_id=ct.workspace_id
  WHERE ct.session_id=s.id AND ct.workspace_id=s.workspace_id))
$f$;
CREATE FUNCTION fused_c_project_labels_allowed(grants jsonb, w uuid, labels text[], mutation boolean) RETURNS TABLE(v boolean) LANGUAGE sql IMMUTABLE AS $f$
  SELECT NOT EXISTS (
    SELECT 1 FROM unnest(coalesce(labels, '{}'::text[])) AS k
     WHERE k LIKE 'project:%'
       AND NOT (w IS NOT NULL AND coalesce(((grants -> w::text) -> 'p') ? substr(k, 9), false))
       AND NOT (NOT mutation AND w IS NOT NULL AND coalesce(((grants -> w::text) -> 'o') ? substr(k, 9), false)))
$f$;
CREATE FUNCTION fused_c_project_audience(s sessions, mutation boolean) RETURNS TABLE(v boolean) LANGUAGE sql STABLE AS $f$
 SELECT (SELECT v FROM fused_c_project_labels_allowed(g.grants,s.workspace_id,s.context_compartments,mutation))
 FROM (SELECT (SELECT v FROM fused_c_dept_grants()) grants OFFSET 0) g
$f$;
CREATE FUNCTION fused_c_parent_precheck(w uuid, i uuid) RETURNS TABLE(ok boolean) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN NOT coalesce((SELECT NOT x.recording_privacy_held FROM sessions x WHERE x.id=i),false) THEN false
  WHEN a.actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
   OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
   OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w
   OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>a.actor
   OR a.acting IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM assistants x WHERE x.workspace_id=w AND x.id=a.acting)
    OR (SELECT v FROM fused_c_placement_visible(a.actor,a.acting)) IS NOT TRUE) THEN false
  ELSE true END
 FROM (SELECT nullif(current_setting('app.current_user_id',true),'')::uuid actor, nullif(current_setting('app.v2_assistant_id',true),'')::uuid acting OFFSET 0) a
$f$;
CREATE FUNCTION fused_c_parent_from_row(w uuid, s sessions) RETURNS TABLE(v jsonb) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN s.id IS NULL OR NOT coalesce(fused_c_personal_audience(s) OR (SELECT v FROM fused_c_workspace_audience(s)),false)
   OR (SELECT v FROM fused_c_project_audience(s,false)) IS NOT TRUE THEN NULL
  WHEN lf.live IS NULL OR s.context_compartments IS NULL THEN NULL
  ELSE jsonb_build_object('workspaceId',w,'userId',CASE WHEN s.visibility='personal' THEN s.user_id ELSE NULL END,
   'assistantId',NULL,'sensitivity',lf.live,'compartments',s.context_compartments,
   'projectIds',CASE WHEN s.context_project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(s.context_project_id) END,
   'assistant',s.assistant_id,'createdBy',s.user_id) END
 FROM (SELECT CASE WHEN s.effective_clearance IS NOT NULL OR s.visibility IS DISTINCT FROM 'personal' THEN s.effective_clearance
   ELSE (SELECT CASE WHEN x.live IS NULL OR x.live NOT IN('public','internal','confidential') THEN NULL
     WHEN x.inv IS NULL THEN x.live WHEN x.inv NOT IN('public','internal','confidential') THEN NULL
     WHEN fused_f_rank(x.inv)<fused_f_rank(x.live) THEN x.inv ELSE x.live END
    FROM (SELECT (SELECT CASE WHEN fused_f_rank(a.clearance)<=fused_f_rank(wm.clearance) THEN a.clearance ELSE wm.clearance END
       FROM assistants a JOIN workspace_members wm ON wm.workspace_id=a.workspace_id
       WHERE a.workspace_id=w AND a.id=coalesce(nullif(current_setting('app.v2_assistant_id',true),'')::uuid,s.assistant_id)
        AND wm.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid) live,
      nullif(current_setting('app.agent_clearance',true),'') inv OFFSET 0) x) END live OFFSET 0) lf
$f$;
CREATE FUNCTION fused_c_query_parent(facts jsonb, w uuid, ok boolean, s sessions) RETURNS TABLE(v jsonb) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN ok IS NOT TRUE OR p.parent IS NULL OR (SELECT vv.v FROM fused_c_visible(facts,w,p.parent) vv) IS NOT TRUE THEN NULL
  WHEN b.binding IS NULL THEN NULL
  ELSE jsonb_build_object('scope',p.parent-ARRAY['assistant','createdBy'],'fingerprint',fused_f_digest(b.binding)) END
 FROM (SELECT CASE WHEN ok IS TRUE THEN (SELECT v FROM fused_c_parent_from_row(w,s)) END parent OFFSET 0) p,
  (SELECT (SELECT jsonb_build_object('id',x.id,'workspaceId',x.workspace_id,'assistantId',x.assistant_id,'userId',x.user_id,
   'visibility',x.visibility,'anchorKind',x.anchor_kind,'anchorRef',x.anchor_ref,'mode',x.mode,'channelType',x.channel_type,
   'channelId',x.channel_id,'appId',x.app_id,'contextGroupId',x.context_group_id,'contextProjectId',x.context_project_id,
   'contextCompartments',x.context_compartments,'effectiveClearance',x.effective_clearance) FROM sessions x WHERE x.workspace_id=w AND x.id=s.id) binding OFFSET 0) b
$f$;
CREATE FUNCTION fused_c_session_query_bounds(w uuid, parent jsonb) RETURNS TABLE(v jsonb) LANGUAGE sql STABLE AS $f$
 SELECT CASE WHEN b.bounds IS NULL THEN
   CASE WHEN parent IS NULL OR parent#>>'{scope,userId}' IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')
    OR parent#>>'{scope,sensitivity}' IS DISTINCT FROM 'public' THEN NULL
    ELSE (SELECT CASE WHEN (SELECT v FROM fused_c_scope_valid(c.cap)) IS NOT TRUE THEN NULL ELSE c.cap END
     FROM (SELECT (SELECT v FROM fused_c_scope_cap(fused_f_rank(parent#>>'{scope,sensitivity}'),parent#>'{scope,compartments}',parent#>'{scope,projectIds}')) cap OFFSET 0) c) END
  WHEN (SELECT v FROM fused_c_scope_valid(b.bounds)) IS NOT TRUE THEN NULL ELSE b.bounds END
 FROM (SELECT CASE WHEN nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN NULL
   ELSE (SELECT v FROM fused_c_principal_query_bounds(w,nullif(current_setting('app.current_user_id',true),'')::uuid,NULL)) END bounds OFFSET 0) b
$f$;
CREATE FUNCTION fused_c_admits_point(bounds jsonb, source jsonb) RETURNS TABLE(v boolean) LANGUAGE sql IMMUTABLE AS $f$
 SELECT CASE WHEN (SELECT v FROM fused_c_scope_valid(bounds)) IS NOT TRUE OR x.rank IS NULL OR x.rank NOT BETWEEN 1 AND 3
   OR jsonb_typeof(source->'compartments') IS DISTINCT FROM 'array' OR jsonb_typeof(source->'projectIds') IS DISTINCT FROM 'array' THEN false
  WHEN cardinality(t.teams)=0 AND x.rank>(x.scope->>'tier')::int THEN false
  WHEN cardinality(t.teams)>0 AND x.scope->>'contextDepartment' IS NOT NULL AND NOT (x.scope->>'contextDepartment'=ANY(t.teams)) THEN false
  WHEN cardinality(t.teams)>0 AND EXISTS(SELECT 1 FROM unnest(t.teams) team WHERE x.rank>(CASE WHEN x.scope->'departments'='null' THEN (x.scope->>'tier')::int ELSE coalesce((x.scope#>>ARRAY['departments',team])::int,0) END)) THEN false
  ELSE coalesce(
   (SELECT coalesce(jsonb_agg(to_jsonb(substr(value#>>'{}',9))),'[]') FROM jsonb_array_elements(source->'compartments') WHERE value#>>'{}' LIKE 'project:%')<@(x.scope->'projectLabels')
   AND (x.scope->'otherLabels'='null' OR (SELECT coalesce(jsonb_agg(value),'[]') FROM jsonb_array_elements(source->'compartments')
    WHERE value#>>'{}' NOT LIKE 'team:%' AND value#>>'{}' NOT LIKE 'project:%')<@(x.scope->'otherLabels'))
   AND (x.scope->'projectIds'='null' OR source->'projectIds'<@(x.scope->'projectIds')),false) END
 FROM (SELECT (SELECT v FROM fused_c_normalize(bounds)) scope, fused_f_rank(source->>'sensitivity') rank OFFSET 0) x,
  (SELECT CASE WHEN jsonb_typeof(source->'compartments')='array' THEN (SELECT coalesce(array_agg(DISTINCT substr(value#>>'{}',6)),'{}') FROM jsonb_array_elements(source->'compartments') WHERE value#>>'{}' LIKE 'team:%') END teams OFFSET 0) t
$f$;
CREATE FUNCTION fused_l_domain(facts jsonb, w uuid, t text, i uuid, fields text[], memo jsonb, slots jsonb, completed jsonb[]) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET plan_cache_mode=force_generic_plan AS $f$
BEGIN
 RETURN (WITH fr AS MATERIALIZED (SELECT q.* FROM application_query_domains q WHERE q.workspace_id=w AND q.id=i AND q.origin='{"kind":"native","moduleKey":"native"}' AND q.type_key=t),
  frok AS MATERIALIZED (SELECT EXISTS(SELECT 1 FROM fr) AND (SELECT domain FROM fr)->>'kind' IS NOT DISTINCT FROM 'session_query_domain_v1'
   AND (SELECT domain FROM fr)-ARRAY['kind','sessionId','throughSequence','fields','bounds','visibility','parentFingerprint','candidates','points']='{}'
   AND (SELECT domain FROM fr)->'fields' IS NOT DISTINCT FROM to_jsonb(fields) ok),
  sid AS MATERIALIZED (SELECT ((SELECT domain FROM fr)->>'sessionId')::uuid id FROM frok WHERE frok.ok),
  pre AS MATERIALIZED (SELECT p.ok FROM sid, LATERAL fused_c_parent_precheck(w,sid.id) p),
  ls AS MATERIALIZED (SELECT s AS srow FROM sessions s WHERE s.workspace_id=w AND s.id=(SELECT id FROM sid) AND (SELECT ok FROM pre) FOR SHARE OF s),
  par AS MATERIALIZED (SELECT (SELECT qp.v FROM (SELECT (SELECT ok FROM pre) ok,(SELECT srow FROM ls) srow OFFSET 0) o, LATERAL fused_c_query_parent(facts,w,o.ok,o.srow) qp) parent),
  bnd AS MATERIALIZED (SELECT (SELECT b.v FROM par, LATERAL fused_c_session_query_bounds(w,par.parent) b) bounds),
  uni AS MATERIALIZED (SELECT (SELECT u.v FROM fr, bnd, LATERAL fused_c_union_contains(fr.domain->'bounds',jsonb_build_array(bnd.bounds),4096) u) contains),
  vis AS MATERIALIZED (SELECT jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE nullif(current_setting('app.current_user_id',true),'')::uuid END,
   'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb)) visibility),
  selected AS MATERIALIZED (SELECT m.id,m.sequence_num,completed[(slots->>('envelopes:'||jsonb_build_array(t,m.id,fields)::text))::integer] point
   FROM session_messages m WHERE m.workspace_id=w AND m.session_id=(SELECT id FROM sid) AND m.sequence_num<=((SELECT domain FROM fr)->>'throughSequence')::integer),
  admitted AS MATERIALIZED (SELECT q.* FROM selected q, fr WHERE q.point IS NOT NULL AND q.point<>'null'::jsonb
   AND (SELECT a.v FROM fused_c_admits_point(fr.domain->'bounds',q.point->'source') a) IS TRUE
   AND(q.point#>>'{source,userId}' IS NULL OR q.point#>>'{source,userId}' IS NOT DISTINCT FROM fr.domain#>>'{visibility,userId}')
   AND(q.point#>>'{source,assistantId}' IS NULL OR fr.domain#>'{visibility,assistants}'='null'::jsonb
    OR coalesce(fr.domain#>'{visibility,assistants}' ? (q.point#>>'{source,assistantId}'),false))),
  scanned AS MATERIALIZED (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',point#>'{state,recordVersion}') ORDER BY sequence_num,id),'[]') candidates,
   coalesce(jsonb_agg(jsonb_build_object('id',id,'version',point#>'{state,recordVersion}','fields',fields,'source',point->'source') ORDER BY sequence_num,id),'[]') points,
   coalesce(jsonb_agg(jsonb_build_object('id',id,'policy',point#>'{state,policyVersion}') ORDER BY sequence_num,id),'[]') policies,
   coalesce(jsonb_agg(point ORDER BY sequence_num,id),'[]') children FROM admitted)
  SELECT CASE WHEN (SELECT ok FROM frok) IS NOT TRUE THEN '{}'::jsonb
   WHEN (SELECT parent FROM par) IS NULL OR (SELECT parent FROM par)->'fingerprint' IS DISTINCT FROM (SELECT domain FROM fr)->'parentFingerprint' THEN '{}'::jsonb
   WHEN (SELECT bounds FROM bnd) IS NULL OR (SELECT contains FROM uni) IS DISTINCT FROM 'true' THEN '{}'::jsonb
   WHEN (SELECT domain FROM fr)#>>'{visibility,userId}' IS NOT NULL AND (SELECT domain FROM fr)#>>'{visibility,userId}' IS DISTINCT FROM (SELECT visibility FROM vis)->>'userId' THEN '{}'::jsonb
   WHEN (SELECT visibility FROM vis)->'assistants'<>'null'::jsonb AND ((SELECT domain FROM fr)#>'{visibility,assistants}'='null'::jsonb
     OR NOT coalesce((SELECT domain FROM fr)#>'{visibility,assistants}'<@((SELECT visibility FROM vis)->'assistants'),false))
    AND CASE WHEN jsonb_typeof((SELECT domain FROM fr)->'points') IS DISTINCT FROM 'array' THEN true
     ELSE EXISTS(SELECT 1 FROM jsonb_array_elements((SELECT domain FROM fr)->'points') point
      WHERE jsonb_typeof(point->'source') IS DISTINCT FROM 'object' OR point#>>'{source,assistantId}' IS NOT NULL
       AND NOT coalesce((SELECT visibility FROM vis)->'assistants' ? (point#>>'{source,assistantId}'),false)) END THEN '{}'::jsonb
   WHEN (SELECT candidates FROM scanned) IS DISTINCT FROM (SELECT domain FROM fr)->'candidates' OR (SELECT points FROM scanned) IS DISTINCT FROM (SELECT domain FROM fr)->'points' THEN '{}'::jsonb
   ELSE jsonb_build_object('value',jsonb_build_object('values','{}'::jsonb,'source',(SELECT parent FROM par)->'scope','recordVersion','1',
    'sourceKind','application_query_domain','sourceId',i,'sourceVersion',(SELECT identity FROM fr),'ownerId',NULL,
    'fieldIdentity',fused_f_digest(jsonb_build_object('kind','session_query_domain_v1','identity',(SELECT identity FROM fr),'fields',fields)),
    'policyVersion',fused_f_digest(jsonb_build_object('kind','session_query_domain_v1','identity',(SELECT identity FROM fr),'policies',(SELECT policies FROM scanned))),
    'references','[]'::jsonb,'queryPoints',(SELECT domain FROM fr)->'points'),'children',(SELECT children FROM scanned)) END);
END $f$;
CREATE FUNCTION fused_l_point(facts jsonb, w uuid, t text, i uuid, fields text[], memo jsonb, slots jsonb, completed jsonb[]) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET plan_cache_mode=force_generic_plan AS $f$
BEGIN
 IF t IS DISTINCT FROM 'session_message' THEN RETURN fused_c_decline('point type',NULL::jsonb); END IF;
 IF clock_timestamp()>=(memo->>'validUntil')::timestamptz THEN RETURN fused_c_decline('deadline',NULL::jsonb); END IF;
 RETURN (WITH k AS MATERIALIZED (SELECT CASE t WHEN 'session_message' THEN ARRAY['id','role','content','sequenceNum','createdAt','senderUserId','senderAssistantId','channelMessageId','attachments']
   WHEN 'session_message_annotation' THEN ARRAY['id','sequenceNum','topicLabel','topicConfidence','replyToText'] END keys),
  m AS MATERIALIZED (SELECT id,workspace_id,session_id,scope_version,sequence_num FROM session_messages WHERE workspace_id=w AND id=i),
  pre AS MATERIALIZED (SELECT p.ok FROM m, LATERAL fused_c_parent_precheck(w,m.session_id) p),
  ls AS MATERIALIZED (SELECT s AS srow FROM sessions s WHERE s.workspace_id=w AND s.id=(SELECT session_id FROM m) AND (SELECT ok FROM pre) FOR SHARE OF s),
  par AS MATERIALIZED (SELECT (SELECT qp.v FROM (SELECT (SELECT ok FROM pre) ok,(SELECT srow FROM ls) srow OFFSET 0) o, LATERAL fused_c_query_parent(facts,w,o.ok,o.srow) qp) parent),
  src AS MATERIALIZED (SELECT completed[(slots->>('current:session_message:'||i||':'||m.scope_version))::integer] source FROM m),
  hs AS MATERIALIZED (SELECT
   count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history')) history_shape
   FROM session_messages message JOIN sessions session ON session.id=message.session_id AND session.workspace_id=message.workspace_id
   JOIN scope_derivations d ON d.workspace_id=message.workspace_id AND d.resource_kind='session_message'
    AND d.resource_id=message.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM message.user_id
    AND d.assistant_id IS NOT DISTINCT FROM message.assistant_id AND d.sensitivity=message.sensitivity
    AND d.compartments=message.compartments AND d.project_ids=message.project_ids
   JOIN scope_derivation_sources link ON link.workspace_id=d.workspace_id AND link.derivation_id=d.id
   CROSS JOIN LATERAL (
    SELECT link.source_kind,link.source_id,link.source_version WHERE link.source_kind<>'session_context_revision'
    UNION ALL
    SELECT edge.source_kind,edge.source_id,edge.source_version FROM native_turn_frames frame
     JOIN scope_derivations declaration ON declaration.workspace_id=frame.workspace_id
      AND declaration.resource_kind='session_context_revision' AND declaration.resource_id=frame.id AND declaration.resource_version='1'
     JOIN scope_derivation_sources edge ON edge.workspace_id=declaration.workspace_id AND edge.derivation_id=declaration.id
     WHERE link.source_kind='session_context_revision' AND link.source_version='1' AND frame.workspace_id=w
      AND frame.id=link.source_id AND frame.session_id=message.session_id AND frame.format=2
      AND (SELECT count(*) FROM scope_derivation_sources original WHERE original.workspace_id=w AND original.derivation_id=d.id)=1
      AND native_turn_frame_pair(w,frame.id) IS TRUE
   ) s
   WHERE message.workspace_id=w AND message.id=i AND message.scope_version=1 AND message.scope_held IS FALSE),
  hcond AS MATERIALIZED (SELECT nullif(current_setting('app.current_user_id',true),'')::uuid IS NOT NULL
   AND EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=w AND member.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
   AND nullif(current_setting('app.application_id',true),'') IS NULL
   AND nullif(current_setting('app.public_share_root',true),'') IS NULL
   AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) ok),
  val AS MATERIALIZED (SELECT jsonb_build_object('id',x.id,'role',x.role,'content',x.content,'sequenceNum',x.sequence_num,'createdAt',x.created_at,
   'senderUserId',x.sender_user_id,'senderAssistantId',x.sender_assistant_id,'channelMessageId',x.channel_message_id,'attachments',x.attachments) values_json
   FROM session_messages x WHERE x.workspace_id=w AND x.id=i AND x.scope_version=(SELECT scope_version FROM m))
  SELECT CASE WHEN (memo->'privacyDenied') ? ('session_message:'||i) THEN '{}'::jsonb
   WHEN k.keys IS NULL OR fields IS NULL OR cardinality(fields)>cardinality(k.keys) OR NOT fields<@k.keys
    OR array_position(fields,NULL) IS NOT NULL OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
    OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN NULL
   WHEN NOT EXISTS(SELECT 1 FROM m) THEN NULL
   WHEN (SELECT parent FROM par) IS NULL THEN NULL
   WHEN (SELECT source FROM src) IS NULL OR (SELECT source FROM src)->>'held' IS DISTINCT FROM 'false'
    OR (SELECT source FROM src)->>'version' IS DISTINCT FROM (SELECT scope_version FROM m)::text THEN NULL
   WHEN (SELECT ok FROM hcond) AND (SELECT history_shape FROM hs) IS TRUE THEN fused_c_decline('history shape',NULL::jsonb)
   WHEN coalesce(completed[(slots->>('native:session_message:'||i||':'||(SELECT scope_version FROM m)::text))::integer]->>'value'='true',false) IS NOT TRUE THEN '{}'::jsonb
   WHEN (SELECT values_json FROM val) IS NULL THEN NULL
   ELSE jsonb_build_object('value',jsonb_build_object(
    'values',(SELECT coalesce(jsonb_object_agg(key,value),'{}') FROM jsonb_each((SELECT values_json FROM val)) WHERE key=ANY(fields)),
    'source',(SELECT source FROM src),'recordVersion',(SELECT scope_version FROM m)::text||':'||fused_f_digest((SELECT values_json FROM val)),
    'sourceKind','session_message','sourceId',i,'sourceVersion',(SELECT source FROM src)->>'version','ownerId',NULL,
    'fieldIdentity',fused_f_digest(jsonb_build_object('kind','session_field_v1','type',t,'fields',fields)),
    'policyVersion',fused_f_digest(jsonb_build_object('kind','session_field_v1','parent',(SELECT parent FROM par)->'fingerprint','fields',fields)),
    'references','[]'::jsonb)) END
  FROM k);
END $f$;
CREATE FUNCTION fused_l_envelope_session(facts jsonb, w uuid, t text, i uuid, selection text, fields text[], memo jsonb, slots jsonb, completed jsonb[], obs_scope jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET plan_cache_mode=force_generic_plan AS $f$
BEGIN
 IF t NOT IN('session_message','session_message_annotation') OR selection NOT IN('read','query','identity','query_domain') THEN RETURN fused_c_decline('envelope type',NULL::jsonb); END IF;
 RETURN (WITH k AS MATERIALIZED (SELECT ARRAY(SELECT DISTINCT key FROM unnest(fields) key ORDER BY key) keys),
  r AS MATERIALIZED (SELECT CASE WHEN selection='query_domain' THEN completed[(slots->>('domains:'||i))::integer]
    ELSE jsonb_build_object('value',completed[(slots->>('points:'||jsonb_build_array(t,i,k.keys)::text))::integer]) END result FROM k),
  st AS MATERIALIZED (SELECT r.result->'value' state, CASE WHEN selection='query_domain' THEN coalesce(r.result->'children','[]'::jsonb) ELSE '[]'::jsonb END children,
   coalesce(r.result->'memo',memo) memo2 FROM r),
  sc AS MATERIALIZED (SELECT jsonb_build_object('workspaceId',w,'userId',st.state#>'{source,userId}','assistantId',st.state#>'{source,assistantId}',
   'sensitivity',st.state#>'{source,sensitivity}','compartments',st.state#>'{source,compartments}','projectIds',st.state#>'{source,projectIds}') scope FROM st),
  idn AS MATERIALIZED (SELECT fused_f_digest(jsonb_build_object('workspaceId',w,'origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey',t,'id',i,
   'selection',selection,'selectedVersion',NULL,'fields',k.keys,'fieldIdentity',st.state->'fieldIdentity')) identity FROM st,k),
  srcs AS MATERIALIZED (SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') sources FROM (SELECT DISTINCT value FROM (
    SELECT coalesce(c.value->'source','null'::jsonb) value FROM st, jsonb_array_elements(st.children) c
    UNION ALL SELECT e.value FROM st, jsonb_array_elements(st.children) c, jsonb_array_elements(coalesce(c.value->'sources','[]')) e) all_sources) unique_sources)
  SELECT CASE WHEN fields IS NULL OR cardinality(k.keys)<>cardinality(fields) THEN '{}'::jsonb
   WHEN st.state IS NULL OR st.state='null'::jsonb THEN '{}'::jsonb
   WHEN (SELECT v FROM fused_c_envelope_valid(sc.scope)) IS NOT TRUE THEN '{}'::jsonb
   WHEN coalesce(st.memo2->>'hasExternal','true')='true' THEN fused_c_decline('external sources',NULL::jsonb)
   WHEN jsonb_array_length(srcs.sources)>4096 OR jsonb_array_length(st.children)>4096 THEN '{}'::jsonb
   ELSE jsonb_build_object('value',jsonb_build_object('resourceId',fused_f_uuid(idn.identity),'identity',idn.identity,'origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey',t,'id',i,
    'selection',selection,'selectedVersion',NULL,'fields',k.keys,'fieldIdentity',st.state->'fieldIdentity','state',st.state,'children',st.children,'sources',srcs.sources,
    'source',sc.scope||jsonb_build_object('resourceKind','application_field','resourceId',fused_f_uuid(idn.identity),'version',fused_f_digest(jsonb_build_object('resourceId',fused_f_uuid(idn.identity),
     'recordVersion',st.state->'recordVersion','sourceVersion',st.state->'sourceVersion','policyVersion',st.state->'policyVersion','scope',sc.scope,'sources',srcs.sources)))))
    ||CASE WHEN obs_scope IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('fa_vis',jsonb_build_array((SELECT v1.v FROM fused_c_visible(facts,w,obs_scope) v1),
     (SELECT v2.v FROM fused_c_visible(facts,w,sc.scope||jsonb_build_object('resourceKind','application_field','resourceId',fused_f_uuid(idn.identity),'version',fused_f_digest(jsonb_build_object('resourceId',fused_f_uuid(idn.identity),
     'recordVersion',st.state->'recordVersion','sourceVersion',st.state->'sourceVersion','policyVersion',st.state->'policyVersion','scope',sc.scope,'sources',srcs.sources)))) v2))) END END
  FROM k,st,sc,idn,srcs);
END $f$;
