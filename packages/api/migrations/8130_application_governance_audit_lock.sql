BEGIN;
-- [COMP:api/application-management] Preserve governance serialization while
-- allowing lifecycle audit foreign-key references to finish before module SHARE.
DO $governance_lock$
DECLARE port regprocedure:=to_regprocedure('public.application_apply_native_governance_review(uuid,uuid,uuid)');
 actual pg_proc;canonical_owner oid;metadata jsonb;definition text;before text;after text;actual_acl jsonb;expected_acl jsonb;guard_before jsonb;
BEGIN
 SELECT relowner INTO canonical_owner FROM pg_class WHERE oid='public.application_native_governance_reviews'::regclass;
 SELECT * INTO actual FROM pg_proc WHERE oid=port;
 IF NOT FOUND OR encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM '1b331e090b861afd98aba4f8c351d1c6830cf82affdd3a34f076d4cdcc2ce873'
  OR actual.proowner IS DISTINCT FROM canonical_owner OR actual.pronamespace IS DISTINCT FROM 'public'::regnamespace
  OR actual.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace']) IS DISTINCT FROM $properties${"probin":null,"procost":100,"prokind":"f","proname":"application_apply_native_governance_review","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","acting","review_id"],"proargtypes":["2950","2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$properties$::jsonb THEN
  RAISE EXCEPTION 'Native governance lock function prerequisite changed';END IF;
 SELECT jsonb_agg(jsonb_build_array(a.grantee,a.grantor,a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable)
  INTO actual_acl FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a;
 SELECT jsonb_agg(jsonb_build_array(g,canonical_owner,'EXECUTE',false) ORDER BY g) INTO expected_acl
  FROM (SELECT canonical_owner AS g UNION SELECT oid FROM pg_roles WHERE rolname='app_user') grants;
 IF actual_acl IS DISTINCT FROM expected_acl THEN RAISE EXCEPTION 'Native governance lock ACL prerequisite changed';END IF;
 IF application_memory_statement_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Native governance lock Memory guard prerequisite changed';END IF;
 metadata:=to_jsonb(actual)-'prosrc';definition:=pg_get_functiondef(port);before:=actual.prosrc;
 SELECT to_jsonb(p) INTO guard_before FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 after:=$replacement$
DECLARE review public.application_native_governance_reviews; revision text; resource_id uuid; target_version text; operation_outcome jsonb; configuration_revision text; crm_outcome jsonb;
BEGIN
 -- Serialize first-role reviews before reading current revision or role history.
 PERFORM 1 FROM public.workspaces WHERE id=w FOR NO KEY UPDATE;
 SELECT * INTO review FROM public.application_native_governance_reviews r WHERE r.id=review_id AND r.workspace_id=w
  AND r.actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND r.assistant_id=acting FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('application-native-governance:'||w::text||':'||review.module_key,0));
 -- Workspace NO KEY UPDATE precedes module SHARE and permits audit FK references.
 IF review.module_key NOT IN('native','records') AND review.proposal->>'kind'='assign_role'
  AND EXISTS(SELECT 1 FROM public.users u JOIN public.application_clients c ON u.auth_provider='channel'
   AND u.auth_provider_id LIKE 'app-service:'||c.id::text||':%' AND c.workspace_id=w AND c.module_key=review.module_key AND c.status='active'
   WHERE u.id=(review.proposal->>'userId')::uuid) THEN
  PERFORM 1 FROM public.workspace_modules WHERE workspace_id=w AND module_key=review.module_key FOR SHARE;
 END IF;
 revision:=public.application_native_governance_revision(w,acting,review.module_key);
 IF revision IS DISTINCT FROM coalesce(review.applied_revision,review.reviewed_revision) THEN
  RAISE EXCEPTION 'record_version_conflict: reviewed authority changed' USING ERRCODE='40001'; END IF;
 IF review.outcome IS NOT NULL THEN RETURN review.outcome; END IF;
 IF review.expires_at<=clock_timestamp() OR public.application_native_governance_proposal_allows(w,review.module_key,review.proposal) IS NOT TRUE THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 CASE review.proposal->>'kind'
 WHEN 'assign_role' THEN
  INSERT INTO public.application_native_role_assignments(workspace_id,module_key,user_id,role_key,starts_at,expires_at,issued_by_user_id)
   VALUES(w,review.module_key,(review.proposal->>'userId')::uuid,review.proposal->>'roleKey',(review.proposal->>'startsAt')::timestamptz,
    (review.proposal->>'expiresAt')::timestamptz,review.actor_user_id) RETURNING id,version::text INTO resource_id,target_version;
 WHEN 'revoke_role' THEN
  UPDATE public.application_native_role_assignments a SET status='revoked' WHERE a.workspace_id=w AND a.module_key=review.module_key
   AND a.id=(review.proposal->>'assignmentId')::uuid AND a.version::text=review.proposal->>'expectedVersion' AND a.status='active'
   RETURNING id,version::text INTO resource_id,target_version;
  IF resource_id IS NULL THEN RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001'; END IF;
 WHEN 'bind_owner' THEN
  resource_id:=(review.proposal->>'entityTypeId')::uuid;
  INSERT INTO public.application_native_resource_owners(workspace_id,origin,resource_type,module_key)
   VALUES(w,jsonb_build_object('kind','generic','entityTypeId',resource_id),'record.'||resource_id,review.module_key);
  target_version:='1';
 WHEN 'bind_native_owner' THEN
  resource_id:=w;target_version:='1';
  INSERT INTO public.application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES(w,'{"kind":"native","moduleKey":"native"}'::jsonb,review.proposal->>'typeKey',review.module_key);
 WHEN 'configure_crm' THEN
  crm_outcome:=public.application_run_native_crm_configuration(w,review.proposal->'command');resource_id:=(crm_outcome->>'resourceId')::uuid;
  SELECT e.revision::text INTO target_version FROM public.application_policy_workspace_epochs e WHERE e.workspace_id=w;
 WHEN 'configure' THEN
  resource_id:=w;configuration_revision:=public.application_run_native_configuration(w,review.module_key,review.proposal->>'operationKey',review.proposal->'input');target_version:='1';
 ELSE RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023';
 END CASE;
 -- A self-revocation returns only the explicit operation's content-free
 -- outcome. Lost field governance is never reused for a subsequent read/replay.
 IF review.proposal->>'kind'='revoke_role' AND EXISTS(SELECT 1 FROM public.application_native_role_assignments a
  WHERE a.id=resource_id AND a.user_id=review.actor_user_id) THEN
  revision:=public.application_field_digest(public.read_application_policy_epoch(w,review.actor_user_id,acting));
  IF revision IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 ELSE
  revision:=public.application_native_governance_revision(w,acting,review.module_key);
 END IF;
 operation_outcome:=jsonb_build_object('id',review.id,'moduleKey',review.module_key,'kind',review.proposal->>'kind','resourceId',resource_id,'version',target_version,'applied',true);
 IF review.proposal->>'kind'='bind_native_owner' THEN operation_outcome:=operation_outcome||jsonb_build_object('typeKey',review.proposal->>'typeKey');END IF;
 IF crm_outcome IS NOT NULL THEN operation_outcome:=operation_outcome||jsonb_build_object('subjectKind',crm_outcome->>'subjectKind','created',(crm_outcome->>'created')::boolean,'changed',(crm_outcome->>'changed')::boolean);END IF;
 IF configuration_revision IS NOT NULL THEN operation_outcome:=operation_outcome||jsonb_build_object('configurationRevision',configuration_revision);END IF;
 UPDATE public.application_native_governance_reviews r SET applied_revision=revision,outcome=operation_outcome WHERE r.id=review.id;
 INSERT INTO public.application_native_governance_events(review_id,workspace_id,module_key,actor_user_id,operation_kind,resource_id)
  VALUES(review.id,w,review.module_key,review.actor_user_id,review.proposal->>'kind',resource_id);
 RETURN operation_outcome;
END $replacement$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Native governance lock body splice prerequisite changed';END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=port) IS DISTINCT FROM 'dfd87d0a8486861ffb5e3fdb69b8e5e1d41a82d71eebcb50e616f0b2d1afca08'
  OR (SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM guard_before
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native governance lock body or security metadata changed';END IF;
END $governance_lock$;
COMMIT;
