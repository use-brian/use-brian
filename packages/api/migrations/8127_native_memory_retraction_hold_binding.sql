BEGIN;
-- [COMP:corrections/retraction-store] Prospective exact own-target hold binding.
-- No history admission, old receipt backfill, new port or helper fingerprint change.
DO $hold_binding$
DECLARE port regprocedure:='public.retract_admitted_native_memory(uuid,uuid,text,uuid,uuid,text,text,timestamptz,jsonb)'::regprocedure;
 legacy regprocedure:='public.retract_admitted_native_memory(uuid,uuid,text,uuid,uuid,text,text,timestamptz)'::regprocedure;
 actual pg_proc;metadata jsonb;definition text;canonical_owner oid;expected_acl jsonb;actual_acl jsonb;before text;after text;
BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=port;
 SELECT relowner INTO canonical_owner FROM pg_class WHERE oid='public.memories'::regclass;
 IF encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM '99a1834901b1ba524b1c93b61d698b20e812119b74a7b80af488bc5558605cb0'
  OR actual.proowner IS DISTINCT FROM canonical_owner
  OR actual.proowner IS DISTINCT FROM (SELECT proowner FROM pg_proc WHERE oid=legacy)
  OR actual.pronamespace IS DISTINCT FROM 'public'::regnamespace
  OR actual.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace'])
    IS DISTINCT FROM $metadata${"probin":null,"procost":100,"prokind":"f","proname":"retract_admitted_native_memory","prorows":0,"pronargs":9,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"2950","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i","v","acting","session","context_hash","reason","at_time","reason_inputs"],"proargtypes":["2950","2950","25","2950","2950","25","25","1184","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$metadata$::jsonb THEN
  RAISE EXCEPTION 'Memory hold binding function prerequisite changed';END IF;
 SELECT jsonb_agg(jsonb_build_array(a.grantee,a.grantor,a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable)
  INTO actual_acl FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a;
 SELECT jsonb_agg(jsonb_build_array(g,canonical_owner,'EXECUTE',false) ORDER BY g)
  INTO expected_acl FROM (SELECT canonical_owner AS g UNION SELECT oid FROM pg_roles WHERE rolname='app_user') grants;
 IF actual_acl IS DISTINCT FROM expected_acl THEN RAISE EXCEPTION 'Memory hold binding ACL prerequisite changed';END IF;
 IF EXISTS(SELECT 1 FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=legacy),acldefault('f',canonical_owner))) a
   WHERE a.grantee<>canonical_owner OR a.grantor<>canonical_owner OR a.privilege_type<>'EXECUTE' OR a.is_grantable) THEN
  RAISE EXCEPTION 'Memory hold binding private predecessor changed';END IF;
 metadata:=to_jsonb(actual)-'prosrc';definition:=pg_get_functiondef(port);
 before:=$before$ context jsonb;source jsonb;policy jsonb;mask jsonb;roots jsonb;receipt uuid;reason_source jsonb;current_source jsonb;expanded jsonb;$before$;
 after:=$after$ context jsonb;source jsonb;policy jsonb;mask jsonb;roots jsonb;receipt uuid;reason_source jsonb;current_source jsonb;expanded jsonb;
 prior_policy_revision bigint;result_policy_revision bigint;result_held boolean;result_state scope_resource_states;result_hold_state jsonb;$after$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory hold binding splice prerequisite changed';END IF;
 definition:=replace(definition,before,after);
 before:=$before$ -- Keep the ordinary semantic version advance and descendant invalidation.$before$;
 after:=$after$ -- Existing admission above proves the factual prestate is current/unheld.
 -- Pin its actual policy revision before the canonical update invokes holders.
 IF old.scope_held OR scope_review_state_held('memory',i) THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 SELECT revision INTO prior_policy_revision FROM workspace_access_policies WHERE workspace_id=w;
 IF NOT FOUND OR prior_policy_revision IS NULL THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 -- Keep the ordinary semantic version advance and descendant invalidation.$after$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory hold binding splice prerequisite changed';END IF;
 definition:=replace(definition,before,after);
 before:=$before$ -- Insert after the factual invalidation; this is a receipt of that operation,$before$;
 after:=$after$ -- AFTER UPDATE descendants have finished under the same workspace lock.
 -- Bind only this result's actual state, never an inferred timestamp or caller value.
 SELECT scope_held INTO result_held FROM memories
  WHERE workspace_id=w AND id=i AND scope_version::text=new_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 SELECT revision INTO result_policy_revision FROM workspace_access_policies WHERE workspace_id=w;
 SELECT * INTO result_state FROM scope_resource_states
  WHERE workspace_id=w AND resource_kind='memory' AND resource_id=i AND resource_version=new_version;
 IF result_held THEN
  IF NOT FOUND OR result_state.review_state IS DISTINCT FROM 'held'
   OR result_state.holding_reason IS DISTINCT FROM 'source_changed'
   OR result_state.classification_revision IS NULL
   OR result_state.classification_revision<=prior_policy_revision
   OR result_policy_revision IS NULL OR result_state.classification_revision>result_policy_revision THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  result_hold_state:=jsonb_build_object('workspaceId',w,'resourceKind','memory','resourceId',i,
   'resourceVersion',new_version,'reviewState',result_state.review_state,
   'classificationRevision',result_state.classification_revision::text,'holdingReason',result_state.holding_reason);
 ELSE
  IF FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  result_hold_state:='null'::jsonb;
 END IF;
 -- Insert after the factual invalidation; this is a receipt of that operation,$after$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory hold binding splice prerequisite changed';END IF;
 definition:=replace(definition,before,after);
 before:=$before$'reasonEvidence',reason_inputs,'originalRoots',roots,'transactionId',pg_current_xact_id()::text)$before$;
 after:=$after$'reasonEvidence',reason_inputs,'originalRoots',roots,'transactionId',pg_current_xact_id()::text,'resultHoldState',result_hold_state)$after$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory hold binding splice prerequisite changed';END IF;
 definition:=replace(definition,before,after);
 EXECUTE definition;
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=port) IS DISTINCT FROM 'a7e3cad620af70012a6f7e59190cd913ea4232b57b2ca1ef4f41f2ccda48a2a3' THEN
  RAISE EXCEPTION 'Memory hold binding metadata or body changed';END IF;
END $hold_binding$;
COMMIT;
