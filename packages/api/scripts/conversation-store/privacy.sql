-- [COMP:api/native-turn-frame] Complete all-version recording ancestry before payload.
-- This operation-local result is never durable permission or reusable admission.
CREATE FUNCTION conversation_capture_privacy(w uuid,nodes jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE result jsonb;node_count integer;session_ids jsonb;archive_denied jsonb;archive_count integer;
BEGIN
 WITH RECURSIVE points AS MATERIALIZED(
  SELECT n->>'kind' kind,(n->>'id')::uuid id,application_field_resource_uuid(application_field_digest(jsonb_build_object(
   'workspaceId',w,'origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey',n->>'kind','id',n->>'id',
   'selection','query','selectedVersion',NULL,'fields',n->'fields','fieldIdentity',application_field_digest(jsonb_build_object(
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
  SELECT session_id,session_recording_read_allowed(session_id) allowed FROM(SELECT DISTINCT session_id FROM parents WHERE session_id IS NOT NULL) p
 ), denied(kind,id) AS(
  SELECT p.kind,p.id FROM parents p JOIN checked c USING(session_id) WHERE NOT c.allowed
  UNION SELECT e.parent_kind,e.parent_id FROM denied d JOIN edges e ON e.child_kind=d.kind AND e.child_id=d.id
   JOIN reached r ON r.kind=e.parent_kind AND r.id=e.parent_id
 ) SELECT (SELECT count(*) FROM reached),coalesce(jsonb_object_agg(kind||':'||id,true),'{}'),(SELECT coalesce(jsonb_agg(session_id),'[]') FROM checked) INTO node_count,result,session_ids FROM denied;
 IF node_count>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 -- Archive ancestry is causal, unlike recording privacy's all-version closure.
 -- Seed annotation parents too: a direct revision read must check its message.
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
 ) SELECT (SELECT count(*) FROM reached),coalesce(jsonb_object_agg(kind||':'||id,true),'{}') INTO archive_count,archive_denied FROM denied;
 IF archive_count>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('denied',result,'archiveDenied',archive_denied,'recordingEligible',conversation_recording_scope(w,session_ids));
END $body$;
REVOKE ALL ON FUNCTION conversation_capture_privacy(uuid,jsonb) FROM PUBLIC,app_user;
