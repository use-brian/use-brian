BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;

-- [COMP:api/application-persistence] The current independent-source coordinator
-- discovers legacy retained Knowledge cohorts and related targets as before.
-- A compact search receipt cannot have an independent cohort. Its owning field
-- validator must still replay the complete domain under the actual reader.
DO $knowledge_cohort$
DECLARE
 predecessor constant regprocedure:='public.read_native_knowledge_query_cohort_sources_before_point_identities(uuid,text[],uuid[],text[])'::regprocedure;
 before_kind constant text:=$source$  IF selector.domain->>'kind' IS DISTINCT FROM 'knowledge_query_domain_v1' OR application_query_scope_valid(selector.domain->'bounds') IS NOT TRUE THEN$source$;
 after_kind constant text:=$source$  IF selector.domain->>'kind'='knowledge_search_domain_v1'
   AND selector.domain->>'includeRetained'='false'
   AND application_query_scope_valid(selector.domain->'bounds') IS TRUE THEN CONTINUE;END IF;
  IF selector.domain->>'kind' IS DISTINCT FROM 'knowledge_query_domain_v1' OR application_query_scope_valid(selector.domain->'bounds') IS NOT TRUE THEN$source$;
 definition text;
BEGIN
 IF (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p
   WHERE p.oid=predecessor AND p.prosecdef AND p.proowner=current_user::regrole::oid)
  IS DISTINCT FROM 'ba19eabfa8ae1249cfb9fc60f711d7dfbd10c8fc89491d4badef8c9d51d5bb6e'
 THEN RAISE EXCEPTION 'knowledge_search_cohort_predecessor_changed'; END IF;
 definition:=pg_get_functiondef(predecessor);
 IF cardinality(string_to_array(definition,before_kind))<>2
 THEN RAISE EXCEPTION 'knowledge_search_cohort_source_changed'; END IF;
 EXECUTE replace(definition,before_kind,after_kind);
END $knowledge_cohort$;

COMMIT;
