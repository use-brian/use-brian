BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;

-- [COMP:api/application-persistence] Admit the built-in Knowledge catalog and
-- the same current native principal used by the original point reader.
CREATE FUNCTION public.application_knowledge_search_context(w uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 context jsonb;
 v2 boolean;
BEGIN
 IF actor IS NULL
  OR coalesce(nullif(current_setting('app.agent_actor_id',true),''),actor::text)<>actor::text
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS DISTINCT FROM w::text THEN RETURN NULL; END IF;

 SELECT department_read_v2 INTO v2 FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF acting IS NOT NULL THEN
  PERFORM 1 FROM assistants WHERE workspace_id=w AND id=acting FOR SHARE;
  IF NOT FOUND OR assistant_placement_visible(actor,acting) IS NOT TRUE THEN RETURN NULL; END IF;
 END IF;
 IF v2 THEN
  PERFORM id FROM workspace_groups WHERE workspace_id=w AND kind='team' ORDER BY id FOR SHARE;
  PERFORM id FROM department_edges WHERE workspace_id=w AND (user_id=actor OR assistant_id=acting) ORDER BY id FOR SHARE;
 END IF;

 context:=application_knowledge_query_context(w);
 IF context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true'
  OR NOT coalesce('["content","id","path","sourceId","summary","tags","title"]'::jsonb<@(context->'read'),false)
  OR EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w
   AND o.origin='{"kind":"native","moduleKey":"native"}' AND o.resource_type='knowledge_entry') THEN RETURN NULL; END IF;
 RETURN context;
END $$;

-- Use the existing native envelope and bounds authorities once per distinct
-- scope. A built-in Knowledge leaf has no user/assistant partition. The legacy
-- native parent additionally requires active Projects and the current member's
-- Project grant. Any potentially admitted retained leaf uses the general path.
-- The metadata-only proof and optional FTS use one admitted cohort and snapshot.
CREATE FUNCTION public.application_knowledge_search_snapshot(w uuid,bounds jsonb,disabled jsonb,deny_assistant uuid,
 query_text text DEFAULT NULL,result_limit integer DEFAULT NULL,restrict_source boolean DEFAULT false,
 requested_source uuid DEFAULT NULL,clearance text DEFAULT NULL,allowed_compartments text[] DEFAULT NULL,
 allowed_projects uuid[] DEFAULT NULL) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH workspace AS MATERIALIZED (
  SELECT department_read_v2 AS v2 FROM workspaces WHERE id=w
   AND NOT EXISTS(SELECT 1 FROM knowledge_entries k WHERE k.workspace_id=w OFFSET 4096 LIMIT 1)
   AND NOT EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w
    AND o.origin='{"kind":"native","moduleKey":"native"}' AND o.resource_type='knowledge_entry')
   AND (deny_assistant IS NULL OR EXISTS(SELECT 1 FROM assistants a WHERE a.workspace_id=w AND a.id=deny_assistant))
   AND disabled=(SELECT coalesce(jsonb_agg(d.source_id ORDER BY d.source_id),'[]')
    FROM assistant_disabled_knowledge_sources d WHERE d.assistant_id=deny_assistant)
 ), candidates AS MATERIALIZED (
  SELECT k.id,k.scope_version,k.created_at,k.source_id,k.sensitivity,k.compartments,k.project_ids
  FROM workspace CROSS JOIN knowledge_entries k WHERE k.workspace_id=w AND NOT k.scope_held
   AND (k.source_id IS NULL OR NOT disabled ? k.source_id::text)
   AND NOT EXISTS(SELECT 1 FROM scope_resource_states state WHERE state.resource_kind='knowledge_entry'
    AND state.resource_id=k.id AND state.review_state='held')
 ), scopes AS MATERIALIZED (
  SELECT DISTINCT c.sensitivity,c.compartments,c.project_ids FROM candidates c
 ), admitted_scopes AS MATERIALIZED (
  SELECT s.* FROM scopes s CROSS JOIN workspace x
  CROSS JOIN LATERAL (SELECT jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,
   'sensitivity',s.sensitivity,'compartments',s.compartments,'projectIds',s.project_ids) AS scope) envelope
  WHERE application_query_scope_admits_point(bounds,envelope.scope) IS TRUE
   AND workflow_evidence_envelope_visible(w,envelope.scope) IS TRUE
   AND (x.v2 OR NOT EXISTS(
    SELECT 1 FROM unnest(s.project_ids) AS required(id) WHERE NOT EXISTS(
     SELECT 1 FROM workspace_projects p WHERE p.workspace_id=w AND p.id=required.id AND p.status='active'
      AND (EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w
       AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND m.role IN ('owner','admin'))
       OR EXISTS(SELECT 1 FROM workspace_project_members m WHERE m.project_id=p.id
        AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)))))
 ), admitted AS MATERIALIZED (
  SELECT c.* FROM candidates c JOIN admitted_scopes s USING(sensitivity,compartments,project_ids)
 ), unsupported AS MATERIALIZED (
  SELECT EXISTS(SELECT 1 FROM admitted a JOIN scope_derivations d
    ON d.workspace_id=w AND d.resource_kind='knowledge_entry' AND d.resource_id=a.id)
   OR EXISTS(SELECT 1 FROM admitted a JOIN knowledge_entry_revision_publications p
    ON p.workspace_id=w AND p.entry_id=a.id)
   OR EXISTS(SELECT 1 FROM admitted a JOIN application_field_resources r ON r.workspace_id=w AND r.resource_id=a.id
    WHERE r.origin='{"kind":"native","moduleKey":"native"}' AND r.type_key='knowledge_entry'
     AND r.selection='query' AND r.fields=ARRAY['content','id','path','sourceId','summary','tags','title']
     AND (EXISTS(SELECT 1 FROM scope_resource_states state WHERE state.resource_kind='application_field'
       AND state.resource_id=r.id AND state.review_state='held')
      OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='application_field' AND d.resource_id=r.id)
      OR EXISTS(SELECT 1 FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=r.id))) AS retained
 ), fingerprint AS MATERIALIZED (
  SELECT application_field_digest(coalesce(jsonb_agg(jsonb_build_array(a.id,a.scope_version,
   extract(epoch FROM a.created_at),a.source_id,a.sensitivity,a.compartments,a.project_ids) ORDER BY a.id),'[]')) AS digest
  FROM admitted a
 ), envelope AS MATERIALIZED (
  -- A miss consumes the cohort as well. Preserve the maximum tier and the
  -- union of compartment and Project floors from its individual observations.
  SELECT jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity',
   CASE (SELECT max(sensitivity_rank(s.sensitivity)) FROM admitted_scopes s)
    WHEN 3 THEN 'confidential' WHEN 2 THEN 'internal' ELSE 'public' END,
   'compartments',ARRAY(SELECT DISTINCT label FROM admitted_scopes s CROSS JOIN LATERAL unnest(s.compartments) label ORDER BY label),
   'projectIds',ARRAY(SELECT DISTINCT id FROM admitted_scopes s CROSS JOIN LATERAL unnest(s.project_ids) id ORDER BY id)) AS scope
 ), complete AS MATERIALIZED (
  SELECT e.scope FROM envelope e CROSS JOIN workspace CROSS JOIN unsupported u
  CROSS JOIN LATERAL (SELECT application_normalize_native_query_bounds(bounds)->>'contextDepartment' AS id) department
  WHERE NOT u.retained AND entity_derivation_envelope_valid(e.scope) IS TRUE
   AND workflow_evidence_envelope_visible(w,e.scope) IS TRUE
   AND application_query_scope_admits_point(bounds,e.scope) IS TRUE
   -- The caller's original closure rejects every Team outside a named Department.
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(e.scope->'compartments') label
    WHERE label LIKE 'team:%' AND substr(label,6)<>department.id)
 ), locked AS MATERIALIZED (
  -- A lock wait can reveal a new head. The exact version join and the cohort
  -- cardinality check keep such a head from becoming a false non-match.
  SELECT k.id FROM complete CROSS JOIN admitted a JOIN knowledge_entries k
   ON k.workspace_id=w AND k.id=a.id AND k.scope_version=a.scope_version
  ORDER BY k.id FOR SHARE OF k
 ), current_cohort AS MATERIALIZED (
  SELECT c.scope FROM complete c WHERE (SELECT count(*) FROM locked)=(SELECT count(*) FROM admitted)
 ), searchable AS MATERIALIZED (
  -- Keep matching outside this materialized relation so the planner cannot
  -- move the text predicate ahead of the native/field/selector admission.
  SELECT a.*,k.search_vector FROM current_cohort CROSS JOIN admitted a JOIN knowledge_entries k
   ON k.workspace_id=w AND k.id=a.id AND k.scope_version=a.scope_version
  WHERE query_text IS NOT NULL
   AND sensitivity_rank(a.sensitivity)<=sensitivity_rank(clearance)
   AND (allowed_compartments IS NULL OR a.compartments<@allowed_compartments)
   AND (allowed_projects IS NULL OR a.project_ids<@allowed_projects)
   AND (NOT restrict_source OR a.source_id IS NOT DISTINCT FROM requested_source)
 ), matched AS MATERIALIZED (
  SELECT s.id,s.scope_version,ts_rank_cd(s.search_vector,q.terms) AS rank,
   jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity',s.sensitivity,
    'compartments',s.compartments,'projectIds',s.project_ids,'resourceKind','knowledge_entry',
    'resourceId',s.id,'version',s.scope_version::text) AS source
  FROM searchable s CROSS JOIN LATERAL (SELECT plainto_tsquery('pg_catalog.english',query_text) AS terms) q
  WHERE s.search_vector @@ q.terms ORDER BY rank DESC,s.id LIMIT result_limit
 )
 SELECT CASE WHEN EXISTS(SELECT 1 FROM searchable WHERE search_vector IS NULL) THEN NULL
  ELSE jsonb_build_object('digest',f.digest,'scope',c.scope,'hits',coalesce((SELECT jsonb_agg(jsonb_build_object(
   'id',m.id,'version',m.scope_version::text,'rank',m.rank,'source',m.source) ORDER BY m.rank DESC,m.id) FROM matched m),'[]')) END
 FROM current_cohort c CROSS JOIN fingerprint f
$$;

CREATE FUNCTION public.application_knowledge_search_domain_state(w uuid,frozen application_query_domains,fields text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb; scanned jsonb; disabled jsonb;
BEGIN
 IF frozen.domain->>'kind' IS DISTINCT FROM 'knowledge_search_domain_v1'
  OR fields IS DISTINCT FROM ARRAY['content','id','path','sourceId','summary','tags','title']
  OR frozen.domain->'fields' IS DISTINCT FROM to_jsonb(fields)
  OR frozen.domain->>'includeRetained' IS DISTINCT FROM 'false'
  OR frozen.domain-ARRAY['kind','fields','bounds','visibility','includeRetained','denyAssistantId','disabledSources','digest']<>'{}'
  OR coalesce(frozen.domain->>'digest','') !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
 context:=application_knowledge_search_context(w);
 IF context IS NULL OR context#>>'{policy,metadata,schemaVersion}' IS DISTINCT FROM frozen.schema_version
  OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false)
  OR application_query_scope_union_contains(frozen.domain->'bounds',jsonb_build_array(context->'bounds'),4096)->>'contains' IS DISTINCT FROM 'true'
  OR frozen.domain->'visibility' IS DISTINCT FROM context->'visibility' THEN RETURN NULL; END IF;
 disabled:=application_knowledge_query_disabled_sources(w,(frozen.domain->>'denyAssistantId')::uuid);
 IF disabled IS NULL OR disabled IS DISTINCT FROM frozen.domain->'disabledSources' THEN RETURN NULL; END IF;
 scanned:=application_knowledge_search_snapshot(w,frozen.domain->'bounds',disabled,(frozen.domain->>'denyAssistantId')::uuid);
 IF scanned IS NULL OR scanned->'digest' IS DISTINCT FROM frozen.domain->'digest' THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('values','{}'::jsonb,'source',scanned->'scope','recordVersion',frozen.schema_version,
  'sourceKind','application_query_domain','sourceId',frozen.id,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','knowledge_search_domain_v1','identity',frozen.identity,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','knowledge_search_domain_v1','identity',frozen.identity,
   'policy',context#>'{policy,fingerprint}','digest',scanned->'digest')),'references','[]'::jsonb);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;

DO $knowledge_search_predecessor$
BEGIN
 IF (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p
  WHERE p.oid='public.application_knowledge_query_domain_state(uuid,uuid,text[])'::regprocedure
   AND p.proowner=current_user::regrole::oid AND p.prosecdef)
  IS DISTINCT FROM '4ece1af8bc0b8375f5c6a8fa613d46bbd2c7436b92bda877e3b59ebfb2204796'
 THEN RAISE EXCEPTION 'knowledge_search_query_domain_predecessor_changed'; END IF;
END $knowledge_search_predecessor$;
ALTER FUNCTION public.application_knowledge_query_domain_state(uuid,uuid,text[]) RENAME TO application_knowledge_exact_query_domain_state;
CREATE FUNCTION public.application_knowledge_query_domain_state(w uuid,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen application_query_domains;
BEGIN
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=i
  AND origin='{"kind":"native","moduleKey":"native"}' AND type_key='knowledge_entry';
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF frozen.domain->>'kind'='knowledge_search_domain_v1' THEN RETURN application_knowledge_search_domain_state(w,frozen,fields); END IF;
 RETURN application_knowledge_exact_query_domain_state(w,i,fields);
END $$;

CREATE FUNCTION public.read_native_knowledge_search(w uuid,deny_assistant uuid,query_text text,result_limit integer,
 restrict_source boolean,requested_source uuid,clearance text,allowed_compartments text[],allowed_projects uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 native_origin constant jsonb:='{"kind":"native","moduleKey":"native"}';
 fields constant text[]:=ARRAY['content','id','path','sourceId','summary','tags','title'];
 context jsonb; disabled jsonb; scanned jsonb; domain jsonb; frozen application_query_domains;
 domain_identity text; domain_id uuid; schema_version text; captured jsonb; hit jsonb; row_capture jsonb;
 result_rows jsonb:='[]';
BEGIN
 IF query_text IS NULL OR result_limit IS NULL OR result_limit NOT BETWEEN 0 AND 512
  OR restrict_source IS NULL OR sensitivity_rank(clearance) IS NULL THEN RETURN NULL; END IF;
 context:=application_knowledge_search_context(w);
 IF context IS NULL THEN RETURN NULL; END IF;
 disabled:=application_knowledge_query_disabled_sources(w,deny_assistant);
 IF disabled IS NULL THEN RETURN NULL; END IF;
 scanned:=application_knowledge_search_snapshot(w,context->'bounds',disabled,deny_assistant,query_text,result_limit,
  restrict_source,requested_source,clearance,allowed_compartments,allowed_projects);
 IF scanned IS NULL THEN RETURN NULL; END IF;

 schema_version:=context#>>'{policy,metadata,schemaVersion}';
 domain:=jsonb_build_object('kind','knowledge_search_domain_v1','fields',fields,'bounds',context->'bounds',
  'visibility',context->'visibility','includeRetained',false,'denyAssistantId',deny_assistant,'disabledSources',disabled,
  'digest',scanned->'digest');
 domain_identity:=application_field_digest(jsonb_build_object('kind','knowledge_search_domain_v1','workspaceId',w,'domain',domain));
 domain_id:=application_field_resource_uuid(domain_identity);
 INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity)
 VALUES(domain_id,w,native_origin,'knowledge_entry',schema_version,domain,domain_identity) ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM application_query_domains q WHERE q.workspace_id=w AND q.id=domain_id;
 IF NOT FOUND OR (frozen.origin,frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity)
  IS DISTINCT FROM (native_origin,'knowledge_entry',schema_version,domain,domain_identity) THEN
  RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023'; END IF;
 captured:=observe_application_field_projection(w,native_origin,'knowledge_entry',domain_id,schema_version,'query_domain',NULL,fields);
 IF (captured#>'{sources,0}')-ARRAY['resourceKind','resourceId','version'] IS DISTINCT FROM scanned->'scope' THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 FOR hit IN SELECT value FROM jsonb_array_elements(scanned->'hits') LOOP
  row_capture:=observe_application_field_projection(w,native_origin,'knowledge_entry',(hit->>'id')::uuid,hit->>'version','query',NULL,fields);
  IF row_capture#>'{values,id}' IS DISTINCT FROM hit->'id'
   OR (row_capture#>'{sources,0}')-ARRAY['resourceKind','resourceId','version']
    IS DISTINCT FROM (hit->'source')-ARRAY['resourceKind','resourceId','version'] THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
  result_rows:=result_rows||jsonb_build_array(jsonb_build_object('row',(row_capture->'values')-'content'||jsonb_build_object('rank',hit->'rank'),
   'source',hit->'source','sources',row_capture->'sources'));
 END LOOP;
 RETURN jsonb_build_object('rows',result_rows,'sources',captured->'sources');
END $$;

REVOKE ALL ON FUNCTION public.application_knowledge_search_context(uuid),
 public.application_knowledge_search_snapshot(uuid,jsonb,jsonb,uuid,text,integer,boolean,uuid,text,text[],uuid[]),
 public.application_knowledge_search_domain_state(uuid,application_query_domains,text[]),
 public.application_knowledge_exact_query_domain_state(uuid,uuid,text[]),
 public.application_knowledge_query_domain_state(uuid,uuid,text[]),
 public.read_native_knowledge_search(uuid,uuid,text,integer,boolean,uuid,text,text[],uuid[]) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON FUNCTION public.application_knowledge_search_context(uuid),
  public.application_knowledge_search_snapshot(uuid,jsonb,jsonb,uuid,text,integer,boolean,uuid,text,text[],uuid[]),
  public.application_knowledge_search_domain_state(uuid,application_query_domains,text[]),
  public.application_knowledge_exact_query_domain_state(uuid,uuid,text[]),
  public.application_knowledge_query_domain_state(uuid,uuid,text[]) FROM app_user;
 GRANT EXECUTE ON FUNCTION public.read_native_knowledge_search(uuid,uuid,text,integer,boolean,uuid,text,text[],uuid[]) TO app_user;
END IF; END $$;

COMMIT;
