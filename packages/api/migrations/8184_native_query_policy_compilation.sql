BEGIN;
-- Compile canonical default-native policy without re-evaluating identical rules.
-- Registered module policies retain their original validator and role evaluator.
-- This migration changes no ACL, function identity, source receipt or lease.

DO $guard$ BEGIN IF (SELECT md5(p.prosrc)='e46c55f81c705777f634302ec767f5f6' AND p.prosecdef AND p.provolatile='v' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']::text[] FROM pg_proc p WHERE p.oid='public.application_generic_query_catalog_policy(uuid,jsonb,text)'::regprocedure) IS NOT TRUE THEN RAISE EXCEPTION 'native_query_compilation_predecessor_changed'; END IF; END $guard$;

DO $guard$ BEGIN IF (SELECT md5(p.prosrc)='7ff7b44ab494fd2e28c81582946f6550' AND p.prosecdef AND p.provolatile='s' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']::text[] FROM pg_proc p WHERE p.oid='public.application_native_query_field_metadata(uuid,text,text[])'::regprocedure) IS NOT TRUE THEN RAISE EXCEPTION 'native_query_compilation_predecessor_changed'; END IF; END $guard$;

DO $guard$ BEGIN IF (SELECT md5(p.prosrc)='f498b41406d0f4535aaedd65fce90650' AND p.prosecdef AND p.provolatile='v' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']::text[] FROM pg_proc p WHERE p.oid='public.application_native_query_context_before_public_share(uuid,text)'::regprocedure) IS NOT TRUE THEN RAISE EXCEPTION 'native_query_compilation_predecessor_changed'; END IF; END $guard$;

CREATE OR REPLACE FUNCTION public.application_generic_query_catalog_policy(w uuid, p_origin jsonb, p_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE policy jsonb; keys text[]; metadata jsonb; fields jsonb; scope jsonb;
BEGIN
 IF p_origin<>'{"kind":"native","moduleKey":"native"}'::jsonb THEN
  RETURN application_query_catalog_policy_before_native(w,p_origin,p_type);
 END IF;
 IF p_type NOT IN('company','person','deal','task') THEN RETURN NULL;END IF;
 policy:=application_native_field_catalog_for(w,p_origin,p_type);
 IF policy->>'registered' IS DISTINCT FROM 'false' THEN RETURN policy;END IF;
 keys:=ARRAY(SELECT DISTINCT field FROM (
  SELECT unnest(application_native_field_keys(p_type)) AS field UNION SELECT 'custom.'||f.field_key FROM crm_field_definitions f
   WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL) fields ORDER BY field);
 metadata:=application_native_query_field_metadata(w,p_type,keys);IF metadata IS NULL THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',field,'read','[]'::jsonb,'write','[]'::jsonb,
  'releaseReadTo',jsonb_build_array('external_user','service'),'releaseWriteTo',jsonb_build_array('external_user','service')) ORDER BY field),'[]') INTO fields FROM unnest(keys) field;
 -- Every generated read/write rule is the same immutable empty conjunction;
 -- every release profile is the same two fixed allowed values. Validate the
 -- variable dictionary keys once. The UNION above already establishes uniqueness.
 IF cardinality(keys)>128 OR EXISTS(SELECT 1 FROM unnest(keys) field
  WHERE field IS NULL OR length(field) NOT BETWEEN 1 AND 128
   OR field=ANY(ARRAY['__proto__','prototype','constructor'])) THEN RETURN NULL;END IF;
 scope:=jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb);
 RETURN jsonb_build_object('registered',true,'held',false,'nativeDefault',true,'roleKeys','[]'::jsonb,
  'metadata',jsonb_build_object('moduleKey','native','origin',p_origin,'typeKey',p_type,'schemaVersion',application_field_digest(metadata),
   'policyVersion','native-query-v1','fieldKeys',keys,'fields',fields,'scope',scope),
  'fingerprint',application_field_digest(jsonb_build_object('kind','native-query-v1','workspaceId',w,'typeKey',p_type,'fields',metadata,'scope',scope)));
END $function$;


CREATE OR REPLACE FUNCTION public.application_native_query_field_metadata(w uuid, p_type text, p_fields text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE metadata jsonb; builtin_keys text[];
BEGIN
 IF p_type NOT IN('company','person','deal','task') OR p_fields IS NULL OR cardinality(p_fields)>128
  OR array_position(p_fields,NULL) IS NOT NULL OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_fields) field) THEN RETURN NULL;END IF;
 builtin_keys:=application_native_field_keys(p_type);
 SELECT coalesce(jsonb_agg(item ORDER BY item->>'key'),'[]') INTO metadata FROM (
  SELECT jsonb_build_object('key',field,'kind','builtin','version',public.application_native_builtin_field_revision(p_type,field)) AS item
   FROM unnest(p_fields) field WHERE field=ANY(builtin_keys) AND NOT EXISTS(
    SELECT 1 FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL AND 'custom.'||f.field_key=field)
  UNION ALL SELECT (to_jsonb(f)-ARRAY['label','position','created_at','updated_at'])||jsonb_build_object('key','custom.'||f.field_key)
   FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL AND 'custom.'||f.field_key=ANY(p_fields)
 ) fields;
 IF jsonb_array_length(metadata)<>cardinality(p_fields) THEN RETURN NULL;END IF;
 RETURN metadata;
END $function$;


CREATE OR REPLACE FUNCTION public.application_native_query_context_before_public_share(w uuid, p_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE origin jsonb:='{"kind":"native","moduleKey":"native"}'; policy jsonb; admitted jsonb; formula jsonb; mask jsonb; bounds jsonb; compiled jsonb;private_formula jsonb;visibility jsonb;
BEGIN
 IF p_type NOT IN('company','person','deal','task') OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entities'::regclass
  WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  admitted:=application_current_query_catalog(w,origin,p_type);IF admitted IS NULL THEN RETURN NULL;END IF;
  policy:=admitted->'policy';mask:=jsonb_build_object('read',admitted->'read');
  compiled:=application_compile_query_catalog_domain(w,admitted,nullif(current_setting('app.current_user_id',true),'')::uuid);
  formula:=compiled->'formula';private_formula:=compiled->'privateFormula';
 ELSE
  bounds:=application_native_query_bounds(w);IF bounds IS NULL THEN RETURN NULL;END IF;
  policy:=application_generic_query_catalog_policy(w,origin,p_type);
  IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
   OR workflow_evidence_envelope_visible(w,policy#>'{metadata,scope}') IS NOT TRUE THEN RETURN NULL;END IF;
  IF policy->>'nativeDefault'='true' THEN
   -- The default catalog contains only empty rules, so its mask is exactly
   -- its sorted vocabulary for a current member. Registered catalogs below
   -- still evaluate their current role assignments and per-field rules.
   IF NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w
    AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid) THEN RETURN NULL;END IF;
   mask:=jsonb_build_object('read',policy#>'{metadata,fieldKeys}');
  ELSE
   admitted:=read_native_application_field_catalog(w,origin,p_type);mask:=jsonb_build_object('read',admitted->'readFields');
  END IF;
  formula:=jsonb_build_object('kind','application_query','version',1,'clauses',jsonb_build_array(
   jsonb_build_object('scope',bounds,'read',mask->'read','selector',jsonb_build_object('ids','null'::jsonb,'ownerId',NULL,'relationships','[]'::jsonb,'empty',false))));
 END IF;
 IF mask IS NULL OR jsonb_typeof(mask->'read') IS DISTINCT FROM 'array' OR formula IS NULL
  OR application_query_domain_contains(formula,formula,'{}') IS NOT TRUE THEN RETURN NULL;END IF;
 visibility:=application_native_query_visibility();IF visibility IS NULL THEN RETURN NULL;END IF;
 IF private_formula IS NULL THEN private_formula:=formula;END IF;
 IF visibility->>'shared'='true' THEN private_formula:=jsonb_build_object('kind','application_query','version',1,'clauses','[]'::jsonb);END IF;
 IF application_query_domain_contains(private_formula,private_formula,'{}') IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('policy',policy,'read',mask->'read','formula',formula,'privateFormula',private_formula,
  'visibility',jsonb_build_object('userId',CASE WHEN jsonb_array_length(private_formula->'clauses')>0 THEN visibility->'userId' ELSE 'null'::jsonb END,'assistants',visibility->'assistants'));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $function$;


COMMIT;
