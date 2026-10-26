BEGIN;
-- [COMP:security/native-field-policy] Preserve the actual native query domain,
-- including Department-v2 and shared Project read authority, without row payloads.
ALTER FUNCTION application_native_query_bounds(uuid) RENAME TO application_native_query_bounds_before_departments;
CREATE FUNCTION application_native_query_bounds(w uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 member jsonb; binding jsonb; ceiling jsonb:='null'; projects jsonb; departments jsonb; labels jsonb; others jsonb;
 context_department text; base int; legacy_cap int:=3;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.workspaces wk WHERE wk.id=w AND wk.department_read_v2) THEN
  RETURN public.application_native_query_bounds_before_departments(w);
 END IF;
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR public.agent_visibility_allows(w,NULL,NULL) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.application_query_domains'::regclass
    WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL; END IF;
 member:=public.member_principal_operation_grants(actor,false,w)#>ARRAY[w::text,'v2'];
 IF jsonb_typeof(member) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 -- Match workflow_evidence_envelope_visible's extra legacy assistant ceiling.
 IF nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL
  AND current_setting('app.v2_active',true) IS DISTINCT FROM 'true'
  AND nullif(current_setting('app.v2_assistant_id',true),'') IS NULL THEN
  legacy_cap:=public.sensitivity_rank(current_setting('app.agent_clearance',true));
  IF legacy_cap IS NULL THEN RETURN NULL; END IF;
  ceiling:=coalesce(nullif(current_setting('app.agent_compartments',true),'')::jsonb,'[]'::jsonb);
 END IF;
 binding:=member->'k';context_department:=member->>'c';base:=least((member->>'b')::int,legacy_cap);
 projects:=coalesce(nullif(current_setting('app.agent_project_ids',true),'')::jsonb,'null'::jsonb);
 IF base IS NULL OR base NOT BETWEEN 0 AND 3 OR jsonb_typeof(member->'d') IS DISTINCT FROM 'object'
  OR binding IS NULL OR jsonb_typeof(binding) NOT IN('array','null')
  OR jsonb_typeof(ceiling) NOT IN('array','null') OR jsonb_typeof(projects) NOT IN('array','null') THEN RETURN NULL; END IF;
 IF context_department IS NOT NULL THEN PERFORM context_department::uuid; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(member->'d') d WHERE jsonb_typeof(d.value)<>'number' OR (d.value#>>'{}')::int NOT BETWEEN 0 AND 3)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN binding='null' THEN '[]'::jsonb ELSE binding END) item WHERE jsonb_typeof(item)<>'string')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN ceiling='null' THEN '[]'::jsonb ELSE ceiling END) item WHERE jsonb_typeof(item)<>'string')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN projects='null' THEN '[]'::jsonb ELSE projects END) item WHERE jsonb_typeof(item)<>'string') THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_object_agg(key,least((value#>>'{}')::int,legacy_cap) ORDER BY key),'{}') INTO departments
  FROM jsonb_each(member->'d') WHERE (binding='null' OR binding ? key) AND (ceiling='null' OR ceiling ? ('team:'||key))
   AND least((value#>>'{}')::int,legacy_cap)>0;
 PERFORM key::uuid FROM jsonb_each(departments);
 SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') INTO labels FROM (
  SELECT DISTINCT value#>>'{}' AS id FROM jsonb_array_elements((member->'p')||(member->'o'))
  WHERE (binding='null' OR binding ? (value#>>'{}')) AND (ceiling='null' OR ceiling ? ('project:'||(value#>>'{}')))) allowed;
 PERFORM (value#>>'{}')::uuid FROM jsonb_array_elements(labels);
 IF ceiling='null' THEN others:='null';
 ELSE SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO others FROM (
  SELECT DISTINCT value FROM jsonb_array_elements(ceiling) WHERE value#>>'{}' NOT LIKE 'team:%' AND value#>>'{}' NOT LIKE 'project:%') allowed; END IF;
 IF projects<>'null' THEN
  PERFORM (value#>>'{}')::uuid FROM jsonb_array_elements(projects);
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO projects FROM (SELECT DISTINCT value FROM jsonb_array_elements(projects)) allowed;
 END IF;
 IF (SELECT count(*) FROM jsonb_each(departments))>256 OR jsonb_array_length(labels)>256
  OR others<>'null' AND jsonb_array_length(others)>256 OR projects<>'null' AND jsonb_array_length(projects)>256 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('kind','native_department_v2','tier',base,'departments',departments,'contextDepartment',context_department,
  'projectLabels',labels,'otherLabels',others,'projectIds',projects);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_native_query_bounds(uuid),application_native_query_bounds_before_departments(uuid) FROM PUBLIC;

-- Normalize historical legacy metadata too. A null Department map is the
-- original legacy universe, not today's finite roster of Department IDs.
CREATE FUNCTION application_normalize_native_query_bounds(bounds jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE departments jsonb; labels jsonb; tier int;
BEGIN
 IF bounds IS NULL OR bounds->>'kind' NOT IN('native_legacy','native_department_v2') THEN RETURN NULL; END IF;
 tier:=(bounds->>'tier')::int;
 IF tier IS NULL OR tier NOT BETWEEN 0 AND 3 THEN RETURN NULL; END IF;
 IF bounds->>'kind'='native_department_v2' THEN RETURN bounds; END IF;
 labels:=bounds->'compartments';
 IF labels='null' THEN departments:='null';
 ELSE
  SELECT coalesce(jsonb_object_agg(substr(value#>>'{}',6),tier),'{}') INTO departments
   FROM jsonb_array_elements(labels) WHERE value#>>'{}' LIKE 'team:%';
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO labels FROM (
   SELECT DISTINCT value FROM jsonb_array_elements(labels) WHERE value#>>'{}' NOT LIKE 'team:%' AND value#>>'{}' NOT LIKE 'project:%') allowed;
 END IF;
 RETURN jsonb_build_object('kind','native_department_v2','tier',tier,'departments',departments,'contextDepartment',NULL,
  'projectLabels','[]'::jsonb,'otherLabels',labels,'projectIds',bounds->'projectIds');
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_normalize_native_query_bounds(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION application_query_bounds_contain(current_bounds jsonb,original jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE current_domain jsonb:=public.application_normalize_native_query_bounds(current_bounds);
 original_domain jsonb:=public.application_normalize_native_query_bounds(original);
 tier int; original_departments text[]; current_context text;
BEGIN
 IF current_domain IS NULL OR original_domain IS NULL
  OR (current_domain->>'tier')::int<(original_domain->>'tier')::int
  OR NOT (original_domain->'projectLabels')<@(current_domain->'projectLabels')
  OR (current_domain->'otherLabels'<>'null' AND (original_domain->'otherLabels'='null'
    OR NOT (original_domain->'otherLabels')<@(current_domain->'otherLabels')))
  OR (current_domain->'projectIds'<>'null' AND (original_domain->'projectIds'='null'
    OR NOT (original_domain->'projectIds')<@(current_domain->'projectIds'))) THEN RETURN false; END IF;
 current_context:=current_domain->>'contextDepartment';
 FOR tier IN 1..3 LOOP
  IF original_domain->'departments'='null' THEN
   IF tier<=(original_domain->>'tier')::int AND (current_domain->'departments'<>'null'
    OR tier>(current_domain->>'tier')::int OR current_context IS NOT NULL) THEN RETURN false; END IF;
   CONTINUE;
  END IF;
  SELECT coalesce(array_agg(key ORDER BY key),'{}') INTO original_departments FROM jsonb_each(original_domain->'departments')
   WHERE (value#>>'{}')::int>=tier;
  IF cardinality(original_departments)=0 OR original_domain->>'contextDepartment' IS NOT NULL
   AND NOT (original_domain->>'contextDepartment'=ANY(original_departments)) THEN CONTINUE; END IF;
  IF current_domain->'departments'='null' THEN
   IF tier>(current_domain->>'tier')::int THEN RETURN false; END IF;
  ELSIF EXISTS(SELECT 1 FROM unnest(original_departments) id
   WHERE coalesce((current_domain#>>ARRAY['departments',id])::int,0)<tier) THEN RETURN false; END IF;
  IF current_context IS NOT NULL AND current_context IS DISTINCT FROM original_domain->>'contextDepartment'
   AND NOT (cardinality(original_departments)=1 AND original_departments[1]=current_context) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_query_bounds_contain(jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION application_native_query_bounds(uuid),application_native_query_bounds_before_departments(uuid),
   application_normalize_native_query_bounds(jsonb),application_query_bounds_contain(jsonb,jsonb) FROM app_user;
 END IF;
END $$;
COMMIT;
