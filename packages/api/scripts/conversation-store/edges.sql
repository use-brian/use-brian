-- [COMP:api/native-turn-frame] Native adjacency, with explicit foreign-family delegation.
CREATE FUNCTION conversation_source_edges(w uuid,k text,i uuid,v text)
RETURNS TABLE(kind text,id uuid,version text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $body$
BEGIN
 IF k='application_field' AND NOT EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=i
  AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
  RETURN QUERY SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
   JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id WHERE d.workspace_id=w AND d.resource_kind=k AND d.resource_id=i
  UNION SELECT o.source_kind,o.source_id,o.source_version FROM application_field_observations o WHERE o.workspace_id=w AND o.resource_id=i AND o.version=v
  UNION SELECT o.source_kind,o.source_id,o.source_version FROM application_field_observation_sources o WHERE o.workspace_id=w AND o.resource_id=i AND o.version=v;
 ELSIF k IN('session_message','session_context_revision','application_query_domain','private_transcript') THEN
  -- These identities have no successor walk. Observation versions remain exact.
  RETURN QUERY SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
   JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id WHERE d.workspace_id=w AND d.resource_kind=k AND d.resource_id=i;
 ELSE
  -- Memory history qualification, file successors and foreign source families
  -- retain their owned semantics; they never grant native conversation admission.
  RETURN QUERY SELECT e.kind,e.id,e.version FROM application_scope_source_edges(w,k,i,v) e;
 END IF;
END $body$;
REVOKE ALL ON FUNCTION conversation_source_edges(uuid,text,uuid,text) FROM PUBLIC,app_user;
