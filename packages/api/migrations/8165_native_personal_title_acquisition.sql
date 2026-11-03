BEGIN;
-- [COMP:api/application-persistence] One fresh native acquisition proof supplies
-- both caller evidence and admitted immutable title payloads. Output remains a
-- separate fresh operation; no caller can provide an opaque proof carrier.
DO $existing_empty_guard$
DECLARE actual pg_proc;pins text;trusted text;
BEGIN
 -- Reconstruct the existing SQL guard before invoking it. Its catalog
 -- fingerprints are data; the executable template is fixed by migration8152.
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE oid IN(
  'application_empty_query_worklist_reset(jsonb)'::regprocedure,
  'application_empty_query_worklist_current(uuid,jsonb)'::regprocedure,
  'read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'application_field_envelope_ancestry_allowed(uuid,jsonb)'::regprocedure);
 trusted:='SELECT application_memory_statement_helpers_current() AND (SELECT count(*)=4 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
    FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid)';
 SELECT * INTO actual FROM pg_proc WHERE oid='application_empty_query_helpers_current()'::regprocedure;
 IF actual.prosrc IS DISTINCT FROM trusted OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
  OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='sql') OR actual.pronamespace<>'public'::regnamespace
  OR NOT actual.prosecdef OR actual.provolatile<>'v' OR actual.proparallel<>'u' OR actual.procost<>100 OR actual.prorows<>0
  OR actual.prokind<>'f' OR actual.prorettype<>'boolean'::regtype OR actual.proretset OR actual.proisstrict OR actual.proleakproof
  OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] OR actual.prosupport<>0
  OR actual.probin IS NOT NULL OR actual.prosqlbody IS NOT NULL OR actual.proargdefaults IS NOT NULL OR actual.pronargdefaults<>0
  OR actual.proargnames IS NOT NULL OR actual.proargmodes IS NOT NULL OR actual.proallargtypes IS NOT NULL OR actual.protrftypes IS NOT NULL
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
   WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Native dependency existing guard changed';END IF;
END $existing_empty_guard$;
DO $prerequisites_application_native_title_group_helpers_current$
DECLARE pins text;trusted text;actual pg_proc;
BEGIN
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE oid IN(
  'read_native_personal_title_group(uuid,uuid[],uuid[])'::regprocedure,
  'read_session_title_revision(uuid,uuid,uuid)'::regprocedure,
  'read_session_context_revision(uuid,uuid)'::regprocedure,
  'session_context_revision_allowed(uuid,uuid)'::regprocedure,
  'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'application_empty_query_helpers_current()'::regprocedure,
  'application_memory_statement_helpers_current()'::regprocedure);
 trusted:=
  'BEGIN IF (SELECT count(*)=7 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
   FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
   RETURN application_empty_query_helpers_current();END';
 SELECT * INTO actual FROM pg_proc WHERE oid='application_native_title_group_helpers_current()'::regprocedure;
 IF actual.prosrc IS DISTINCT FROM trusted
 OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proname'] IS DISTINCT FROM $metadata${"probin":null,"procost":100,"prokind":"f","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$metadata$::jsonb
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
 WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Title acquisition existing guard changed: application_native_title_group_helpers_current()';END IF;
 -- The 8152/127 prerequisite must be independently validated before this block.
 IF application_native_title_group_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Title acquisition existing helpers changed: application_native_title_group_helpers_current()';END IF;
END $prerequisites_application_native_title_group_helpers_current$;

DO $canonical$
DECLARE expected jsonb;actual pg_proc;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN(
  'native_personal_title_group_acquisition','application_native_title_acquisition_helpers_current','read_native_personal_title_group_evidence'))
 THEN RAISE EXCEPTION 'Title acquisition helper identity already exists';END IF;
 FOR expected IN SELECT value FROM jsonb_array_elements($expected$[{"signature":"read_entity_derivation_source(uuid,text,uuid)","body":"e707edb588228a6e18790026bd886c4946b5c2adcff0b7428ebfb0fb43e052f3","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"session_recording_read_allowed(uuid)","body":"d23352b30977749dd2dad03504c1dab5cdeb9aa1b2ef11fc79701bd8714e1886","language":"sql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"session_recording_read_allowed","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["i"],"proargtypes":["2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"recording_source_read_allowed(uuid,text,uuid)","body":"68dc93ecfee1a416209fc464f4c4e50130f3a1618da988ad8a5daba1df9f93d1","language":"sql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"recording_source_read_allowed","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"read_native_personal_title_group(uuid,uuid[],uuid[])","body":"69ed9db998ee2cee18d33d6c10b3059f53dab6f6dd4d5ecc3e296f5f79a70298","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_personal_title_group","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","session_ids","revision_ids"],"proargtypes":["2950","2951","2951"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}}]$expected$::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(expected->>'signature');
  IF actual.oid IS NULL OR encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected->>'body'
   OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
   OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname=(expected->>'language'))
   OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace'] IS DISTINCT FROM expected->'metadata'
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
    WHERE a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable
     OR a.grantee<>actual.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user' AND oid=a.grantee))
   OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') AND NOT EXISTS(
    SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a JOIN pg_roles r ON r.oid=a.grantee
     WHERE r.rolname='app_user' AND a.privilege_type='EXECUTE')
  THEN RAISE EXCEPTION 'Title acquisition canonical prerequisite changed: %',expected->>'signature';END IF;
 END LOOP;
END $canonical$;
CREATE FUNCTION native_personal_title_group_acquisition(w uuid,session_ids uuid[],revision_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 assistant uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 position integer;head uuid;nodes jsonb;proof jsonb;root jsonb;sources jsonb:='[]';payload jsonb;rows_json jsonb:='[]';
BEGIN
 IF application_native_title_acquisition_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 IF actor IS NULL OR assistant IS NULL OR session_ids IS NULL OR revision_ids IS NULL
  OR array_ndims(session_ids)<>1 OR array_lower(session_ids,1)<>1 OR array_ndims(revision_ids)<>1 OR array_lower(revision_ids,1)<>1
  OR cardinality(session_ids) NOT BETWEEN 2 AND 50 OR cardinality(session_ids)<>cardinality(revision_ids)
  OR array_position(session_ids,NULL) IS NOT NULL OR array_position(revision_ids,NULL) IS NOT NULL
  OR (SELECT count(DISTINCT id) FROM unnest(session_ids) id)<>cardinality(session_ids)
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR current_setting('app.agent_shared_audience',true)='true'
  OR EXISTS(SELECT 1 FROM pg_roles role JOIN pg_class owned ON owned.oid='public.session_context_revision_contents'::regclass
   WHERE role.rolname=session_user AND(role.rolsuper OR role.rolbypassrls OR pg_has_role(role.oid,owned.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 -- Every original head and parent stays bound to its own session. The SHARE
 -- lock is the canonical title reader's lock, held until this read commits.
 FOR position IN 1..cardinality(session_ids) LOOP
  IF NOT EXISTS(SELECT 1 FROM sessions s WHERE s.workspace_id=w AND s.id=session_ids[position]
   AND s.user_id=actor AND s.assistant_id=assistant AND s.visibility='personal' AND s.channel_type='web' AND s.anchor_kind='none')
   OR session_recording_read_allowed(session_ids[position]) IS NOT TRUE
   OR recording_source_read_allowed(w,'session_context_revision',revision_ids[position]) IS NOT TRUE THEN RETURN NULL;END IF;
  SELECT h.scope_revision_id INTO head FROM session_title_heads h WHERE h.workspace_id=w AND h.session_id=session_ids[position] FOR SHARE;
  IF head IS DISTINCT FROM revision_ids[position] OR NOT EXISTS(SELECT 1 FROM session_context_scope_revisions r
   WHERE r.workspace_id=w AND r.id=revision_ids[position] AND r.session_id=session_ids[position]
    AND r.parent_kind='session_title' AND r.parent_id=session_ids[position]) THEN RETURN NULL;END IF;
  root:=read_entity_derivation_source(w,'session_context_revision',revision_ids[position]);
  IF root IS NULL OR root->>'held' IS DISTINCT FROM 'false' OR root->>'version' IS DISTINCT FROM '1' THEN RETURN NULL;END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(node)),'[]') INTO nodes
   FROM application_scope_lineage(w,ARRAY['session_context_revision'],ARRAY[revision_ids[position]],ARRAY['1']) node;
  -- Keep the exact ordinary Memory/file title branch. Other purposes use
  -- the unchanged individual reader, including selected Memory history.
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='workspace_file')
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f
    ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field'
     AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND f.type_key='memory' AND f.selection='query_domain')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f
    ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field'
     AND f.type_key='memory' AND (f.selected_version IS NOT NULL OR f.selection<>'query_domain')) THEN RETURN NULL;END IF;
  sources:=sources||jsonb_build_array(jsonb_build_object('workspaceId',root->'workspaceId','userId',root->'userId','assistantId',root->'assistantId',
   'sensitivity',root->'sensitivity','compartments',root->'compartments','projectIds',root->'projectIds',
   'resourceKind','session_context_revision','resourceId',revision_ids[position],'version','1'));
 END LOOP;
 proof:=read_native_file_session_evidence(w,ARRAY(SELECT 'session_context_revision'::text FROM unnest(revision_ids)),revision_ids,
  ARRAY(SELECT '1'::text FROM unnest(revision_ids)),true);
 IF proof->>'admitted' IS DISTINCT FROM 'true' OR NOT coalesce(proof->'immutable' @> sources,false) THEN RETURN NULL;END IF;
 FOR position IN 1..cardinality(session_ids) LOOP
  SELECT c.content INTO payload FROM session_context_revision_contents c WHERE c.workspace_id=w AND c.revision_id=revision_ids[position];
  IF payload IS NULL THEN RETURN NULL;END IF;
  rows_json:=rows_json||jsonb_build_array(jsonb_build_object('sessionId',session_ids[position],'revisionId',revision_ids[position],
   'content',payload,'source',sources->(position-1)));
 END LOOP;
 IF application_native_title_acquisition_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('titles',rows_json,'proof',proof);
EXCEPTION WHEN invalid_parameter_value THEN
 IF SQLERRM='scope_ancestry_unavailable' THEN RETURN NULL;END IF;
 RAISE;
END $body$;
DO $private_acl$
DECLARE recipient record;
BEGIN
 REVOKE ALL ON FUNCTION native_personal_title_group_acquisition(uuid,uuid[],uuid[]) FROM PUBLIC;
 FOR recipient IN SELECT DISTINCT r.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  JOIN pg_roles r ON r.oid=a.grantee WHERE p.oid='native_personal_title_group_acquisition(uuid,uuid[],uuid[])'::regprocedure AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION native_personal_title_group_acquisition(uuid,uuid[],uuid[]) FROM %I',recipient.rolname);
 END LOOP;
END $private_acl$;
DO $guard$
DECLARE pins text;
BEGIN
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE oid IN(
  'native_personal_title_group_acquisition(uuid,uuid[],uuid[])'::regprocedure,
  'application_native_title_group_helpers_current()'::regprocedure,
  'read_native_personal_title_group(uuid,uuid[],uuid[])'::regprocedure,
  'session_recording_read_allowed(uuid)'::regprocedure,
  'recording_source_read_allowed(uuid,text,uuid)'::regprocedure,
  'read_entity_derivation_source(uuid,text,uuid)'::regprocedure,
  'application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure,
  'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure);
 EXECUTE 'CREATE FUNCTION application_native_title_acquisition_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS '||quote_literal(
  'BEGIN IF (SELECT count(*)=8 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
   FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
   RETURN application_native_title_group_helpers_current();END');
END $guard$;
DO $private_acl$
DECLARE recipient record;
BEGIN
 REVOKE ALL ON FUNCTION application_native_title_acquisition_helpers_current() FROM PUBLIC;
 FOR recipient IN SELECT DISTINCT r.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  JOIN pg_roles r ON r.oid=a.grantee WHERE p.oid='application_native_title_acquisition_helpers_current()'::regprocedure AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION application_native_title_acquisition_helpers_current() FROM %I',recipient.rolname);
 END LOOP;
END $private_acl$;
DO $facade$
DECLARE fingerprint text;body text;
BEGIN
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO fingerprint FROM pg_proc p
  WHERE p.oid='application_native_title_acquisition_helpers_current()'::regprocedure;
 body:=$body$DECLARE captured jsonb;
BEGIN
 -- Pin the guard itself before invoking any new helper, including unknown guard code.
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_catalog.pg_proc p
  WHERE p.oid='public.application_native_title_acquisition_helpers_current()'::regprocedure) IS DISTINCT FROM '__GUARD_PIN__' THEN RETURN NULL;END IF;
 IF application_native_title_acquisition_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 -- A broadened facade ACL cannot grant a caller the original reader's authority.
 IF has_function_privilege(session_user,'public.read_native_personal_title_group(uuid,uuid[],uuid[])','EXECUTE') IS NOT TRUE THEN RETURN NULL;END IF;
 captured:=native_personal_title_group_acquisition(w,session_ids,revision_ids);
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_catalog.pg_proc p
  WHERE p.oid='public.application_native_title_acquisition_helpers_current()'::regprocedure) IS DISTINCT FROM '__GUARD_PIN__' THEN RETURN NULL;END IF;
 IF application_native_title_acquisition_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN captured;
END$body$;
 EXECUTE 'CREATE FUNCTION read_native_personal_title_group_evidence(w uuid,session_ids uuid[],revision_ids uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS '
  ||quote_literal(replace(body,'__GUARD_PIN__',fingerprint));
END $facade$;
DO $private_acl$
DECLARE recipient record;
BEGIN
 REVOKE ALL ON FUNCTION read_native_personal_title_group_evidence(uuid,uuid[],uuid[]) FROM PUBLIC;
 FOR recipient IN SELECT DISTINCT r.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  JOIN pg_roles r ON r.oid=a.grantee WHERE p.oid='read_native_personal_title_group_evidence(uuid,uuid[],uuid[])'::regprocedure AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION read_native_personal_title_group_evidence(uuid,uuid[],uuid[]) FROM %I',recipient.rolname);
 END LOOP;
END $private_acl$;
DO $runtime$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION read_native_personal_title_group_evidence(uuid,uuid[],uuid[]) TO app_user;
 END IF;
 IF application_native_title_acquisition_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Title acquisition helper contract changed';END IF;
END $runtime$;
COMMIT;
