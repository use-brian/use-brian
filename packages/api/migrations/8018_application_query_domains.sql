BEGIN;
-- [COMP:security/native-field-policy] Row-free query vocabulary is metadata,
-- never a substitute for original selector domains or record/source admission.
CREATE FUNCTION application_query_set_intersection(a jsonb,b jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN a IS NULL OR b IS NULL THEN NULL WHEN a='null' THEN b WHEN b='null' THEN a
  ELSE (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM (
   SELECT value FROM jsonb_array_elements(a) INTERSECT SELECT value FROM jsonb_array_elements(b)) shared) END
$$;
REVOKE ALL ON FUNCTION application_query_set_intersection(jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION application_query_scope_intersection(a jsonb,b jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE left_scope jsonb:=public.application_normalize_native_query_bounds(a); right_scope jsonb:=public.application_normalize_native_query_bounds(b);
 departments jsonb; context_department text;
BEGIN
 IF left_scope IS NULL OR right_scope IS NULL THEN RETURN NULL; END IF;
 IF left_scope->>'contextDepartment' IS NOT NULL AND right_scope->>'contextDepartment' IS NOT NULL
  AND left_scope->>'contextDepartment'<>right_scope->>'contextDepartment' THEN RETURN NULL; END IF;
 context_department:=coalesce(left_scope->>'contextDepartment',right_scope->>'contextDepartment');
 IF left_scope->'departments'='null' AND right_scope->'departments'='null' THEN departments:='null';
 ELSE
  SELECT coalesce(jsonb_object_agg(key,rank ORDER BY key),'{}') INTO departments FROM (
   SELECT key,least(CASE WHEN left_scope->'departments'='null' THEN (left_scope->>'tier')::int ELSE coalesce((left_scope#>>ARRAY['departments',key])::int,0) END,
    CASE WHEN right_scope->'departments'='null' THEN (right_scope->>'tier')::int ELSE coalesce((right_scope#>>ARRAY['departments',key])::int,0) END) AS rank
   FROM (SELECT jsonb_object_keys(CASE WHEN left_scope->'departments'='null' THEN '{}'::jsonb ELSE left_scope->'departments' END) AS key
    UNION SELECT jsonb_object_keys(CASE WHEN right_scope->'departments'='null' THEN '{}'::jsonb ELSE right_scope->'departments' END)) keys) common WHERE rank>0;
 END IF;
 RETURN jsonb_build_object('kind','native_department_v2','tier',least((left_scope->>'tier')::int,(right_scope->>'tier')::int),
  'departments',departments,'contextDepartment',context_department,
  'projectLabels',public.application_query_set_intersection(left_scope->'projectLabels',right_scope->'projectLabels'),
  'otherLabels',public.application_query_set_intersection(left_scope->'otherLabels',right_scope->'otherLabels'),
  'projectIds',public.application_query_set_intersection(left_scope->'projectIds',right_scope->'projectIds'));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_query_scope_intersection(jsonb,jsonb) FROM PUBLIC;

-- An unrestricted label cap is internal algebra, never a captured native scope.
-- The result is intersected with actual canonical principal bounds before use.
CREATE FUNCTION application_query_scope_cap(rank int,compartments jsonb,projects jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE departments jsonb; labels jsonb; others jsonb;
BEGIN
 IF rank IS NULL OR rank NOT BETWEEN 0 AND 3 OR compartments IS NULL OR projects IS NULL
  OR jsonb_typeof(compartments) NOT IN('array','null') OR jsonb_typeof(projects) NOT IN('array','null') THEN RETURN NULL; END IF;
 IF compartments='null' THEN departments:='null';labels:='null';others:='null';
 ELSE
  IF jsonb_array_length(compartments)>256 OR EXISTS(SELECT 1 FROM jsonb_array_elements(compartments) item WHERE jsonb_typeof(item)<>'string') THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_object_agg(substr(value#>>'{}',6),rank),'{}') INTO departments FROM jsonb_array_elements(compartments) WHERE value#>>'{}' LIKE 'team:%';
  PERFORM key::uuid FROM jsonb_each(departments);
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO labels FROM (
   SELECT DISTINCT to_jsonb(substr(value#>>'{}',9)) AS value FROM jsonb_array_elements(compartments) WHERE value#>>'{}' LIKE 'project:%') allowed;
  PERFORM (value#>>'{}')::uuid FROM jsonb_array_elements(labels);
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO others FROM (
   SELECT DISTINCT value FROM jsonb_array_elements(compartments) WHERE value#>>'{}' NOT LIKE 'team:%' AND value#>>'{}' NOT LIKE 'project:%') allowed;
 END IF;
 IF projects<>'null' THEN
  IF jsonb_array_length(projects)>256 OR EXISTS(SELECT 1 FROM jsonb_array_elements(projects) item WHERE jsonb_typeof(item)<>'string') THEN RETURN NULL; END IF;
  PERFORM (value#>>'{}')::uuid FROM jsonb_array_elements(projects);
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO projects FROM (SELECT DISTINCT value FROM jsonb_array_elements(projects)) allowed;
 END IF;
 RETURN jsonb_build_object('kind','native_department_v2','tier',rank,'departments',departments,'contextDepartment',NULL,
  'projectLabels',labels,'otherLabels',others,'projectIds',projects);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_query_scope_cap(int,jsonb,jsonb) FROM PUBLIC;

-- Arbitrary-principal facts stay private and are used only for verified issuer
-- and member links. No caller GUC is replaced with a former issuer's identity.
CREATE FUNCTION application_principal_query_bounds(w uuid,p_actor uuid,p_release boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE member jsonb; v2 jsonb; scope jsonb; rank int; cap int:=3; teams jsonb; ceiling jsonb; projects jsonb;
 departments jsonb; labels jsonb; others jsonb; binding jsonb; assistant uuid; assistant_cap int; shared_projects jsonb;
BEGIN
 IF p_actor IS NULL OR p_release IS NULL OR public.agent_visibility_allows(w,NULL,NULL) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.application_query_domains'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL; END IF;
 member:=public.member_principal_operation_grants(p_actor,false,w)->w::text;
 IF member IS NULL THEN RETURN NULL; END IF;
 projects:=coalesce(nullif(current_setting('app.agent_project_ids',true),'')::jsonb,'null'::jsonb);
 IF jsonb_typeof(member->'v2')='object' THEN
  v2:=member->'v2';binding:=v2->'k';ceiling:='null';
  IF nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL
   AND current_setting('app.v2_active',true) IS DISTINCT FROM 'true' AND nullif(current_setting('app.v2_assistant_id',true),'') IS NULL THEN
   cap:=public.sensitivity_rank(current_setting('app.agent_clearance',true));
   ceiling:=coalesce(nullif(current_setting('app.agent_compartments',true),'')::jsonb,'[]'::jsonb);
  END IF;
  IF cap IS NULL OR binding IS NULL OR jsonb_typeof(binding) NOT IN('array','null')
   OR jsonb_typeof(ceiling) NOT IN('array','null')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN binding='null' THEN '[]'::jsonb ELSE binding END) item WHERE jsonb_typeof(item)<>'string')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN ceiling='null' THEN '[]'::jsonb ELSE ceiling END) item WHERE jsonb_typeof(item)<>'string') THEN RETURN NULL; END IF;
  IF v2->>'c' IS NOT NULL THEN PERFORM (v2->>'c')::uuid; END IF;
  SELECT coalesce(jsonb_object_agg(key,least((value#>>'{}')::int,cap) ORDER BY key),'{}') INTO departments
   FROM jsonb_each(v2->'d') WHERE (binding='null' OR binding ? key) AND (ceiling='null' OR ceiling ? ('team:'||key)) AND least((value#>>'{}')::int,cap)>0;
  SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') INTO labels FROM (
   SELECT DISTINCT value#>>'{}' AS id FROM jsonb_array_elements((v2->'p')||(v2->'o'))
   WHERE (binding='null' OR binding ? (value#>>'{}')) AND (ceiling='null' OR ceiling ? ('project:'||(value#>>'{}')))) allowed;
  PERFORM key::uuid FROM jsonb_each(departments);
  PERFORM (value#>>'{}')::uuid FROM jsonb_array_elements(labels);
  IF ceiling='null' THEN others:='null';
  ELSE SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO others FROM (
   SELECT DISTINCT value FROM jsonb_array_elements(ceiling) WHERE value#>>'{}' NOT LIKE 'team:%' AND value#>>'{}' NOT LIKE 'project:%') allowed; END IF;
  scope:=jsonb_build_object('kind','native_department_v2','tier',least((v2->>'b')::int,cap),'departments',departments,
   'contextDepartment',v2->'c','projectLabels',labels,'otherLabels',others,'projectIds',projects);
 ELSE
  rank:=(member->>'r')::int;
  IF nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL THEN
   cap:=public.sensitivity_rank(current_setting('app.agent_clearance',true));
   IF cap IS NULL THEN RETURN NULL; END IF;
   rank:=least(rank,cap);
  END IF;
  teams:=public.application_query_set_intersection(member->'c',coalesce(nullif(current_setting('app.agent_compartments',true),'')::jsonb,'null'::jsonb));
  scope:=public.application_normalize_native_query_bounds(jsonb_build_object('kind','native_legacy','tier',rank,'compartments',teams,'projectIds',projects));
 END IF;
 IF scope IS NULL OR public.application_query_scope_cap((scope->>'tier')::int,'null',scope->'projectIds') IS NULL
  OR (SELECT count(*) FROM jsonb_each(CASE WHEN scope->'departments'='null' THEN '{}'::jsonb ELSE scope->'departments' END))>256
  OR jsonb_array_length(scope->'projectLabels')>256 OR scope->'otherLabels'<>'null' AND jsonb_array_length(scope->'otherLabels')>256 THEN RETURN NULL; END IF;
 IF NOT p_release THEN RETURN scope; END IF;
 assistant:=nullif(current_setting('app.application_assistant_id',true),'')::uuid;
 SELECT public.sensitivity_rank(a.clearance) INTO assistant_cap FROM public.assistants a WHERE a.workspace_id=w AND a.id=assistant;
 IF assistant_cap IS NULL THEN RETURN NULL; END IF;
 cap:=public.sensitivity_rank(nullif(current_setting('app.agent_clearance',true),''));
 IF nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL AND cap IS NULL THEN RETURN NULL; END IF;
 cap:=least(assistant_cap,coalesce(cap,3));
 scope:=public.application_query_scope_intersection(scope,public.application_query_scope_cap(cap,
  coalesce(nullif(current_setting('app.agent_compartments',true),'')::jsonb,'null'::jsonb),projects));
 IF jsonb_typeof(member->'v2') IS DISTINCT FROM 'object' THEN
  scope:=public.application_query_scope_intersection(scope,public.application_query_scope_cap(assistant_cap,coalesce(to_jsonb(public.legacy_assistant_team_compartments(assistant)),'null'::jsonb), 'null'));
 END IF;
 SELECT coalesce(jsonb_agg(s.project_id::text ORDER BY s.project_id),'[]') INTO shared_projects
  FROM public.project_shared_scopes s JOIN public.workspaces wk ON wk.id=s.workspace_id
  WHERE s.workspace_id=w AND s.status='active' AND wk.project_shared_spaces
   AND public.project_member_live(s.project_id,'user',p_actor) AND public.project_member_live(s.project_id,'assistant',assistant);
 RETURN jsonb_set(scope,'{projectIds}',public.application_query_set_intersection(scope->'projectIds',shared_projects));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_principal_query_bounds(uuid,uuid,boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION application_native_query_bounds(w uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN RETURN NULL; END IF;
 RETURN public.application_principal_query_bounds(w,nullif(current_setting('app.current_user_id',true),'')::uuid,false);
END $$;
REVOKE ALL ON FUNCTION application_native_query_bounds(uuid) FROM PUBLIC;

-- Profile labels do not remove an actual member's native scope or field floor.
CREATE OR REPLACE FUNCTION application_path_fields(maximum jsonb,subject jsonb,w uuid,origin jsonb,type_key text,record_id text,owner_id uuid,
 tier text,teams text[],projects uuid[],row_user uuid,action text,prospective_data jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE decision jsonb; policy jsonb; issued jsonb; current_grant public.application_access_grants; issuer_mask jsonb; principal_mask jsonb; member_mask jsonb; native_member boolean;
BEGIN
 decision:=public.application_path_fields_before_module_policy(maximum,subject,w,origin,type_key,record_id,owner_id,tier,teams,projects,row_user,action,prospective_data);
 IF decision IS NULL THEN RETURN NULL; END IF;
 FOR issued IN SELECT value FROM jsonb_array_elements(maximum->'grants') LOOP
  SELECT * INTO current_grant FROM public.application_access_grants g WHERE g.id=(issued->>'id')::uuid
   AND g.workspace_id=w AND g.app_id=(public.application_current_maxima()->>'appId')::uuid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF current_grant.principal_kind<>'member' AND EXISTS(SELECT 1 FROM public.workspace_members m
   WHERE m.workspace_id=w AND m.user_id=current_grant.principal_user_id) THEN
   IF public.application_release_scope_allows(current_grant.principal_user_id,w,tier,teams,projects,row_user) IS NOT TRUE
    OR action NOT IN('read','query','history','schema') AND public.member_operation_row_allows(
     public.member_principal_operation_grants(current_grant.principal_user_id,true,w),w,tier,teams) IS NOT TRUE THEN RETURN NULL; END IF;
  END IF;
 END LOOP;
 policy:=public.application_native_field_contract_for(w,origin,type_key,record_id);
 IF policy->>'registered'='false' THEN RETURN decision; END IF;
 IF policy->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL; END IF;
 FOR issued IN SELECT value FROM jsonb_array_elements(maximum->'grants') LOOP
  SELECT * INTO current_grant FROM public.application_access_grants g WHERE g.id=(issued->>'id')::uuid
   AND g.workspace_id=w AND g.app_id=(public.application_current_maxima()->>'appId')::uuid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  issuer_mask:=public.application_native_member_field_permissions(w,policy,current_grant.issued_by_user_id);
  native_member:=EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=w AND m.user_id=current_grant.principal_user_id);
  principal_mask:=CASE WHEN current_grant.principal_kind='member'
   THEN public.application_native_member_field_permissions(w,policy,current_grant.principal_user_id)
   ELSE public.application_native_nonmember_field_permissions(policy,current_grant.principal_kind) END;
  IF issuer_mask IS NULL OR principal_mask IS NULL THEN RETURN NULL; END IF;
  IF native_member AND current_grant.principal_kind<>'member' THEN
   member_mask:=public.application_native_member_field_permissions(w,policy,current_grant.principal_user_id);
   IF member_mask IS NULL THEN RETURN NULL; END IF;
   principal_mask:=jsonb_build_object('read',public.application_query_set_intersection(principal_mask->'read',member_mask->'read'),
    'write',public.application_query_set_intersection(principal_mask->'write',member_mask->'write'));
  END IF;
  decision:=jsonb_build_object('read',ARRAY(SELECT jsonb_array_elements_text(decision->'read')
    INTERSECT SELECT jsonb_array_elements_text(issuer_mask->'read') INTERSECT SELECT jsonb_array_elements_text(principal_mask->'read')),
   'write',ARRAY(SELECT jsonb_array_elements_text(decision->'write')
    INTERSECT SELECT jsonb_array_elements_text(issuer_mask->'write') INTERSECT SELECT jsonb_array_elements_text(principal_mask->'write')));
 END LOOP;
 RETURN decision;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR datetime_field_overflow THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_path_fields(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb) FROM PUBLIC;

CREATE FUNCTION application_generic_query_catalog_policy(w uuid,p_origin jsonb,p_type text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy jsonb; canonical public.entity_types; keys jsonb; fields jsonb; scope jsonb;
BEGIN
 IF p_origin->>'kind' IS DISTINCT FROM 'generic' OR p_origin-ARRAY['kind','entityTypeId']<>'{}'::jsonb THEN RETURN NULL; END IF;
 policy:=public.application_native_field_catalog_for(w,p_origin,p_type);
 IF policy->>'registered' IS DISTINCT FROM 'false' THEN RETURN policy; END IF;
 SELECT * INTO canonical FROM public.entity_types t WHERE t.workspace_id=w AND t.id=(p_origin->>'entityTypeId')::uuid;
 IF NOT FOUND OR jsonb_typeof(canonical.properties) IS DISTINCT FROM 'array' OR jsonb_array_length(canonical.properties)>128 THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(p->'name' ORDER BY p->>'name'),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('key',p->'name','read','[]'::jsonb,'write','[]'::jsonb,
   'releaseReadTo',jsonb_build_array('external_user','service'),'releaseWriteTo',jsonb_build_array('external_user','service')) ORDER BY p->>'name'),'[]')
  INTO keys,fields FROM jsonb_array_elements(canonical.properties) p;
 IF public.application_native_field_dictionary_valid(keys,fields,'{}') IS NOT TRUE THEN RETURN NULL; END IF;
 -- entity_types is already workspace-visible metadata, without row sensitivity.
 -- This scope describes the schema only; query domains are captured separately.
 scope:=jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb);
 RETURN jsonb_build_object('registered',true,'held',false,'genericDefault',true,'roleKeys','[]'::jsonb,
  'metadata',jsonb_build_object('moduleKey','records','origin',p_origin,'typeKey',p_type,'schemaVersion',canonical.schema_version::text,
   'policyVersion','generic-schema-v1','fieldKeys',keys,'fields',fields,'scope',scope),
  'fingerprint',public.application_field_digest(jsonb_build_object('kind','generic-schema-v1','workspaceId',w,'origin',p_origin,
   'schemaVersion',canonical.schema_version::text,'properties',canonical.properties,'scope',scope)));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_generic_query_catalog_policy(uuid,jsonb,text) FROM PUBLIC;

CREATE FUNCTION application_query_catalog_selector_valid(w uuid,p_origin jsonb,selector jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF jsonb_typeof(selector) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 CASE selector->>'kind'
  WHEN 'ids' THEN
   RETURN selector-ARRAY['kind','ids']='{}'::jsonb AND jsonb_typeof(selector->'ids')='array'
    AND jsonb_array_length(selector->'ids') BETWEEN 1 AND 100
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(selector->'ids') item
     WHERE jsonb_typeof(item)<>'string' OR length(item#>>'{}') NOT BETWEEN 1 AND 256);
  WHEN 'self' THEN RETURN selector-ARRAY['kind']='{}'::jsonb;
  WHEN 'relationship' THEN
   RETURN selector-ARRAY['kind','resolverKey','anchorId']='{}'::jsonb
    AND jsonb_typeof(selector->'resolverKey')='string' AND jsonb_typeof(selector->'anchorId')='string'
    AND length(selector->>'anchorId') BETWEEN 1 AND 256 AND EXISTS(
     SELECT 1 FROM public.entity_types t,LATERAL jsonb_array_elements(t.properties) p
     WHERE t.workspace_id=w AND t.id=(p_origin->>'entityTypeId')::uuid AND p#>>'{config,kind}'='relation'
      AND 'relation.'||encode(sha256(convert_to(p->>'name','UTF8')),'hex')=selector->>'resolverKey');
  ELSE RETURN false;
 END CASE;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_query_catalog_selector_valid(uuid,jsonb,jsonb) FROM PUBLIC;

-- Same canonical chain bindings and live issuer/member/module field floors as
-- application_path_fields, without choosing or synthesizing a business record.
CREATE FUNCTION application_query_catalog_path(context jsonb,maximum jsonb,subject jsonb,w uuid,p_origin jsonb,p_type text,policy jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE issued jsonb; current_grant public.application_access_grants; permissions jsonb; scope jsonb:=policy#>'{metadata,scope}';
 read_keys text[]; issuer_mask jsonb; principal_mask jsonb; member_mask jsonb; native_member boolean; seen uuid[]:='{}'; next_id uuid; count_value int:=0;
 selectors jsonb:='[]'; limits jsonb:='[]'; issuers jsonb:='[]'; members jsonb:='[]';
BEGIN
 IF context->>'workspaceId' IS DISTINCT FROM w::text OR policy->>'registered' IS DISTINCT FROM 'true'
  OR policy->>'held' IS DISTINCT FROM 'false' OR maximum->>'version' IS DISTINCT FROM '1'
  OR jsonb_typeof(maximum->'grants') IS DISTINCT FROM 'array' OR jsonb_array_length(maximum->'grants') NOT BETWEEN 1 AND 16 THEN RETURN NULL; END IF;
 IF context->>'maxClearance' IS NOT NULL AND public.sensitivity_rank(scope->>'sensitivity')>public.sensitivity_rank(context->>'maxClearance') THEN RETURN NULL; END IF;
 FOR issued IN SELECT value FROM jsonb_array_elements(maximum->'grants') LOOP
  SELECT * INTO current_grant FROM public.application_access_grants g WHERE g.id=(issued->>'id')::uuid
   AND g.app_id=(context->>'appId')::uuid AND g.workspace_id=w;
  IF NOT FOUND OR current_grant.id=ANY(seen) OR count_value>0 AND current_grant.id IS DISTINCT FROM next_id
   OR count_value=0 AND (current_grant.principal_user_id::text IS DISTINCT FROM subject->>'userId'
    OR subject ? 'kind' AND current_grant.principal_kind IS DISTINCT FROM subject->>'kind')
   OR current_grant.parent_grant_id IS DISTINCT FROM (issued->>'parentGrantId')::uuid
   OR issued->>'appId' IS DISTINCT FROM context->>'appId' OR issued->>'workspaceId' IS DISTINCT FROM w::text
   OR current_grant.resource_origin IS DISTINCT FROM issued->'origin' OR current_grant.resource_type IS DISTINCT FROM issued->>'typeKey'
   OR current_grant.principal_user_id::text IS DISTINCT FROM issued#>>'{principal,userId}'
   OR current_grant.principal_kind IS DISTINCT FROM issued#>>'{principal,kind}'
   OR NOT EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=w AND m.user_id=current_grant.issued_by_user_id AND m.role IN('owner','admin'))
   OR public.application_release_scope_allows(current_grant.issued_by_user_id,w,scope->>'sensitivity',
    ARRAY(SELECT jsonb_array_elements_text(scope->'compartments')),ARRAY(SELECT jsonb_array_elements_text(scope->'projectIds'))::uuid[],(scope->>'userId')::uuid) IS NOT TRUE THEN RETURN NULL; END IF;
  native_member:=EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=w AND m.user_id=current_grant.principal_user_id);
  IF (current_grant.principal_kind='member' OR native_member) AND public.application_release_scope_allows(current_grant.principal_user_id,w,scope->>'sensitivity',
   ARRAY(SELECT jsonb_array_elements_text(scope->'compartments')),ARRAY(SELECT jsonb_array_elements_text(scope->'projectIds'))::uuid[],(scope->>'userId')::uuid) IS NOT TRUE THEN RETURN NULL; END IF;
  issuer_mask:=public.application_native_member_field_permissions(w,policy,current_grant.issued_by_user_id);
  principal_mask:=CASE WHEN current_grant.principal_kind='member'
   THEN public.application_native_member_field_permissions(w,policy,current_grant.principal_user_id)
   ELSE public.application_native_nonmember_field_permissions(policy,current_grant.principal_kind) END;
  IF issuer_mask IS NULL OR principal_mask IS NULL THEN RETURN NULL; END IF;
  IF native_member AND current_grant.principal_kind<>'member' THEN
   member_mask:=public.application_native_member_field_permissions(w,policy,current_grant.principal_user_id);
   IF member_mask IS NULL THEN RETURN NULL; END IF;
   principal_mask:=jsonb_build_object('read',public.application_query_set_intersection(principal_mask->'read',member_mask->'read'),
    'write',public.application_query_set_intersection(principal_mask->'write',member_mask->'write'));
  END IF;
  FOR permissions IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
   jsonb_build_object('status',current_grant.status,'startsAt',current_grant.starts_at,'expiresAt',current_grant.expires_at,
    'origin',current_grant.resource_origin,'typeKey',current_grant.resource_type,'actions',current_grant.actions,'selector',current_grant.selector,
    'clearance',current_grant.clearance,'compartments',current_grant.compartments,'projectIds',current_grant.project_ids,'readFields',current_grant.read_fields),issued)) LOOP
   IF NOT coalesce(permissions->>'status'='active' AND (permissions->>'startsAt')::timestamptz<=statement_timestamp()
    AND (permissions->>'expiresAt' IS NULL OR (permissions->>'expiresAt')::timestamptz>statement_timestamp())
    AND permissions->'origin'=p_origin AND permissions->>'typeKey'=p_type AND permissions->'actions' ? 'query'
    AND public.sensitivity_rank(scope->>'sensitivity')<=public.sensitivity_rank(permissions->>'clearance')
    AND (scope->'compartments')<@(permissions->'compartments') AND (scope->'projectIds')<@(permissions->'projectIds')
    AND jsonb_typeof(permissions->'readFields')='array' AND jsonb_array_length(permissions->'readFields')<=128
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(permissions->'readFields') field WHERE jsonb_typeof(field)<>'string')
    AND public.application_query_catalog_selector_valid(w,p_origin,permissions->'selector'),false) THEN RETURN NULL; END IF;
   IF read_keys IS NULL THEN read_keys:=ARRAY(SELECT jsonb_array_elements_text(permissions->'readFields'));
   ELSE read_keys:=ARRAY(SELECT unnest(read_keys) INTERSECT SELECT jsonb_array_elements_text(permissions->'readFields')); END IF;
   selectors:=selectors||jsonb_build_array((permissions->'selector')||CASE WHEN permissions#>>'{selector,kind}'='self'
    THEN jsonb_build_object('ownerId',current_grant.principal_user_id) ELSE '{}'::jsonb END);
   limits:=limits||jsonb_build_array(jsonb_build_object('clearance',permissions->'clearance','compartments',permissions->'compartments','projectIds',permissions->'projectIds'));
  END LOOP;
  read_keys:=ARRAY(SELECT unnest(read_keys) INTERSECT SELECT jsonb_array_elements_text(issuer_mask->'read')
   INTERSECT SELECT jsonb_array_elements_text(principal_mask->'read'));
  issuers:=issuers||jsonb_build_array(current_grant.issued_by_user_id);
  IF current_grant.principal_kind='member' OR native_member THEN members:=members||jsonb_build_array(current_grant.principal_user_id); END IF;
  seen:=array_append(seen,current_grant.id);next_id:=current_grant.parent_grant_id;count_value:=count_value+1;
 END LOOP;
 IF next_id IS NOT NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('read',ARRAY(SELECT DISTINCT unnest(read_keys) ORDER BY 1),'selectors',selectors,'limits',limits,'issuers',issuers,'members',members);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_query_catalog_path(jsonb,jsonb,jsonb,uuid,jsonb,text,jsonb) FROM PUBLIC;

CREATE FUNCTION application_current_query_catalog(w uuid,p_origin jsonb,p_type text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb; policy jsonb; layer jsonb; maximum jsonb; path jsonb; paths jsonb; layers jsonb:='[]';
 layer_fields text[]; readable text[]; admitted boolean;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entity_types'::regclass
  WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL; END IF;
 context:=public.application_current_maxima();
 IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text OR p_type IS NULL OR length(p_type) NOT BETWEEN 1 AND 128 THEN RETURN NULL; END IF;
 policy:=public.application_generic_query_catalog_policy(w,p_origin,p_type);
 IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
  OR public.agent_visibility_allows(w,(policy#>>'{metadata,scope,userId}')::uuid,(policy#>>'{metadata,scope,assistantId}')::uuid) IS NOT TRUE THEN RETURN NULL; END IF;
 FOR layer IN SELECT value FROM jsonb_array_elements(context->'layers') LOOP
  layer_fields:='{}';admitted:=false;paths:='[]';
  FOR maximum IN SELECT value FROM jsonb_array_elements(layer->'maxima') LOOP
   path:=public.application_query_catalog_path(context,maximum,layer->'principal',w,p_origin,p_type,policy);
   IF path IS NULL THEN CONTINUE; END IF;
   admitted:=true;layer_fields:=layer_fields||ARRAY(SELECT jsonb_array_elements_text(path->'read'));paths:=paths||jsonb_build_array(path);
  END LOOP;
  IF NOT admitted THEN RETURN NULL; END IF;
  IF readable IS NULL THEN readable:=layer_fields;
  ELSE readable:=ARRAY(SELECT unnest(readable) INTERSECT SELECT unnest(layer_fields)); END IF;
  layers:=layers||jsonb_build_array(paths);
 END LOOP;
 IF readable IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('read',ARRAY(SELECT DISTINCT unnest(readable) ORDER BY 1),'policy',policy,'layers',layers);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_current_query_catalog(uuid,jsonb,text) FROM PUBLIC;

CREATE FUNCTION application_query_selector_meet(a jsonb,b jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ids jsonb; relationships jsonb; owner_id text; empty_value boolean;
BEGIN
 IF a IS NULL OR b IS NULL THEN RETURN NULL; END IF;
 ids:=public.application_query_set_intersection(a->'ids',b->'ids');
 owner_id:=coalesce(a->>'ownerId',b->>'ownerId');
 SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO relationships FROM (
  SELECT DISTINCT value FROM jsonb_array_elements((a->'relationships')||(b->'relationships'))) relations;
 empty_value:=coalesce((a->>'empty')::boolean,false) OR coalesce((b->>'empty')::boolean,false)
  OR ids<>'null' AND jsonb_array_length(ids)=0
  OR a->>'ownerId' IS NOT NULL AND b->>'ownerId' IS NOT NULL AND a->>'ownerId'<>b->>'ownerId'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(relationships) relation GROUP BY relation->>'resolverKey' HAVING count(DISTINCT relation->>'anchorId')>1);
 RETURN jsonb_build_object('ids',ids,'ownerId',owner_id,'relationships',relationships,'empty',empty_value);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_query_selector_meet(jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION application_query_selector_normalize(selectors jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selector jsonb; item jsonb; result jsonb:=jsonb_build_object('ids','null'::jsonb,'ownerId',NULL,'relationships','[]'::jsonb,'empty',false);
BEGIN
 IF selectors IS NULL OR jsonb_typeof(selectors) IS DISTINCT FROM 'array' OR jsonb_array_length(selectors)>64 THEN RETURN NULL; END IF;
 FOR selector IN SELECT value FROM jsonb_array_elements(selectors) LOOP
  CASE selector->>'kind'
   WHEN 'ids' THEN item:=jsonb_build_object('ids',selector->'ids','ownerId',NULL,'relationships','[]'::jsonb,'empty',false);
   WHEN 'self' THEN
    IF selector->>'ownerId' IS NULL THEN RETURN NULL; END IF;
    PERFORM (selector->>'ownerId')::uuid;
    item:=jsonb_build_object('ids','null'::jsonb,'ownerId',selector->'ownerId','relationships','[]'::jsonb,'empty',false);
   WHEN 'relationship' THEN item:=jsonb_build_object('ids','null'::jsonb,'ownerId',NULL,'relationships',
    jsonb_build_array(jsonb_build_object('resolverKey',selector->'resolverKey','anchorId',selector->'anchorId')),'empty',false);
   ELSE RETURN NULL;
  END CASE;
  result:=public.application_query_selector_meet(result,item);
  IF result IS NULL THEN RETURN NULL; END IF;
 END LOOP;
 RETURN result;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_query_selector_normalize(jsonb) FROM PUBLIC;

CREATE FUNCTION application_compile_query_catalog_domain(w uuid,admitted jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE layer jsonb; path jsonb; principal jsonb; limits jsonb; scope jsonb; current_scope jsonb; selectors jsonb;
 clause jsonb; left_clause jsonb; right_clause jsonb; combined jsonb; readable jsonb;
 layer_clauses jsonb[]; clauses jsonb[]; next_clauses jsonb[]; layer_index int:=0;
BEGIN
 IF admitted IS NULL OR jsonb_typeof(admitted->'layers') IS DISTINCT FROM 'array' OR jsonb_array_length(admitted->'layers') NOT BETWEEN 1 AND 2 THEN RETURN NULL; END IF;
 FOR layer IN SELECT value FROM jsonb_array_elements(admitted->'layers') LOOP
  IF jsonb_typeof(layer) IS DISTINCT FROM 'array' OR jsonb_array_length(layer) NOT BETWEEN 1 AND 128 THEN RETURN NULL; END IF;
  layer_clauses:='{}';
  FOR path IN SELECT value FROM jsonb_array_elements(layer) LOOP
   scope:=NULL;
   IF jsonb_array_length(path->'issuers') NOT BETWEEN 1 AND 16 OR jsonb_array_length(path->'members')>16 THEN RETURN NULL; END IF;
   FOR principal IN SELECT DISTINCT value FROM jsonb_array_elements((path->'issuers')||(path->'members')) LOOP
    current_scope:=public.application_principal_query_bounds(w,(principal#>>'{}')::uuid,true);
    IF current_scope IS NULL THEN RETURN NULL; END IF;
    scope:=CASE WHEN scope IS NULL THEN current_scope ELSE public.application_query_scope_intersection(scope,current_scope) END;
    IF scope IS NULL THEN RETURN NULL; END IF;
   END LOOP;
   FOR limits IN SELECT value FROM jsonb_array_elements(path->'limits') LOOP
    scope:=public.application_query_scope_intersection(scope,public.application_query_scope_cap(public.sensitivity_rank(limits->>'clearance'),limits->'compartments',limits->'projectIds'));
    IF scope IS NULL THEN RETURN NULL; END IF;
   END LOOP;
   selectors:=public.application_query_selector_normalize(path->'selectors');
   IF selectors IS NULL OR jsonb_typeof(scope->'projectLabels') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
   IF selectors->>'empty'='true' THEN CONTINUE; END IF;
   layer_clauses:=array_append(layer_clauses,jsonb_build_object('scope',scope,'selector',selectors,'read',path->'read'));
  END LOOP;
  SELECT coalesce(array_agg(DISTINCT value ORDER BY value),'{}') INTO layer_clauses FROM unnest(layer_clauses) value;
  IF layer_index=0 THEN clauses:=layer_clauses;
  ELSE
   next_clauses:='{}';
   FOREACH left_clause IN ARRAY clauses LOOP
    FOREACH right_clause IN ARRAY layer_clauses LOOP
     selectors:=public.application_query_selector_meet(left_clause->'selector',right_clause->'selector');
     IF selectors IS NULL THEN RETURN NULL; END IF;
     IF selectors->>'empty'='true' THEN CONTINUE; END IF;
     current_scope:=public.application_query_scope_intersection(left_clause->'scope',right_clause->'scope');
     IF current_scope IS NULL THEN RETURN NULL; END IF;
     readable:=public.application_query_set_intersection(left_clause->'read',right_clause->'read');
     combined:=jsonb_build_object('scope',current_scope,'selector',selectors,'read',readable);
     IF cardinality(next_clauses)>=4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
     next_clauses:=array_append(next_clauses,combined);
    END LOOP;
   END LOOP;
   SELECT coalesce(array_agg(DISTINCT value ORDER BY value),'{}') INTO clauses FROM unnest(next_clauses) value;
  END IF;
  layer_index:=layer_index+1;
 END LOOP;
 RETURN jsonb_build_object('kind','application_query','version',1,'clauses',to_jsonb(clauses));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_compile_query_catalog_domain(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION application_query_scope_valid(scope jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF scope->>'kind'='native_legacy' THEN
  IF NOT scope ?& ARRAY['kind','tier','compartments','projectIds'] OR scope-ARRAY['kind','tier','compartments','projectIds']<>'{}'::jsonb
   OR jsonb_typeof(scope->'compartments') NOT IN('array','null') OR jsonb_typeof(scope->'projectIds') NOT IN('array','null') THEN RETURN false; END IF;
  scope:=public.application_normalize_native_query_bounds(scope);
 END IF;
 IF scope IS NULL OR jsonb_typeof(scope) IS DISTINCT FROM 'object' OR scope->>'kind' IS DISTINCT FROM 'native_department_v2'
  OR NOT scope ?& ARRAY['kind','tier','departments','contextDepartment','projectLabels','otherLabels','projectIds']
  OR scope-ARRAY['kind','tier','departments','contextDepartment','projectLabels','otherLabels','projectIds']<>'{}'::jsonb
  OR jsonb_typeof(scope->'tier') IS DISTINCT FROM 'number' OR (scope->>'tier')::int NOT BETWEEN 0 AND 3
  OR jsonb_typeof(scope->'departments') NOT IN('object','null') OR jsonb_typeof(scope->'contextDepartment') NOT IN('string','null')
  OR jsonb_typeof(scope->'projectLabels') IS DISTINCT FROM 'array' OR jsonb_array_length(scope->'projectLabels')>256
  OR jsonb_typeof(scope->'otherLabels') NOT IN('array','null') OR jsonb_typeof(scope->'projectIds') NOT IN('array','null') THEN RETURN false; END IF;
 IF scope->>'contextDepartment' IS NOT NULL THEN PERFORM (scope->>'contextDepartment')::uuid; END IF;
 IF scope->'departments'<>'null' THEN
  IF (SELECT count(*) FROM jsonb_each(scope->'departments'))>256
   OR EXISTS(SELECT 1 FROM jsonb_each(scope->'departments') item WHERE jsonb_typeof(item.value)<>'number' OR (item.value#>>'{}')::int NOT BETWEEN 0 AND 3) THEN RETURN false; END IF;
  PERFORM key::uuid FROM jsonb_each(scope->'departments');
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(scope->'projectLabels') item WHERE jsonb_typeof(item)<>'string') THEN RETURN false; END IF;
 PERFORM (value#>>'{}')::uuid FROM jsonb_array_elements(scope->'projectLabels');
 IF scope->'projectIds'<>'null' THEN
  IF jsonb_array_length(scope->'projectIds')>256 OR EXISTS(SELECT 1 FROM jsonb_array_elements(scope->'projectIds') item WHERE jsonb_typeof(item)<>'string') THEN RETURN false; END IF;
  PERFORM (value#>>'{}')::uuid FROM jsonb_array_elements(scope->'projectIds');
 END IF;
 IF scope->'otherLabels'<>'null' AND (jsonb_array_length(scope->'otherLabels')>256
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(scope->'otherLabels') item
   WHERE jsonb_typeof(item)<>'string' OR item#>>'{}' LIKE 'team:%' OR item#>>'{}' LIKE 'project:%')) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_query_scope_valid(jsonb) FROM PUBLIC;

CREATE FUNCTION application_query_selector_valid_normalized(selector jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF selector IS NULL OR jsonb_typeof(selector) IS DISTINCT FROM 'object'
  OR NOT selector ?& ARRAY['ids','ownerId','relationships','empty'] OR selector-ARRAY['ids','ownerId','relationships','empty']<>'{}'::jsonb
  OR jsonb_typeof(selector->'ids') NOT IN('array','null') OR jsonb_typeof(selector->'ownerId') NOT IN('string','null')
  OR jsonb_typeof(selector->'relationships') IS DISTINCT FROM 'array' OR jsonb_array_length(selector->'relationships')>32
  OR jsonb_typeof(selector->'empty') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
 IF selector->>'ownerId' IS NOT NULL THEN PERFORM (selector->>'ownerId')::uuid; END IF;
 IF selector->'ids'<>'null' AND (jsonb_array_length(selector->'ids')>100
  OR jsonb_array_length(selector->'ids')=0 AND selector->>'empty'<>'true'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(selector->'ids') item WHERE jsonb_typeof(item)<>'string' OR length(item#>>'{}') NOT BETWEEN 1 AND 256)) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(selector->'relationships') relation
  WHERE jsonb_typeof(relation)<>'object' OR NOT relation ?& ARRAY['resolverKey','anchorId'] OR relation-ARRAY['resolverKey','anchorId']<>'{}'::jsonb
   OR jsonb_typeof(relation->'resolverKey') IS DISTINCT FROM 'string' OR relation->>'resolverKey' !~ '^relation\.[a-f0-9]{64}$'
   OR jsonb_typeof(relation->'anchorId') IS DISTINCT FROM 'string' OR length(relation->>'anchorId') NOT BETWEEN 1 AND 256) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_query_selector_valid_normalized(jsonb) FROM PUBLIC;

-- Find a permitted nonempty Department combination escaping every current
-- alternative. Positive witnesses exclude an allowed-set ceiling; negative
-- witnesses exclude a required context Department. No business row is sampled.
CREATE FUNCTION application_query_scope_escape(conditions jsonb[],p_position int,positive text[],negative text[],departments text[],budget int) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE choice jsonb; child jsonb; used int:=1; next_positive text[]; next_negative text[];
BEGIN
 IF budget IS NULL OR budget<1 OR p_position IS NULL OR p_position<1 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
 IF p_position>cardinality(conditions) THEN
  RETURN jsonb_build_object('escape',EXISTS(SELECT 1 FROM unnest(departments) department WHERE NOT department=ANY(negative)),'used',1);
 END IF;
 FOR choice IN SELECT value FROM jsonb_array_elements(conditions[p_position]) LOOP
  next_positive:=positive;next_negative:=negative;
  IF choice ? 'present' THEN
   IF choice->>'present'=ANY(negative) THEN CONTINUE; END IF;
   next_positive:=array_append(positive,choice->>'present');
  ELSE
   IF choice->>'absent'=ANY(positive) THEN CONTINUE; END IF;
   next_negative:=array_append(negative,choice->>'absent');
  END IF;
  child:=public.application_query_scope_escape(conditions,p_position+1,next_positive,next_negative,departments,budget-used);
  used:=used+(child->>'used')::int;
  IF child->>'escape'='true' THEN RETURN jsonb_build_object('escape',true,'used',used); END IF;
 END LOOP;
 RETURN jsonb_build_object('escape',false,'used',used);
END $$;
REVOKE ALL ON FUNCTION application_query_scope_escape(jsonb[],int,text[],text[],text[],int) FROM PUBLIC;

CREATE FUNCTION application_query_scope_union_contains(original jsonb,current_scopes jsonb,budget int) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE original_scope jsonb:=public.application_normalize_native_query_bounds(original); scope jsonb; normalized jsonb[]:='{}';
 tier int; departments text[]; required_departments text[]; options jsonb; conditions jsonb[]; used int:=1; escaped jsonb;
 original_context text; current_context text; department text; general_covered boolean; department_covered boolean;
BEGIN
 IF budget IS NULL OR budget<1 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
 IF public.application_query_scope_valid(original) IS NOT TRUE OR jsonb_typeof(current_scopes) IS DISTINCT FROM 'array'
  THEN RETURN jsonb_build_object('contains',false,'used',used); END IF;
 FOR scope IN SELECT value FROM jsonb_array_elements(current_scopes) LOOP
  used:=used+1;
  IF used>budget THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
  IF public.application_query_scope_valid(scope) IS NOT TRUE THEN RETURN jsonb_build_object('contains',false,'used',used); END IF;
  scope:=public.application_normalize_native_query_bounds(scope);
  -- These axes are independent upper sets. Coverage of the original maximum
  -- Project/other-label/Project-ID combination covers every subset as well.
  IF (scope->'projectLabels'='null' OR (original_scope->'projectLabels')<@(scope->'projectLabels'))
   AND (scope->'otherLabels'='null' OR original_scope->'otherLabels'<>'null' AND (original_scope->'otherLabels')<@(scope->'otherLabels'))
   AND (scope->'projectIds'='null' OR original_scope->'projectIds'<>'null' AND (original_scope->'projectIds')<@(scope->'projectIds')) THEN
   normalized:=array_append(normalized,scope);
  END IF;
 END LOOP;
 original_context:=original_scope->>'contextDepartment';
 FOR tier IN 1..3 LOOP
  general_covered:=(original_scope->>'tier')::int<tier;
  conditions:='{}';department_covered:=false;required_departments:='{}';
  IF original_scope->'departments'='null' THEN
   IF tier>(original_scope->>'tier')::int THEN departments:='{}';
   ELSE
    -- A fresh Department outside every finite current map witnesses the
    -- legacy universe. Only a current universe can cover that combination.
    departments:=ARRAY['d:*'];required_departments:=departments;
    IF original_context IS NOT NULL THEN departments:=array_append(departments,'d:='||original_context);required_departments:=departments; END IF;
   END IF;
  ELSE
   SELECT coalesce(array_agg('d:='||key ORDER BY key),'{}') INTO departments FROM jsonb_each(original_scope->'departments') WHERE (value#>>'{}')::int>=tier;
   IF original_context IS NOT NULL THEN
    IF NOT ('d:='||original_context=ANY(departments)) THEN departments:='{}';
    ELSE required_departments:=ARRAY['d:='||original_context]; END IF;
   END IF;
  END IF;
  FOREACH scope IN ARRAY normalized LOOP
   used:=used+1;
   IF used>budget THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
   IF tier<=(scope->>'tier')::int THEN general_covered:=true; END IF;
   IF cardinality(departments)=0 OR department_covered THEN CONTINUE; END IF;
   current_context:=scope->>'contextDepartment';
   IF current_context IS NOT NULL AND NOT ('d:='||current_context=ANY(departments))
    OR scope->'departments'='null' AND tier>(scope->>'tier')::int THEN CONTINUE; END IF;
   options:='[]';
   FOREACH department IN ARRAY departments LOOP
    IF scope->'departments'<>'null' AND (department='d:*' OR coalesce((scope#>>ARRAY['departments',substr(department,4)])::int,0)<tier) THEN
     options:=options||jsonb_build_array(jsonb_build_object('present',department));
    END IF;
   END LOOP;
   IF current_context IS NOT NULL AND NOT ('d:='||current_context=ANY(required_departments)) THEN
    options:=options||jsonb_build_array(jsonb_build_object('absent','d:='||current_context));
   END IF;
   IF jsonb_array_length(options)=0 THEN department_covered:=true;
   ELSE conditions:=array_append(conditions,options); END IF;
  END LOOP;
  IF NOT general_covered THEN RETURN jsonb_build_object('contains',false,'used',used); END IF;
  IF cardinality(departments)>0 AND NOT department_covered THEN
   escaped:=public.application_query_scope_escape(conditions,1,required_departments,'{}',departments,budget-used);
   used:=used+(escaped->>'used')::int;
   IF escaped->>'escape'='true' THEN RETURN jsonb_build_object('contains',false,'used',used); END IF;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('contains',true,'used',used);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN jsonb_build_object('contains',false,'used',used);
END $$;
REVOKE ALL ON FUNCTION application_query_scope_union_contains(jsonb,jsonb,int) FROM PUBLIC;

CREATE FUNCTION application_query_selector_covers(current_selector jsonb,original jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(original->>'empty'='true' OR current_selector->>'empty'='false'
  AND (current_selector->'ids'='null' OR original->'ids'<>'null' AND (original->'ids')<@(current_selector->'ids'))
  AND (current_selector->>'ownerId' IS NULL OR current_selector->>'ownerId'=original->>'ownerId')
  AND (current_selector->'relationships')<@(original->'relationships'),false)
$$;
REVOKE ALL ON FUNCTION application_query_selector_covers(jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION application_query_domain_contains(current_domain jsonb,original jsonb,required_fields text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE original_clause jsonb; original_selector jsonb; current_clause jsonb; point jsonb; points jsonb[]; fields text[]; field text;
 scopes jsonb; checked jsonb; used int:=0;
BEGIN
 IF current_domain->>'kind' IS DISTINCT FROM 'application_query' OR original->>'kind' IS DISTINCT FROM 'application_query'
  OR current_domain->'version' IS DISTINCT FROM '1'::jsonb OR original->'version' IS DISTINCT FROM '1'::jsonb
  OR current_domain-ARRAY['kind','version','clauses']<>'{}'::jsonb OR original-ARRAY['kind','version','clauses']<>'{}'::jsonb
  OR jsonb_typeof(current_domain->'clauses') IS DISTINCT FROM 'array' OR jsonb_typeof(original->'clauses') IS DISTINCT FROM 'array'
  OR jsonb_array_length(current_domain->'clauses')>4096 OR jsonb_array_length(original->'clauses')>4096
  OR required_fields IS NULL OR cardinality(required_fields)>128 OR array_position(required_fields,NULL) IS NOT NULL THEN RETURN false; END IF;
 FOR current_clause IN SELECT value FROM jsonb_array_elements((current_domain->'clauses')||(original->'clauses')) LOOP
  IF jsonb_typeof(current_clause) IS DISTINCT FROM 'object' OR NOT current_clause ?& ARRAY['scope','selector','read']
   OR current_clause-ARRAY['scope','selector','read']<>'{}'::jsonb
   OR public.application_query_scope_valid(current_clause->'scope') IS NOT TRUE
   OR public.application_query_selector_valid_normalized(current_clause->'selector') IS NOT TRUE
   OR jsonb_typeof(current_clause->'read') IS DISTINCT FROM 'array' OR jsonb_array_length(current_clause->'read')>128
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(current_clause->'read') item WHERE jsonb_typeof(item)<>'string') THEN RETURN false; END IF;
 END LOOP;
 fields:=ARRAY[NULL::text]||required_fields;
 FOR original_clause IN SELECT value FROM jsonb_array_elements(original->'clauses') LOOP
  original_selector:=original_clause->'selector';
  IF original_selector->>'empty'='true' THEN CONTINUE; END IF;
  IF original_selector->'ids'='null' THEN points:=ARRAY[original_selector];
  ELSE
   SELECT coalesce(array_agg(jsonb_set(original_selector,'{ids}',jsonb_build_array(value))),'{}') INTO points
    FROM jsonb_array_elements(original_selector->'ids');
  END IF;
  FOREACH point IN ARRAY points LOOP
   FOREACH field IN ARRAY fields LOOP
    scopes:='[]';
    FOR current_clause IN SELECT value FROM jsonb_array_elements(current_domain->'clauses') LOOP
     used:=used+1;
     IF used>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
     IF (field IS NULL OR (current_clause->'read') ? field) AND public.application_query_selector_covers(current_clause->'selector',point) THEN
      scopes:=scopes||jsonb_build_array(current_clause->'scope');
     END IF;
    END LOOP;
    checked:=public.application_query_scope_union_contains(original_clause->'scope',scopes,4096-used);
    used:=used+(checked->>'used')::int;
    IF checked->>'contains' IS DISTINCT FROM 'true' THEN RETURN false; END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_query_domain_contains(jsonb,jsonb,text[]) FROM PUBLIC;

CREATE FUNCTION read_application_query_catalog(w uuid,p_origin jsonb,p_type text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admitted jsonb; fields jsonb;
BEGIN
 admitted:=public.application_current_query_catalog(w,p_origin,p_type);
 IF admitted IS NULL THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',p->>'name','label',p->>'name','kind','cell','property',p)||CASE WHEN p#>>'{config,kind}'='relation'
   THEN jsonb_build_object('relationshipResolverKey','relation.'||encode(sha256(convert_to(p->>'name','UTF8')),'hex')) ELSE '{}'::jsonb END ORDER BY position),'[]') INTO fields
  FROM public.entity_types t,LATERAL jsonb_array_elements(t.properties) WITH ORDINALITY property(p,position)
  WHERE t.workspace_id=w AND t.id=(p_origin->>'entityTypeId')::uuid AND (admitted->'read') ? (p->>'name');
 RETURN jsonb_build_object('typeKey',p_type,'origin',p_origin,'schemaVersion',admitted#>>'{policy,metadata,schemaVersion}','fields',fields);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION read_application_query_catalog(uuid,jsonb,text) FROM PUBLIC;

ALTER FUNCTION application_generic_catalog(text) RENAME TO application_generic_catalog_before_query_domains;
REVOKE ALL ON FUNCTION application_generic_catalog_before_query_domains(text) FROM PUBLIC;
CREATE FUNCTION application_generic_catalog(p_type_key text DEFAULT NULL) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb; resource jsonb; candidate record; dictionary jsonb:='{}'; identity_key text; existing jsonb; merged jsonb;
BEGIN
 context:=public.application_current_maxima();
 IF context IS NULL OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entity_types'::regclass
  WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN; END IF;
 -- Existing get/history/create/schema metadata retains its typed admission.
 FOR resource IN SELECT * FROM public.application_generic_catalog_before_query_domains(p_type_key) LOOP
  identity_key:=public.application_field_digest(jsonb_build_object('origin',resource->'origin','typeKey',resource->'typeKey'));
  dictionary:=jsonb_set(dictionary,ARRAY[identity_key],resource);
 END LOOP;
 FOR candidate IN SELECT DISTINCT maximum->'grants'->0->'origin' AS origin,maximum->'grants'->0->>'typeKey' AS type_key
  FROM jsonb_array_elements(context->'layers') layer,LATERAL jsonb_array_elements(layer->'maxima') maximum
  WHERE maximum->'grants'->0->'origin'->>'kind'='generic'
   AND (p_type_key IS NULL OR maximum->'grants'->0->>'typeKey'=p_type_key) LOOP
  resource:=public.read_application_query_catalog((context->>'workspaceId')::uuid,candidate.origin,candidate.type_key);
  IF resource IS NULL THEN CONTINUE; END IF;
  identity_key:=public.application_field_digest(jsonb_build_object('origin',resource->'origin','typeKey',resource->'typeKey'));
  existing:=dictionary->identity_key;
  IF existing IS NOT NULL THEN
   SELECT coalesce(jsonb_agg(field ORDER BY field->>'key'),'[]') INTO merged FROM (
    SELECT DISTINCT ON(value->>'key') value AS field FROM jsonb_array_elements((existing->'fields')||(resource->'fields'))
    ORDER BY value->>'key') declared;
   resource:=jsonb_set(resource,'{fields}',merged);
  END IF;
  dictionary:=jsonb_set(dictionary,ARRAY[identity_key],resource);
 END LOOP;
 RETURN QUERY SELECT value FROM jsonb_each(dictionary) ORDER BY value->>'typeKey',key;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN;
END $$;
REVOKE ALL ON FUNCTION application_generic_catalog(text) FROM PUBLIC;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION application_generic_query_catalog_policy(uuid,jsonb,text),application_query_catalog_selector_valid(uuid,jsonb,jsonb),
   application_query_catalog_path(jsonb,jsonb,jsonb,uuid,jsonb,text,jsonb),application_current_query_catalog(uuid,jsonb,text),
   application_generic_catalog_before_query_domains(text),application_query_set_intersection(jsonb,jsonb),application_query_scope_intersection(jsonb,jsonb),
   application_query_scope_cap(int,jsonb,jsonb),application_principal_query_bounds(uuid,uuid,boolean),application_native_query_bounds(uuid),
   application_query_selector_meet(jsonb,jsonb),application_query_selector_normalize(jsonb),application_compile_query_catalog_domain(uuid,jsonb),
   application_query_scope_escape(jsonb[],int,text[],text[],text[],int),application_query_scope_union_contains(jsonb,jsonb,int),
   application_query_selector_covers(jsonb,jsonb),application_query_domain_contains(jsonb,jsonb,text[]),
   application_query_scope_valid(jsonb),application_query_selector_valid_normalized(jsonb) FROM app_user;
  GRANT EXECUTE ON FUNCTION read_application_query_catalog(uuid,jsonb,text),application_generic_catalog(text) TO app_user;
 END IF;
END $$;
COMMIT;
