-- Native memory context admission before protected computation. [COMP:api/application-persistence]
BEGIN;
DO $$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
  WHERE oid='public.application_memory_field_ancestry_allows(uuid,uuid,text)'::regprocedure)
  IS DISTINCT FROM 'eeae7c6edb71360441d091f6edd0ada1dd9582127dd14b3bc64e820a8ecd8c2e' THEN RAISE EXCEPTION 'Memory field ancestry contract changed';END IF;
END $$;
ALTER FUNCTION application_memory_field_ancestry_allows(uuid,uuid,text) RENAME TO application_memory_field_ancestry_before_context;
REVOKE ALL ON FUNCTION application_memory_field_ancestry_before_context(uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION application_memory_field_ancestry_allows(w uuid,i uuid,v text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE dependency record;
BEGIN
 IF application_memory_field_ancestry_before_context(w,i,v) IS NOT TRUE THEN RETURN false;END IF;
 FOR dependency IN SELECT * FROM read_admitted_session_context_dependencies(w,ARRAY['memory'],ARRAY[i],ARRAY[v]) LOOP
  -- Owner metadata cannot act as a native viewer, even with copied actor GUCs.
  IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.memories'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN insufficient_privilege OR invalid_parameter_value OR invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_memory_field_ancestry_allows(uuid,uuid,text) FROM PUBLIC;
ALTER POLICY application_memory_field_ancestry_floor ON memories
 USING(application_memory_field_ancestry_allows(workspace_id,id,scope_version::text));

-- This private holding predicate returns no content and confers no native row
-- visibility. Unproved system/share projections cannot use labels as authority
-- for independently admitted observations, including historical native edges.
CREATE FUNCTION application_memory_unproven_ancestry_allows(w uuid,i uuid,v text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN NOT EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY['memory'],ARRAY[i],ARRAY[v]) node
  WHERE node.kind IN('session_context_revision','application_field','external_source',
   'page_event_changed','page_event_destination','page_live_changed','page_live_destination'));
EXCEPTION WHEN insufficient_privilege OR invalid_parameter_value OR invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_memory_unproven_ancestry_allows(uuid,uuid,text) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION application_memory_field_ancestry_before_context(uuid,uuid,text),application_memory_unproven_ancestry_allows(uuid,uuid,text) FROM app_user;
  GRANT EXECUTE ON FUNCTION application_memory_field_ancestry_allows(uuid,uuid,text) TO app_user;
 END IF;
END $$;

-- Preserve reviewed bodies and put caller-writable temporary schemas last.
DO $repair$
DECLARE reviewed record;routine record;
BEGIN
 FOR reviewed IN SELECT * FROM (VALUES
  ('guard_episodic_promotion','c911a4715176ae9dd0ecd0e8928e7e6a04edb0cc5bbfb79ddb15d93e238f5ed9'),
  ('guard_session_context_content','ed3b3e4190f44f2a130d06d1a6e739e1602b7d537cb9febb75e69b01d6cc8f02'),
  ('guard_session_context_lineage','970b284e9d53ffffc75c68415b3fcf53137fff1c7de3dd611faaae369d75e38e'),
  ('guard_session_context_revision','5488a95b456e20b272b086c0d4ffd5e4849d7b4388c7801d4181af03ce8e84c9'),
  ('guard_session_message_annotation_head','492cdb5760b6f3687bd9eed6ade0f9f815faced0aa9fdbc270ad3d7d3334b80f'),
  ('hold_scope_descendants','cd1bf25f1e1efec03fac13c05441c9930217ff19dd672e6ed36dd385356b2fb7'),
  ('purge_session_context_parent','3c216aa21cfa9ca4372d8549448a5781cc8f383f965f6bcaa06aa2a130d1559f'),
  ('purge_session_message_annotations','63edea69af3de3905115ebdbb751278fc5fd3eb8f2aa9d248238e5e7e223dcd0'),
  ('read_admitted_native_scope_snapshot','bc3db1aed4d28b1b2370f93814113a706114017651b20986715bde843a07a24d'),
  ('read_admitted_session_context_dependencies','6be0b3552521839ca6a4ed1461d99ac3075aef7896980476471a73af5eed5601'),
  ('read_entity_derivation_source','d77c03dff1ca14de5989a2b9ac7245c8fe53cad9157bd07d4a3903c48dc4f090'),
  ('read_scope_source','1dcd42d80b74fa720d77b1493eb523d8231d46afd6fb64a1e1d1a756a937fef1'),
  ('read_session_context_revision','0ee584d21b76c002b277b751c452a61ec22c1561558033286fbdbbe5348fbd79'),
  ('scope_source_table','50b1e162e95c2cb9e01300d2ed70041cf89350004e11476352463eeba1e9d3d6'),
  ('session_context_parent_snapshot','908e0af94d168f44d77e8cb9eb30e73d3317dfc71896b7b39e28e1a6f2139444'),
  ('session_context_payload_shape','d9372fa543a5c89ac8ed787c24941df2360646086eb33ca144520483da769c78'),
  ('session_context_revision_allowed','388329a1ab8bfa72030a9d50e402d19f549a7b2d9c819c176e4c38c37d2d5d09'),
  ('session_context_revision_native','fa533effc6857389976a9373697565e16e90e46453fcdf8fbaf3925c7eb4d82a'),
  ('session_context_revision_snapshot','8e1cbd4e1cddcfad62a53431a90de1f2ce3d5c9de6dfb94503fa5bb8de2eab56'),
  ('session_personal_audience','0b0c5bc436a2d90f816f4c9add2f716585a9cdc0edb947bafa0cfb4e5c30e708'),
  ('session_project_audience','323e6f79d846c0a6c99479203c7a018c8f5ac9e00c69e3d1c01e57740c6deaa0'),
  ('session_workspace_audience','0a4a6d805cfcb3170651e0f16f4c8a6918d0f6ea58038c70ade693c3f199a52a'),
  ('validate_session_context_revision_pair','4ee18b712e3f445bd32f57dfdecd5840ce07f2e605d0eb4808f9ffe3e934dc57')
 ) pins(name,body_sha256) LOOP
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=reviewed.name)<>1 THEN RAISE EXCEPTION 'Persistent function identity changed: %',reviewed.name;END IF;
  SELECT p.* INTO routine FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname=reviewed.name;
  IF encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex') IS DISTINCT FROM reviewed.body_sha256
   OR routine.proconfig IS NULL OR NOT (routine.proconfig @> ARRAY['search_path=pg_catalog, public']
    OR routine.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
   RAISE EXCEPTION 'Persistent function contract changed: %',reviewed.name;END IF;
  EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path=pg_catalog,public,pg_temp',
   'public',routine.proname,pg_catalog.pg_get_function_identity_arguments(routine.oid));
 END LOOP;
END $repair$;

-- Refresh only the reviewed metadata fingerprints after the configuration repair.
DO $migration$
DECLARE kernel record;routine record;definition text;values_sql text:='';semantic_hash text;old_values text;
BEGIN
 FOR kernel IN SELECT * FROM (VALUES
  ('public.application_scope_source_edges(uuid,text,uuid,text)','20d8c359a6b77c9c96aed3be9e31719e60868fb55e34aaedc2714494e6a8e974'),
  ('public.scope_source_ancestors(uuid,text,uuid)','d8e33fb3a66e4318ed159e288c797b6d55759481e1339d4e53c372cb6907e0e8'),
  ('public.scope_source_ancestors_before_workflow_run(uuid,text,uuid)','36bdb461a66fb00b81a5f0f6672b48dcc150858328b035b1ba1da0c3ed3715c8'),
  ('public.scope_source_ancestors_before_browser_session(uuid,text,uuid)','c5a684292738319265321ce21b76ea01ba775eb216af66ae992c190d39eedc5c'),
  ('public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)','497af5b78abd438a9332b52ba0e1eb6115997adfc447f239727d5948d626463a'),
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
