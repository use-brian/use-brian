BEGIN;
-- [COMP:api/application-records] Every generic relationship predicate retains
-- its canonical relation-field read obligation in its own current/issued path.
DO $relationship_prerequisites$
DECLARE item jsonb;actual pg_proc;canonical_owner oid;actual_acl jsonb;expected_acl jsonb;
BEGIN
 SELECT relowner INTO canonical_owner FROM pg_class WHERE oid='public.application_access_grants'::regclass;
 FOR item IN SELECT value FROM jsonb_array_elements($expected$[{"signature":"public.application_scoped_grant_allowed_before_modules(uuid,jsonb)","body":"d195199a168c7a6de27c534eef2930beb17d2ce34d67671aa87165ac729c0f70","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_scoped_grant_allowed_before_modules","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["a","p"],"proargtypes":["2950","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.application_path_fields(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb)","body":"0868a145b275e18e51419d92650e0238308a6fc4f740ed395a86bc3fbad6ffb1","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_path_fields","prorows":0,"pronargs":13,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["maximum","subject","w","origin","type_key","record_id","owner_id","tier","teams","projects","row_user","action","prospective_data"],"proargtypes":["3802","3802","2950","3802","25","25","2950","25","1009","2951","2950","25","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":"({CONST :consttype 3802 :consttypmod -1 :constcollid 0 :constlen -1 :constbyval false :constisnull true :location -1 :constvalue <>})","pronargdefaults":1}},{"signature":"public.application_query_catalog_path(jsonb,jsonb,jsonb,uuid,jsonb,text,jsonb)","body":"ab1f905f503a6c0ce11f3d5a1f63a5a9e4377b8a8ed598aa52960758d416da1c","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_query_catalog_path","prorows":0,"pronargs":7,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["context","maximum","subject","w","p_origin","p_type","policy"],"proargtypes":["3802","3802","3802","2950","3802","25","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}}]$expected$::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(item->>'signature');
  IF NOT FOUND OR encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM item->>'body'
   OR actual.proowner IS DISTINCT FROM canonical_owner OR actual.pronamespace IS DISTINCT FROM 'public'::regnamespace
   OR actual.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace']) IS DISTINCT FROM item->'metadata' THEN
   RAISE EXCEPTION 'Generic relationship function prerequisite changed: %',item->>'signature';END IF;
  SELECT jsonb_agg(jsonb_build_array(a.grantee,a.grantor,a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable)
   INTO actual_acl FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a;
  expected_acl:=jsonb_build_array(jsonb_build_array(canonical_owner,canonical_owner,'EXECUTE',false));
  IF actual_acl IS DISTINCT FROM expected_acl THEN RAISE EXCEPTION 'Generic relationship ACL prerequisite changed: %',item->>'signature';END IF;
 END LOOP;
 IF application_memory_statement_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Generic relationship Memory guard prerequisite changed';END IF;
END $relationship_prerequisites$;
DO $relationship_body$
DECLARE port regprocedure:='public.application_scoped_grant_allowed_before_modules(uuid,jsonb)'::regprocedure;actual pg_proc;metadata jsonb;definition text;before text;after text;guard_before jsonb;
BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=port;metadata:=to_jsonb(actual)-'prosrc';definition:=pg_get_functiondef(port);before:=actual.prosrc;
 SELECT to_jsonb(p) INTO guard_before FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 after:=$replacement$
DECLARE app application_clients;schema_row entity_types;fields text[];writable text[];relation_count bigint;relation_field text;
BEGIN
 SELECT * INTO app FROM application_clients WHERE id=a;
 IF app.module_key IS DISTINCT FROM 'records' THEN RETURN application_scoped_grant_allowed_before_records(a,p);END IF;
 IF application_scoped_qualified(app.workspace_id,a) IS NOT TRUE
 OR p->'principal'->>'kind' IS DISTINCT FROM 'service' OR p->'origin'->>'kind' IS DISTINCT FROM 'generic'
 OR p->'selector'->>'kind' NOT IN('self','ids','relationship') THEN RETURN false;END IF;
 SELECT * INTO schema_row FROM entity_types WHERE id=(p->'origin'->>'entityTypeId')::uuid AND workspace_id=app.workspace_id;
 IF schema_row.id IS NULL OR p->'origin' IS DISTINCT FROM jsonb_build_object('kind','generic','entityTypeId',schema_row.id)
 OR p->>'typeKey' IS DISTINCT FROM 'record.'||schema_row.id::text THEN RETURN false;END IF;
 IF p#>>'{selector,kind}'='relationship' THEN
  IF public.application_query_catalog_selector_valid(app.workspace_id,p->'origin',p->'selector') IS NOT TRUE THEN RETURN false;END IF;
   SELECT count(*),min(property->>'name') INTO relation_count,relation_field
    FROM public.entity_types declared CROSS JOIN LATERAL jsonb_array_elements(declared.properties) property
    WHERE declared.workspace_id=app.workspace_id AND declared.id=((p->'origin')->>'entityTypeId')::uuid
     AND property#>>'{config,kind}'='relation'
     AND 'relation.'||encode(sha256(convert_to(property->>'name','UTF8')),'hex')=(p->'selector')->>'resolverKey';
  IF relation_count<>1 OR relation_field IS NULL OR length(btrim(relation_field))=0
   OR coalesce(p->'readFields' ? relation_field,false) IS NOT TRUE THEN RETURN false;END IF;
 END IF;
 fields:=ARRAY(SELECT property->>'name' FROM jsonb_array_elements(schema_row.properties) property);
 writable:=ARRAY(SELECT property->>'name' FROM jsonb_array_elements(schema_row.properties) property
 WHERE property->'config'->>'kind' NOT IN('created_time','created_by','last_edited_time','last_edited_by'));
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'actions') action
 WHERE action NOT IN('read','query','history','schema','create','patch','delete','command:record_create','command:record_patch','command:record_delete','command:record_batch'))
 AND p->'readFields'<@to_jsonb(fields) AND p->'writeFields'<@to_jsonb(writable);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $replacement$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Generic relationship body splice prerequisite changed';END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=port) IS DISTINCT FROM '72f08cfdd818faddddbe6aafa341a968a3447c2f1d347b6b7d3e915b22f8baa2'
  OR (SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM guard_before
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Generic relationship body or security metadata changed';END IF;
END $relationship_body$;
DO $relationship_body$
DECLARE port regprocedure:='public.application_path_fields(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb)'::regprocedure;actual pg_proc;metadata jsonb;definition text;before text;after text;guard_before jsonb;
BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=port;metadata:=to_jsonb(actual)-'prosrc';definition:=pg_get_functiondef(port);before:=actual.prosrc;
 SELECT to_jsonb(p) INTO guard_before FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 after:=$replacement$
DECLARE decision jsonb; policy jsonb; issued jsonb; current_grant public.application_access_grants; issuer_mask jsonb; principal_mask jsonb; member_mask jsonb; native_member boolean; deleted_keys text[];required_relation_fields text[]:='{}';relation_selector jsonb;relation_count bigint;relation_field text;
BEGIN
 decision:=public.application_path_fields_before_module_policy(maximum,subject,w,origin,type_key,record_id,owner_id,tier,teams,projects,row_user,action,prospective_data);
 IF decision IS NULL THEN RETURN NULL; END IF;
 FOR issued IN SELECT value FROM jsonb_array_elements(maximum->'grants') LOOP
  SELECT * INTO current_grant FROM public.application_access_grants g WHERE g.id=(issued->>'id')::uuid
   AND g.workspace_id=w AND g.app_id=(public.application_current_maxima()->>'appId')::uuid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF origin->>'kind'='generic' THEN
   FOR relation_selector IN SELECT value FROM jsonb_array_elements(jsonb_build_array(current_grant.selector,issued->'selector')) LOOP
    IF relation_selector->>'kind'='relationship' THEN
   SELECT count(*),min(property->>'name') INTO relation_count,relation_field
    FROM public.entity_types declared CROSS JOIN LATERAL jsonb_array_elements(declared.properties) property
    WHERE declared.workspace_id=w AND declared.id=(origin->>'entityTypeId')::uuid
     AND property#>>'{config,kind}'='relation'
     AND 'relation.'||encode(sha256(convert_to(property->>'name','UTF8')),'hex')=relation_selector->>'resolverKey';
     IF relation_count<>1 OR relation_field IS NULL OR length(btrim(relation_field))=0 THEN RETURN NULL;END IF;
     required_relation_fields:=ARRAY(SELECT DISTINCT unnest(required_relation_fields||ARRAY[relation_field]));
    END IF;
   END LOOP;
  END IF;
  IF current_grant.principal_kind<>'member' AND EXISTS(SELECT 1 FROM public.workspace_members m
   WHERE m.workspace_id=w AND m.user_id=current_grant.principal_user_id) THEN
   IF public.application_release_scope_allows(current_grant.principal_user_id,w,tier,teams,projects,row_user) IS NOT TRUE
    OR action NOT IN('read','query','history','schema') AND public.member_operation_row_allows(
     public.member_principal_operation_grants(current_grant.principal_user_id,true,w),w,tier,teams) IS NOT TRUE THEN RETURN NULL; END IF;
  END IF;
 END LOOP;
 -- Before insertion, the deployed catalog is the policy. A synthetic row
 -- cannot stand in for a current canonical record/field observation.
 IF prospective_data IS NOT NULL AND (action='create' OR starts_with(action,'command:')) THEN
  policy:=public.application_native_field_catalog_for(w,origin,type_key);
 ELSE
  policy:=public.application_native_field_contract_for(w,origin,type_key,
  CASE WHEN origin='{"kind":"native","moduleKey":"native"}'::jsonb AND type_key='task'
   THEN coalesce(application_task_live_id(w,record_id::uuid)::text,record_id) ELSE record_id END);
 END IF;
 IF policy->>'registered'='false' THEN
  IF cardinality(required_relation_fields)>0 AND coalesce(to_jsonb(required_relation_fields)<@(decision->'read'),false) IS NOT TRUE THEN RETURN NULL;END IF;
  RETURN decision;
 END IF;
 IF policy->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL; END IF;
 IF action='delete' THEN
  IF origin->>'kind'='generic' THEN
   SELECT ARRAY(SELECT jsonb_object_keys(r.data)) INTO deleted_keys FROM public.entity_instances r WHERE r.workspace_id=w
    AND r.entity_type_id=(origin->>'entityTypeId')::uuid AND r.id=record_id::uuid;
   IF NOT FOUND THEN SELECT t.deleted_fields INTO deleted_keys FROM public.application_record_tombstones t WHERE t.workspace_id=w
    AND t.entity_type_id=(origin->>'entityTypeId')::uuid AND t.id=record_id::uuid; END IF;
  ELSE deleted_keys:=ARRAY(SELECT jsonb_array_elements_text(policy#>'{metadata,fieldKeys}'));
  END IF;
  IF deleted_keys IS NULL THEN RETURN NULL; END IF;
 END IF;
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
  -- A row-delete grant cannot replace a protected module's complete current
  -- issuer/member/release floor. Field subsets still govern individual patches.
  IF action='delete' AND NOT coalesce(to_jsonb(deleted_keys)<@(issuer_mask->'write')
   AND to_jsonb(deleted_keys)<@(principal_mask->'write'),false) THEN RETURN NULL; END IF;
  decision:=jsonb_build_object('read',ARRAY(SELECT jsonb_array_elements_text(decision->'read')
    INTERSECT SELECT jsonb_array_elements_text(issuer_mask->'read') INTERSECT SELECT jsonb_array_elements_text(principal_mask->'read')),
   'write',ARRAY(SELECT jsonb_array_elements_text(decision->'write')
    INTERSECT SELECT jsonb_array_elements_text(issuer_mask->'write') INTERSECT SELECT jsonb_array_elements_text(principal_mask->'write')));
 END LOOP;
 IF cardinality(required_relation_fields)>0 AND coalesce(to_jsonb(required_relation_fields)<@(decision->'read'),false) IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN decision;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR datetime_field_overflow THEN RETURN NULL;
END $replacement$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Generic relationship body splice prerequisite changed';END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=port) IS DISTINCT FROM 'c2f13210a38827f48b8615419b511d842cc701be24c3c6ae222f5a0d117eabcf'
  OR (SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM guard_before
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Generic relationship body or security metadata changed';END IF;
END $relationship_body$;
DO $relationship_body$
DECLARE port regprocedure:='public.application_query_catalog_path(jsonb,jsonb,jsonb,uuid,jsonb,text,jsonb)'::regprocedure;actual pg_proc;metadata jsonb;definition text;before text;after text;guard_before jsonb;
BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=port;metadata:=to_jsonb(actual)-'prosrc';definition:=pg_get_functiondef(port);before:=actual.prosrc;
 SELECT to_jsonb(p) INTO guard_before FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 after:=$replacement$
DECLARE issued jsonb; current_grant public.application_access_grants; permissions jsonb; scope jsonb:=policy#>'{metadata,scope}';
 read_keys text[]; issuer_mask jsonb; principal_mask jsonb; member_mask jsonb; native_member boolean; seen uuid[]:='{}'; next_id uuid; count_value int:=0;
 selectors jsonb:='[]'; limits jsonb:='[]'; issuers jsonb:='[]'; members jsonb:='[]';relation_selector jsonb;relation_count bigint;relation_field text;
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
 IF p_origin->>'kind'='generic' THEN
  FOR relation_selector IN SELECT value FROM jsonb_array_elements(selectors) LOOP
   IF relation_selector->>'kind'='relationship' THEN
   SELECT count(*),min(property->>'name') INTO relation_count,relation_field
    FROM public.entity_types declared CROSS JOIN LATERAL jsonb_array_elements(declared.properties) property
    WHERE declared.workspace_id=w AND declared.id=(p_origin->>'entityTypeId')::uuid
     AND property#>>'{config,kind}'='relation'
     AND 'relation.'||encode(sha256(convert_to(property->>'name','UTF8')),'hex')=relation_selector->>'resolverKey';
    IF relation_count<>1 OR relation_field IS NULL OR length(btrim(relation_field))=0
     OR coalesce(relation_field=ANY(read_keys),false) IS NOT TRUE THEN RETURN NULL;END IF;
   END IF;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('read',ARRAY(SELECT DISTINCT unnest(read_keys) ORDER BY 1),'selectors',selectors,'limits',limits,'issuers',issuers,'members',members);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $replacement$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Generic relationship body splice prerequisite changed';END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=port) IS DISTINCT FROM 'b892fbcf62d6527a40babb08c32cba5b1da8b0801621e4408ae2120bdfb68459'
  OR (SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM guard_before
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Generic relationship body or security metadata changed';END IF;
END $relationship_body$;
COMMIT;
