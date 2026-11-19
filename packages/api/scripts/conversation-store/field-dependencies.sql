-- [COMP:api/native-turn-frame] Remove native reader probing; preserve history-purpose qualification.
CREATE OR REPLACE FUNCTION public.read_native_session_field_dependencies(w uuid, kinds text[], ids uuid[], versions text[])
 RETURNS TABLE(node_version text, source jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE dependency record;item jsonb;rows_json jsonb:='[]';memo jsonb:='{}';result jsonb;admitted jsonb;native_only boolean:=true;belongs boolean;position integer;
 resource application_field_resources;observation application_field_observations;proof jsonb;history_snapshot jsonb;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;child_kinds text[];child_ids uuid[];child_versions text[];
 eligible boolean;eligible_roots jsonb:='{}';root_shape jsonb;
 wrapper_position integer;current_envelope jsonb;child jsonb;wrapper_rows jsonb;wrapper_row jsonb;frozen application_query_domains;
 direct_kinds text[];direct_ids uuid[];direct_versions text[];direct_position integer;history_shape boolean;
 observed_sources jsonb;expected_sources jsonb;delegated jsonb;wrapper_source jsonb;
BEGIN
 -- Native titles and canonical turn frames delegate their complete stored field roots.
 -- Only a verified frame may carry the original Memory history purpose.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 1 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND (actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE')))) THEN
  FOR position IN 1..cardinality(ids) LOOP
   IF kinds[position]<>'session_context_revision' THEN CONTINUE;END IF;

 SELECT array_agg(s.source_kind ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_id ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_version ORDER BY s.source_kind,s.source_id,s.source_version),
  count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(s.source_kind='application_field' AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
 INTO child_kinds,child_ids,child_versions,eligible
 FROM session_context_scope_revisions r JOIN scope_derivations d ON d.workspace_id=r.workspace_id AND d.resource_kind='session_context_revision'
  AND d.resource_id=r.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM r.user_id AND d.assistant_id IS NOT DISTINCT FROM r.assistant_id
  AND d.sensitivity=r.sensitivity AND d.compartments=r.compartments AND d.project_ids=r.project_ids
 JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
 WHERE r.workspace_id=w AND r.id=ids[position] AND r.scope_version=1
  AND (r.parent_kind='session_title' AND r.parent_id=r.session_id
   OR r.parent_kind='turn_frame' AND r.parent_id=r.id AND EXISTS(SELECT 1 FROM native_turn_frames frame
    WHERE frame.workspace_id=w AND frame.id=r.id AND frame.session_id=r.session_id AND frame.format=2));
 IF eligible IS TRUE AND EXISTS(SELECT 1 FROM application_scope_lineage(w,child_kinds,child_ids,child_versions) n WHERE n.kind='session_context_revision') THEN eligible:=false;END IF;

   IF eligible IS TRUE THEN
    eligible_roots:=eligible_roots||jsonb_build_object(position::text,jsonb_build_object('kinds',child_kinds,'ids',child_ids,'versions',child_versions));
   END IF;
  END LOOP;
  IF eligible_roots<>'{}'::jsonb THEN
   FOR position IN 1..cardinality(ids) LOOP
    root_shape:=eligible_roots->position::text;
    IF root_shape IS NULL THEN
     RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,ARRAY[kinds[position]],ARRAY[ids[position]],ARRAY[versions[position]]);
    ELSE
     IF versions[position] IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
     IF EXISTS(SELECT 1 FROM native_turn_frames frame WHERE frame.workspace_id=w AND frame.id=ids[position] AND frame.format=2) THEN
      IF native_turn_helpers_current() IS NOT TRUE OR native_turn_frame_pair(w,ids[position]) IS NOT TRUE THEN
       RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
      memo:=conversation_dag(w,jsonb_build_array(jsonb_build_object('kind','session_context_revision','id',ids[position],'version','1')),'[]');
      IF memo#>>ARRAY['native:session_context_revision:'||ids[position]||':1','value'] IS DISTINCT FROM 'true' THEN
       RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
     ELSIF session_context_revision_allowed(w,ids[position]) IS NOT TRUE THEN
      RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
     SELECT array_agg(value) INTO child_kinds FROM jsonb_array_elements_text(root_shape->'kinds');
     SELECT array_agg(value::uuid) INTO child_ids FROM jsonb_array_elements_text(root_shape->'ids');
     SELECT array_agg(value) INTO child_versions FROM jsonb_array_elements_text(root_shape->'versions');
     RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,child_kinds,child_ids,child_versions);
    END IF;
   END LOOP;
   RETURN;
  END IF;
 END IF;

 -- Each original root keeps its own purpose before union/deduplication.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 1 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND EXISTS(SELECT 1 FROM unnest(kinds,ids) r(kind,id) JOIN application_field_resources f ON f.workspace_id=w AND f.id=r.id
    WHERE r.kind='application_field' AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
  FOR position IN 1..cardinality(ids) LOOP
   SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND id=ids[position]
    AND kinds[position]='application_field' AND origin='{"kind":"native","moduleKey":"native"}' AND type_key='memory' AND selection='history';
   IF NOT FOUND THEN
    RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,ARRAY[kinds[position]],ARRAY[ids[position]],ARRAY[versions[position]]);
    CONTINUE;
   END IF;
   admitted:=read_admitted_application_field_snapshot(w,ids[position],versions[position]);
   IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM versions[position] THEN
    RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   history_snapshot:=admitted;
   proof:=application_memory_history_status(w,resource.resource_id,resource.selected_version);
   IF proof IS NULL THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   FOR dependency IN SELECT * FROM read_application_field_dependencies(w,ARRAY[kinds[position]],ARRAY[ids[position]],ARRAY[versions[position]]) LOOP
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'ownFields') f
      WHERE f->>'id'=dependency.source->>'resourceId' AND f->>'version'=dependency.node_version)
     AND NOT EXISTS(SELECT 1 FROM unnest(kinds,ids,versions) r(kind,id,version) WHERE r.kind='application_field'
      AND r.id=(dependency.source->>'resourceId')::uuid AND r.version=dependency.node_version) THEN CONTINUE;END IF;
    IF dependency.source->>'resourceKind'='application_field' AND dependency.source->>'resourceId'=ids[position]::text
     AND dependency.node_version=versions[position] THEN
     -- This exact root was canonically admitted after the caller's metadata discovery.
     IF dependency.source IS DISTINCT FROM (history_snapshot-ARRAY['held','validTo','retractedAt'])
      OR scope_review_state_held('application_field',ids[position]) IS TRUE THEN
      RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    ELSE
     result:=application_session_eval_field(w,(dependency.source->>'resourceId')::uuid,dependency.node_version,memo);
     memo:=coalesce(result->'memo',memo);admitted:=result->'value';
     IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    END IF;
    node_version:=dependency.node_version;source:=dependency.source;RETURN NEXT;
   END LOOP;
  END LOOP;
  RETURN;
 END IF;
 -- Typed native session wrappers preserve their own immutable binding and all original roots.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 1 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=w AND member.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN
  wrapper_rows:='{}';
  FOR wrapper_position IN 1..cardinality(ids) LOOP
   SELECT * INTO resource FROM application_field_resources f WHERE f.workspace_id=w AND f.id=ids[wrapper_position]
    AND kinds[wrapper_position]='application_field' AND f.origin='{"kind":"native","moduleKey":"native"}'
    AND f.type_key='session_message' AND f.selected_version IS NULL AND f.selection IN('read','query','identity','query_domain');
   IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY[kinds[wrapper_position]],ARRAY[ids[wrapper_position]],ARRAY[versions[wrapper_position]]) n
    JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
     AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN CONTINUE;END IF;
   history_shape:=false;
   IF resource.selection<>'query_domain' THEN

 SELECT array_agg(s.source_kind ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_id ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_version ORDER BY s.source_kind,s.source_id,s.source_version),
  count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
 INTO direct_kinds,direct_ids,direct_versions,history_shape
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
 WHERE message.workspace_id=w AND message.id=resource.resource_id AND message.scope_version=1 AND message.scope_held IS FALSE;
 IF history_shape IS TRUE THEN
  IF EXISTS(SELECT 1 FROM application_scope_lineage(w,direct_kinds,direct_ids,direct_versions) n
   WHERE n.kind='session_context_revision' OR n.kind='session_message' AND n.id=resource.resource_id) THEN history_shape:=false;END IF;
  FOR direct_position IN 1..cardinality(direct_ids) LOOP
   IF NOT EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=direct_ids[direct_position]
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history')
    AND EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY[direct_kinds[direct_position]],ARRAY[direct_ids[direct_position]],ARRAY[direct_versions[direct_position]]) n
     JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN history_shape:=false;END IF;
  END LOOP;
 END IF;

    IF history_shape IS NOT TRUE THEN CONTINUE;END IF;
   END IF;
   SELECT * INTO observation FROM application_field_observations o WHERE o.workspace_id=w AND o.resource_id=resource.id AND o.version=versions[wrapper_position];
   IF NOT FOUND THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   -- The wrapper was captured by the canonical graph. Rebuilding it through
   -- the legacy session reader changes query membership for framed history.
   IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   memo:=conversation_dag(w,jsonb_build_array(jsonb_build_object('kind','application_field','id',resource.id,'version',versions[wrapper_position])),'[]');
   current_envelope:=memo#>ARRAY['field:'||resource.id||':'||versions[wrapper_position],'envelope'];
   IF current_envelope IS NULL OR current_envelope->>'resourceId' IS DISTINCT FROM resource.id::text
    OR current_envelope->>'identity' IS DISTINCT FROM resource.identity
    OR current_envelope#>>'{source,version}' IS DISTINCT FROM versions[wrapper_position]
    OR current_envelope#>>'{state,recordVersion}' IS DISTINCT FROM observation.record_version
    OR current_envelope#>>'{state,policyVersion}' IS DISTINCT FROM observation.policy_version
    OR current_envelope#>>'{state,sourceKind}' IS DISTINCT FROM observation.source_kind
    OR current_envelope#>>'{state,sourceId}' IS DISTINCT FROM observation.source_id::text
    OR current_envelope#>>'{state,sourceVersion}' IS DISTINCT FROM observation.source_version
    OR ((current_envelope->'source')-ARRAY['resourceKind','resourceId','version']) IS DISTINCT FROM observation.source_scope
    THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   SELECT coalesce(jsonb_agg(jsonb_build_array(s.source_kind,s.source_id::text,s.source_version) ORDER BY s.source_kind,s.source_id::text,s.source_version),'[]') INTO observed_sources
    FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=resource.id AND s.version=versions[wrapper_position];
   SELECT coalesce(jsonb_agg(jsonb_build_array(s->>'resourceKind',s->>'resourceId',s->>'version') ORDER BY s->>'resourceKind',s->>'resourceId',s->>'version'),'[]') INTO expected_sources
    FROM jsonb_array_elements(current_envelope->'sources') s;
   IF observed_sources IS DISTINCT FROM expected_sources THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   admitted:=memo#>ARRAY['field:'||resource.id||':'||versions[wrapper_position],'value'];
   IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM versions[wrapper_position]
    OR (admitted-ARRAY['held','validTo','retractedAt']) IS DISTINCT FROM current_envelope->'source' THEN
    RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   wrapper_source:=current_envelope->'source';delegated:='[]';
   IF resource.selection='query_domain' THEN
    SELECT * INTO frozen FROM application_query_domains q WHERE q.workspace_id=w AND q.id=resource.resource_id
     AND q.origin=resource.origin AND q.type_key=resource.type_key AND q.schema_version='1';
    IF NOT FOUND OR frozen.identity IS DISTINCT FROM observation.source_version OR observation.source_kind<>'application_query_domain'
     OR observation.source_id IS DISTINCT FROM frozen.id OR jsonb_array_length(current_envelope->'children')>4096 THEN
     RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    FOR child IN SELECT value FROM jsonb_array_elements(current_envelope->'children') LOOP
     IF child->'origin' IS DISTINCT FROM resource.origin OR child->>'typeKey'<>'session_message'
      OR child->>'selection'<>'query' OR child->>'selectedVersion' IS NOT NULL
      OR child#>>'{state,sourceKind}'<>'session_message'
      OR NOT EXISTS(SELECT 1 FROM session_messages message WHERE message.workspace_id=w AND message.id=(child->>'id')::uuid
       AND message.id=(child#>>'{state,sourceId}')::uuid AND message.session_id=(frozen.domain->>'sessionId')::uuid
       AND message.sequence_num<=(frozen.domain->>'throughSequence')::integer)
      OR NOT EXISTS(SELECT 1 FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=resource.id AND s.version=versions[wrapper_position]
       AND s.source_kind='application_field' AND s.source_id=(child->>'resourceId')::uuid AND s.source_version=child#>>'{source,version}') THEN
      RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
     FOR dependency IN SELECT * FROM read_native_session_field_dependencies(w,ARRAY['application_field'],ARRAY[(child->>'resourceId')::uuid],ARRAY[child#>>'{source,version}']) LOOP
      delegated:=delegated||jsonb_build_array(jsonb_build_object('version',dependency.node_version,'source',dependency.source));
      IF jsonb_array_length(delegated)>4096 THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
     END LOOP;
    END LOOP;
   ELSE
    IF observation.source_kind<>'session_message' OR observation.source_id IS DISTINCT FROM resource.resource_id
     OR observation.source_version<>'1' OR observation.record_version NOT LIKE '1:%' THEN
     RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    FOR dependency IN SELECT * FROM read_native_session_field_dependencies(w,direct_kinds,direct_ids,direct_versions) LOOP
     delegated:=delegated||jsonb_build_array(jsonb_build_object('version',dependency.node_version,'source',dependency.source));
     IF jsonb_array_length(delegated)>4096 THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    END LOOP;
    FOR direct_position IN 1..cardinality(direct_ids) LOOP
     IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(delegated) s WHERE s#>>'{source,resourceKind}'='application_field'
      AND s#>>'{source,resourceId}'=direct_ids[direct_position]::text AND s->>'version'=direct_versions[direct_position]) THEN
      RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    END LOOP;
   END IF;
   wrapper_rows:=wrapper_rows||jsonb_build_object(wrapper_position::text,jsonb_build_array(jsonb_build_object('version',versions[wrapper_position],'source',wrapper_source))||delegated);
  END LOOP;
  IF wrapper_rows<>'{}'::jsonb THEN
   FOR wrapper_position IN 1..cardinality(ids) LOOP
    IF wrapper_rows ? wrapper_position::text THEN
     RETURN QUERY SELECT value->>'version',value->'source' FROM jsonb_array_elements(wrapper_rows->wrapper_position::text);
    ELSE
     RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,ARRAY[kinds[wrapper_position]],ARRAY[ids[wrapper_position]],ARRAY[versions[wrapper_position]]);
    END IF;
   END LOOP;
   RETURN;
  END IF;
 END IF;
 FOR dependency IN SELECT * FROM read_application_field_dependencies(w,kinds,ids,versions) LOOP
  SELECT origin='{"kind":"native","moduleKey":"native"}'::jsonb AND type_key IN('session_message','session_message_annotation') INTO belongs
   FROM application_field_resources WHERE workspace_id=w AND id=(dependency.source->>'resourceId')::uuid;
  IF belongs IS DISTINCT FROM true THEN native_only:=false;END IF;
  rows_json:=rows_json||jsonb_build_array(jsonb_build_object('version',dependency.node_version,'source',dependency.source));
 END LOOP;
 IF NOT native_only THEN RETURN QUERY SELECT * FROM read_admitted_application_field_dependencies(w,kinds,ids,versions);RETURN;END IF;
 IF (SELECT encode(sha256(convert_to(to_jsonb(guard_proc)::text,'UTF8')),'hex') FROM pg_proc guard_proc WHERE guard_proc.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 memo:=conversation_dag(w,coalesce((SELECT jsonb_agg(jsonb_build_object('kind','application_field','id',entry.node#>>'{source,resourceId}','version',entry.node->>'version')) FROM jsonb_array_elements(rows_json) entry(node)),'[]'::jsonb),'[]');
 FOR item IN SELECT value FROM jsonb_array_elements(rows_json) LOOP
  admitted:=memo#>ARRAY['field:'||(item#>>'{source,resourceId}')||':'||(item->>'version'),'value'];
  IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 END LOOP;
 RETURN QUERY SELECT value->>'version',value->'source' FROM jsonb_array_elements(rows_json);
END $function$;
