BEGIN;
-- [COMP:api/application-persistence] Metadata equivalence only; current admission is unchanged.
DO $$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)'::regprocedure)
  IS DISTINCT FROM '497af5b78abd438a9332b52ba0e1eb6115997adfc447f239727d5948d626463a'
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_scope_source_edges(uuid,text,uuid,text)'::regprocedure)
  IS DISTINCT FROM '20d8c359a6b77c9c96aed3be9e31719e60868fb55e34aaedc2714494e6a8e974' THEN
  RAISE EXCEPTION 'Canonical native metadata prerequisite changed';END IF;
 IF scope_source_table('memory') IS DISTINCT FROM 'memories' OR scope_source_table('session_message') IS DISTINCT FROM 'session_messages'
  OR scope_source_table('session_context_revision') IS DISTINCT FROM 'session_context_scope_revisions'
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid IN('public.session_messages'::regclass,'public.session_context_scope_revisions'::regclass) AND attname='superseded_by' AND NOT attisdropped) THEN
  RAISE EXCEPTION 'Canonical native supersession columns changed';END IF;
END $$;
CREATE OR REPLACE FUNCTION scope_source_ancestors_before_browser_profile(p_workspace uuid,p_kind text,p_id uuid)
RETURNS TABLE(resource_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tab text; versioned boolean;
BEGIN
  -- These are the same workspace-scoped column walks, with static plans.
  IF p_kind='memory' THEN
    RETURN QUERY WITH RECURSIVE ancestry(id) AS (
      SELECT id FROM memories WHERE workspace_id=p_workspace AND id=p_id
      UNION SELECT r.id FROM memories r JOIN ancestry a ON r.superseded_by=a.id WHERE r.workspace_id=p_workspace
    ) SELECT id FROM ancestry;
    RETURN;
  ELSIF p_kind='session_message' THEN
    RETURN QUERY SELECT id FROM session_messages WHERE workspace_id=p_workspace AND id=p_id;
    RETURN;
  ELSIF p_kind='session_context_revision' THEN
    RETURN QUERY SELECT id FROM session_context_scope_revisions WHERE workspace_id=p_workspace AND id=p_id;
    RETURN;
  END IF;
  IF p_kind IN('crm_event','memory_verification','brain_verification','correction_audit') THEN RETURN QUERY SELECT p_id; RETURN; END IF;
  tab=scope_source_table(p_kind);
  IF tab IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  SELECT EXISTS(
    SELECT 1 FROM pg_attribute
     WHERE attrelid=format('%I',tab)::regclass AND attname='superseded_by' AND NOT attisdropped
  ) INTO versioned;
  IF NOT versioned THEN
    RETURN QUERY EXECUTE format('SELECT id FROM %I WHERE workspace_id=$2 AND id=$1',tab) USING p_id,p_workspace;
    RETURN;
  END IF;
  RETURN QUERY EXECUTE format('WITH RECURSIVE ancestry(id) AS (
    SELECT id FROM %I WHERE workspace_id=$2 AND id=$1
    UNION SELECT r.id FROM %I r JOIN ancestry a ON r.superseded_by=a.id WHERE r.workspace_id=$2)
    SELECT id FROM ancestry',tab,tab) USING p_id,p_workspace;
END;
$$;
REVOKE ALL ON FUNCTION scope_source_ancestors_before_browser_profile(uuid,text,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION application_scope_source_edges(w uuid,k text,i uuid,v text)
RETURNS TABLE(kind text,id uuid,version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF k IN('memory','session_message','session_context_revision') THEN
  RETURN QUERY
 SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
  JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
  WHERE d.workspace_id=w AND d.resource_kind=k AND d.resource_id=i
 UNION
 SELECT k,prior_id,v FROM scope_source_ancestors(w,k,i) prior(prior_id) WHERE prior_id<>i;
 ELSIF k='application_field' THEN
  RETURN QUERY
 SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
  JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
  WHERE d.workspace_id=w AND d.resource_kind=k AND d.resource_id=i
 UNION
 SELECT o.source_kind,o.source_id,o.source_version FROM application_field_observations o
  WHERE k='application_field' AND o.workspace_id=w AND o.resource_id=i AND o.version=v
 UNION
 SELECT s.source_kind,s.source_id,s.source_version FROM application_field_observation_sources s
  WHERE k='application_field' AND s.workspace_id=w AND s.resource_id=i AND s.version=v;
 ELSE
  RETURN QUERY
 SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
  JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
  WHERE d.workspace_id=w AND d.resource_kind=k AND d.resource_id=i
 UNION
 SELECT k,prior_id,v FROM unnest(CASE WHEN scope_source_table(k) IS NOT NULL
  THEN ARRAY(SELECT resource_id FROM scope_source_ancestors(w,k,i)) ELSE '{}'::uuid[] END) prior_id WHERE prior_id<>i
 UNION
 SELECT o.source_kind,o.source_id,o.source_version FROM application_field_observations o
  WHERE k='application_field' AND o.workspace_id=w AND o.resource_id=i AND o.version=v
 UNION
 SELECT s.source_kind,s.source_id,s.source_version FROM application_field_observation_sources s
  WHERE k='application_field' AND s.workspace_id=w AND s.resource_id=i AND s.version=v
 UNION
 SELECT 'workspace_file',wf.id,wf.scope_version::text FROM file_segments fs
  JOIN workspace_files wf ON wf.id=fs.file_id AND wf.workspace_id=fs.workspace_id
  WHERE k='file_segment' AND fs.workspace_id=w AND fs.id=i
 UNION
 SELECT observed.value->>'resourceKind',(observed.value->>'resourceId')::uuid,observed.value->>'version'
  FROM jsonb_array_elements(CASE WHEN k='workflow_run' THEN read_workflow_derivation_inputs(w,i) ELSE '[]'::jsonb END) input
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(input#>'{evidence,sources}','[]'::jsonb)
   ||CASE WHEN jsonb_typeof(input->'blueprintSource')='object' THEN jsonb_build_array(input->'blueprintSource') ELSE '[]'::jsonb END) observed(value)
;
 END IF;
END $$;
REVOKE ALL ON FUNCTION application_scope_source_edges(uuid,text,uuid,text) FROM PUBLIC;

-- Reviewed metadata plans remain part of the entity-leaf fingerprint contract.

DO $migration$
DECLARE kernel record;routine record;definition text;values_sql text:='';semantic_hash text;old_values text;
BEGIN
 FOR kernel IN SELECT * FROM (VALUES
  ('public.application_scope_source_edges(uuid,text,uuid,text)','77840ec5461f2255f9cd6ece5703c2321349c06280636d73a566fcfc4d7336f4'),
  ('public.scope_source_ancestors(uuid,text,uuid)','d8e33fb3a66e4318ed159e288c797b6d55759481e1339d4e53c372cb6907e0e8'),
  ('public.scope_source_ancestors_before_workflow_run(uuid,text,uuid)','36bdb461a66fb00b81a5f0f6672b48dcc150858328b035b1ba1da0c3ed3715c8'),
  ('public.scope_source_ancestors_before_browser_session(uuid,text,uuid)','c5a684292738319265321ce21b76ea01ba775eb216af66ae992c190d39eedc5c'),
  ('public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)','401b62c0bf792041938e92d7ea4207f4a3f7bb9f070bfb6a4bea3aa0ee5cb957'),
  ('public.scope_source_table(text)','50b1e162e95c2cb9e01300d2ed70041cf89350004e11476352463eeba1e9d3d6'),
  ('public.scope_source_table_before_persistent_context(text)','77ae7215cf985148bc013cd5afd14cac03776580e347bf548c67b6d1ca7f40da'),
  ('public.scope_source_table_before_media(text)','93ff1be795bfbee59a38c43da3425018072c18007fe39e99ecd4d7e8731eba15')
 ) reviewed(signature,body_sha256) LOOP
  SELECT p.* INTO routine FROM pg_proc p WHERE p.oid=to_regprocedure(kernel.signature);
  IF NOT FOUND OR encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex') IS DISTINCT FROM kernel.body_sha256 THEN
   RAISE EXCEPTION 'Canonical persistent context kernel changed: %',kernel.signature;END IF;
  semantic_hash:=application_field_digest(jsonb_build_object('name',routine.proname,'namespace',routine.pronamespace,'body',routine.prosrc,
   'config',routine.proconfig,'language',routine.prolang,'securityDefiner',routine.prosecdef,'volatility',routine.provolatile,'strict',routine.proisstrict,'parallel',routine.proparallel));
  values_sql:=values_sql||CASE WHEN values_sql='' THEN '' ELSE ',' END||format('(%s::oid,%L::text)',routine.oid,semantic_hash);
 END LOOP;
 SELECT pg_get_functiondef('application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure) INTO definition;
 SELECT substring(definition FROM 'FROM [(]VALUES ([^;]+)[)] pin[(]function_oid,fingerprint[)]') INTO old_values;
 IF old_values IS NULL OR position('count(*)=8 AND coalesce(bool_and' IN definition)=0
  OR position('R2 canonical entity leaf transport' IN definition)=0 THEN RAISE EXCEPTION 'Canonical native leaf shortcut changed';END IF;
 definition:=replace(definition,'FROM (VALUES '||old_values||') pin(function_oid,fingerprint)', 'FROM (VALUES '||values_sql||') pin(function_oid,fingerprint)');
 EXECUTE definition;
END $migration$;
COMMIT;
