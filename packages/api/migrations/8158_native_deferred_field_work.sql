BEGIN;
DO $prerequisites$
DECLARE expected jsonb;actual pg_proc;pins text;trusted text;
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
 IF application_empty_query_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Native dependency canonical helpers changed';END IF;

 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE oid IN(
  'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)'::regprocedure,
  'read_native_file_session_field_snapshots(uuid,uuid[],text[])'::regprocedure,
  'capture_native_session_projection_batch(uuid,uuid,integer,text)'::regprocedure,
  'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'application_empty_query_helpers_current()'::regprocedure,
  'application_memory_statement_helpers_current()'::regprocedure);
 trusted:='BEGIN
   IF (SELECT count(*)=7 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
    FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
   RETURN application_empty_query_helpers_current();
   END';
 SELECT * INTO actual FROM pg_proc WHERE oid='application_native_file_capture_helpers_current()'::regprocedure;
 IF actual.prosrc IS DISTINCT FROM trusted OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
  OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql') OR actual.pronamespace<>'public'::regnamespace
  OR NOT actual.prosecdef OR actual.provolatile<>'v' OR actual.proparallel<>'u' OR actual.procost<>100 OR actual.prorows<>0
  OR actual.prokind<>'f' OR actual.prorettype<>'boolean'::regtype OR actual.proretset OR actual.proisstrict OR actual.proleakproof
  OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] OR actual.prosupport<>0
  OR actual.probin IS NOT NULL OR actual.prosqlbody IS NOT NULL OR actual.proargdefaults IS NOT NULL OR actual.pronargdefaults<>0
  OR actual.proargnames IS NOT NULL OR actual.proargmodes IS NOT NULL OR actual.proallargtypes IS NOT NULL OR actual.protrftypes IS NOT NULL
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
   WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Native dependency file guard changed';END IF;
 IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Native dependency file helpers changed';END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='scope_derivation_sources'::regclass AND tgenabled<>'O') THEN RAISE EXCEPTION 'Native dependency trigger enablement changed';END IF;
 IF (SELECT jsonb_agg(pg_get_triggerdef(oid) ORDER BY tgname) FROM pg_trigger WHERE tgrelid='scope_derivation_sources'::regclass AND NOT tgisinternal)
 IS DISTINCT FROM $triggers$["CREATE CONSTRAINT TRIGGER application_field_derivation_dependencies AFTER INSERT OR UPDATE ON public.scope_derivation_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_application_field_dependencies()","CREATE TRIGGER application_field_sources_immutable BEFORE DELETE OR UPDATE ON public.scope_derivation_sources FOR EACH ROW EXECUTE FUNCTION guard_application_field_lineage()","CREATE TRIGGER crm_recovery_capture AFTER INSERT OR DELETE OR UPDATE ON public.scope_derivation_sources FOR EACH ROW EXECUTE FUNCTION crm_capture_erasure_effect()","CREATE CONSTRAINT TRIGGER page_derivation_dependencies AFTER INSERT OR UPDATE ON public.scope_derivation_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_page_derivation_dependencies()","CREATE TRIGGER page_derivation_receipts BEFORE DELETE OR UPDATE ON public.scope_derivation_sources FOR EACH ROW EXECUTE FUNCTION guard_page_derivation_receipts()","CREATE TRIGGER scope_derivation_sources_reference BEFORE INSERT OR UPDATE ON public.scope_derivation_sources FOR EACH ROW EXECUTE FUNCTION validate_scope_resource_reference()","CREATE TRIGGER scope_derivation_sources_retention BEFORE INSERT OR UPDATE ON public.scope_derivation_sources FOR EACH ROW EXECUTE FUNCTION guard_external_source_derivation()","CREATE TRIGGER session_context_lineage_source BEFORE DELETE OR UPDATE ON public.scope_derivation_sources FOR EACH ROW EXECUTE FUNCTION guard_session_context_lineage()","CREATE CONSTRAINT TRIGGER workflow_derivation_dependencies AFTER INSERT OR UPDATE ON public.scope_derivation_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_workflow_derivation_dependencies()","CREATE TRIGGER workflow_derivation_receipts BEFORE DELETE OR UPDATE ON public.scope_derivation_sources FOR EACH ROW EXECUTE FUNCTION guard_workflow_derivation_receipts()"]$triggers$::jsonb THEN RAISE EXCEPTION 'Native dependency trigger inventory changed';END IF;
 FOR expected IN SELECT value FROM jsonb_array_elements($expected$[{"body":"dc624ef75446dae536a97bc750d759179c9fda51e39bf037fecb87d9026cf17f","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"crm_capture_erasure_effect","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"crm_capture_erasure_effect()","public":false},{"body":"25028ddfeefca64f4d03d06785d6a17d10950910a66c0cf2c4a005ae0024c539","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"validate_scope_resource_reference","prorows":0,"pronargs":0,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"validate_scope_resource_reference()","public":true},{"body":"cd9832c8a784dc6b29cce4cdb1d047dfa03df26453deebb36b8ebfac64813240","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"validate_workflow_derivation_dependencies","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"validate_workflow_derivation_dependencies()","public":false},{"body":"5b5b0f64dc13ec6b3ef6d8505c03a3d259282546f9845be0d900c20551ee3484","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"guard_workflow_derivation_receipts","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"guard_workflow_derivation_receipts()","public":false},{"body":"e8f0984c2866742684aff57ddbfe3e918a04c0c39b125fe3a9c3e85993f1ab01","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"validate_page_derivation_dependencies","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"validate_page_derivation_dependencies()","public":false},{"body":"65f0250504847fd5fa69887ad70927d0846bf1ca09b3756ac0d83b53eb1542a7","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"guard_page_derivation_receipts","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"guard_page_derivation_receipts()","public":false},{"body":"01ae35d55c94a279b9032f2d174c9b9ff9bc0bfcb600ab5986f9dfd5e13fb088","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"guard_external_source_derivation","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"guard_external_source_derivation()","public":false},{"body":"6f86fbd4c0cc5c77e69a91c6c0c211b0b70c69f49dfd89b3ec85eddff39d9091","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"validate_application_field_dependencies","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"validate_application_field_dependencies()","public":false},{"body":"8d2bf69857323591892c3956cdd2fedd3d227cf042c928c56fc714e4ff957f24","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"guard_application_field_lineage","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"guard_application_field_lineage()","public":false},{"body":"970b284e9d53ffffc75c68415b3fcf53137fff1c7de3dd611faaae369d75e38e","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"guard_session_context_lineage","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"guard_session_context_lineage()","public":false},{"body":"e50b906a90b238bac1de121fe39e7548c7553abca4fbb5935eef540249f42bee","public":false,"runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_application_field_dependencies","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t"],"proargnames":["w","kinds","ids","versions","node_version","source"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","3802"],"proargdefaults":null,"pronargdefaults":0},"signature":"read_application_field_dependencies(uuid,text[],uuid[],text[])"}]$expected$::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(expected->>'signature');
  IF actual.oid IS NULL OR encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected->>'body'
   OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
   OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace']) IS DISTINCT FROM expected->'metadata'
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) acl
    WHERE acl.grantor<>actual.proowner OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable
     OR acl.grantee<>actual.proowner AND NOT(coalesce((expected->>'public')::boolean,false) AND acl.grantee=0) AND NOT((expected->>'runtime')::boolean
      AND acl.grantee=coalesce((SELECT oid FROM pg_roles WHERE rolname='app_user'),0) AND acl.grantee<>0)) THEN
   RAISE EXCEPTION 'Native dependency prerequisite changed: %',expected->>'signature';END IF;
 END LOOP;
END $prerequisites$;
-- [COMP:api/application-persistence] Queue work, never authorization results.
CREATE TABLE native_field_dependency_batches (
 transaction_id bigint NOT NULL,workspace_id uuid NOT NULL,derivation_id uuid NOT NULL,
 pending_events integer NOT NULL CHECK(pending_events>=0),queued_events bigint NOT NULL DEFAULT 1 CHECK(queued_events>0),fallback boolean NOT NULL DEFAULT false,
 PRIMARY KEY(transaction_id,workspace_id,derivation_id));
CREATE TABLE native_field_dependency_work (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 transaction_id bigint NOT NULL,workspace_id uuid NOT NULL,derivation_id uuid NOT NULL,
 source jsonb NOT NULL,fired boolean NOT NULL DEFAULT false,processed boolean NOT NULL DEFAULT false);
CREATE INDEX native_field_dependency_work_batch ON native_field_dependency_work(transaction_id,workspace_id,derivation_id,id);
ALTER TABLE native_field_dependency_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE native_field_dependency_work ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION enqueue_native_field_dependency_work() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE operation_txid bigint:=txid_current();
BEGIN
 IF current_setting('app.crm_erasure_capture',true)='on' OR application_native_dependency_batch_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 -- A source event belongs to one real statement. BEFORE enqueue would also
 -- count INSERT ... ON CONFLICT DO NOTHING candidates that never inserted.
 INSERT INTO native_field_dependency_batches(transaction_id,workspace_id,derivation_id,pending_events)
 VALUES(operation_txid,NEW.workspace_id,NEW.derivation_id,1)
 ON CONFLICT ON CONSTRAINT native_field_dependency_batches_pkey DO UPDATE
 SET pending_events=native_field_dependency_batches.pending_events+1,
  queued_events=native_field_dependency_batches.queued_events+1,
  fallback=native_field_dependency_batches.fallback OR native_field_dependency_batches.queued_events>=100;
 INSERT INTO native_field_dependency_work(transaction_id,workspace_id,derivation_id,source)
 VALUES(operation_txid,NEW.workspace_id,NEW.derivation_id,to_jsonb(NEW));
 RETURN NULL;
END $$;
CREATE TRIGGER application_field_dependency_work AFTER INSERT OR UPDATE ON scope_derivation_sources
 FOR EACH ROW EXECUTE FUNCTION enqueue_native_field_dependency_work();

CREATE FUNCTION validate_native_field_dependency_batch(w uuid,derivation uuid,work jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE output scope_derivations;roots jsonb;fields jsonb;proof jsonb;dependency record;source jsonb;current jsonb;
 kinds text[];ids uuid[];versions text[];
BEGIN
 IF application_native_dependency_batch_helpers_current() IS NOT TRUE THEN RETURN false;END IF;
 IF jsonb_typeof(work) IS DISTINCT FROM 'array' OR jsonb_array_length(work)<2
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(work) item WHERE item->>'workspace_id' IS DISTINCT FROM w::text
   OR item->>'derivation_id' IS DISTINCT FROM derivation::text
   OR item->>'source_kind' NOT IN('application_field','session_context_revision','session_message','memory','workspace_file'))
  OR current_setting('app.crm_erasure_capture',true)='on'
  OR EXISTS(SELECT 1 FROM pg_roles role JOIN pg_class tab ON tab.oid='public.scope_derivation_sources'::regclass
   WHERE role.rolname=session_user AND(role.rolsuper OR role.rolbypassrls OR pg_has_role(role.oid,tab.relowner,'USAGE'))) THEN RETURN false;END IF;
 SELECT * INTO output FROM scope_derivations WHERE workspace_id=w AND id=derivation;
 IF NOT FOUND THEN RETURN true;END IF;
 IF output.resource_kind NOT IN('session_message','session_context_revision') THEN RETURN false;END IF;
 SELECT jsonb_agg(root ORDER BY root::text) INTO roots FROM(
  SELECT DISTINCT jsonb_build_object('kind',item->'source_kind','id',item->'source_id','version',item->'source_version') root
  FROM jsonb_array_elements(work) item) unique_roots;
 IF jsonb_array_length(roots) NOT BETWEEN 1 AND 100 THEN RETURN false;END IF;
 kinds:=ARRAY(SELECT root->>'kind' FROM jsonb_array_elements(roots) root);
 ids:=ARRAY(SELECT (root->>'id')::uuid FROM jsonb_array_elements(roots) root);
 versions:=ARRAY(SELECT root->>'version' FROM jsonb_array_elements(roots) root);
 -- Only native non-history fields may take this branch. Unsupported fields
 -- and historical Memory retain the complete original per-event validator.
 SELECT coalesce(jsonb_agg(jsonb_build_object('node_version',d.node_version,'source',d.source) ORDER BY d.source->>'resourceId',d.node_version),'[]')
 INTO fields FROM read_application_field_dependencies(w,kinds,ids,versions) d;
 IF jsonb_array_length(fields) NOT BETWEEN 2 AND 100 OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(fields) d LEFT JOIN application_field_resources f
   ON f.workspace_id=w AND f.id=(d#>>'{source,resourceId}')::uuid
  WHERE f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR f.type_key NOT IN('session_message','session_message_annotation','memory')
   OR f.selected_version IS NOT NULL OR f.selection NOT IN('read','query','identity','query_domain')) THEN RETURN false;END IF;
 proof:=read_native_file_session_cohort_frame(w,kinds,ids,versions,true);
 IF proof->>'admitted' IS DISTINCT FROM 'true' OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(fields) field
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'current') point
   WHERE point->>'resourceKind'='application_field' AND point->>'resourceId'=field#>>'{source,resourceId}'
    AND point->>'version'=field->>'node_version')) THEN RETURN false;END IF;
 IF application_native_dependency_batch_helpers_current() IS NOT TRUE THEN RETURN false;END IF;
 IF application_native_file_frame_current(w,kinds,ids,versions,proof) IS NOT TRUE THEN RETURN false;END IF;
 -- The private frame buffers complete current sources behind another fresh
 -- proof. These are unchanged declaration/label checks, not reused permission.
 FOR dependency IN SELECT d->>'node_version' AS node_version,d->'source' AS source FROM jsonb_array_elements(fields) d LOOP
  source:=dependency.source;
  IF NOT EXISTS(SELECT 1 FROM scope_derivation_sources declared WHERE declared.workspace_id=w AND declared.derivation_id=derivation
   AND declared.source_kind='application_field' AND declared.source_id=(source->>'resourceId')::uuid AND declared.source_version=dependency.node_version) THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  IF source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM output.user_id::text
   AND source->>'userId' IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')
   OR sensitivity_rank(source->>'sensitivity')>sensitivity_rank(output.sensitivity)
   OR NOT to_jsonb(output.compartments)@>(source->'compartments') OR NOT to_jsonb(output.project_ids)@>(source->'projectIds') THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
 END LOOP;
 -- The eligible closed frame contains no external source. If a fresh
 -- discovery changes that, replay each original event, including its original
 -- has_fields gate, retention checks and output labels.
 IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,kinds,ids,versions)) THEN RETURN false;END IF;
 IF application_native_dependency_batch_helpers_current() IS NOT TRUE THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_parameter_value THEN
 IF SQLERRM='scope_ancestry_unavailable' THEN RETURN false;END IF;RAISE;
END $$;

DO $validator$
DECLARE original text;definition text;declaration text;body text;updated text;metadata jsonb;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO original,definition,metadata FROM pg_proc p
 WHERE oid='validate_application_field_dependencies()'::regprocedure;
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM '6f86fbd4c0cc5c77e69a91c6c0c211b0b70c69f49dfd89b3ec85eddff39d9091' THEN
  RAISE EXCEPTION 'Native dependency validator changed';END IF;
 declaration:=substring(original FROM 1 FOR position(E'BEGIN\n' IN original)-1);
 declaration:=declaration||$declarations$
 work_row scope_derivation_sources;queued native_field_dependency_work;batch_header native_field_dependency_batches;
 work_rows jsonb;work_ids bigint[];has_queue boolean:=false;batch_eligible boolean:=false;operation_txid bigint:=txid_current();
$declarations$;
 body:=substring(original FROM position(E'BEGIN\n' IN original)+length(E'BEGIN\n'));
 body:=regexp_replace(body,'END[[:space:]]*$','');
 body:=replace(replace(body,'NEW.','work_row.'),'RETURN NULL;','CONTINUE original_work;');
 updated:=declaration||$scheduler$
BEGIN
 work_rows:=jsonb_build_array(to_jsonb(NEW));
 SELECT * INTO queued FROM native_field_dependency_work work
 WHERE work.transaction_id=operation_txid AND work.workspace_id=NEW.workspace_id AND work.derivation_id=NEW.derivation_id
  AND work.source=to_jsonb(NEW) AND work.fired IS FALSE ORDER BY work.id LIMIT 1 FOR UPDATE;
 has_queue:=FOUND;
 IF has_queue THEN
  UPDATE native_field_dependency_work SET fired=true WHERE id=queued.id;
  UPDATE native_field_dependency_batches batch SET pending_events=batch.pending_events-1
  WHERE batch.transaction_id=operation_txid AND batch.workspace_id=NEW.workspace_id AND batch.derivation_id=NEW.derivation_id
  RETURNING * INTO batch_header;
  IF NOT FOUND THEN batch_header.fallback:=true;END IF;
  batch_eligible:=application_native_dependency_batch_helpers_current();
  IF batch_eligible IS NOT TRUE THEN
   batch_header.fallback:=true;
   UPDATE native_field_dependency_batches batch SET fallback=true
   WHERE batch.transaction_id=operation_txid AND batch.workspace_id=NEW.workspace_id AND batch.derivation_id=NEW.derivation_id;
  END IF;
  -- No source or authorization state is cached. The final pending event
  -- obtains the fresh union proof for all earlier queued work.
  IF batch_header.pending_events>0 AND batch_header.fallback IS FALSE THEN RETURN NULL;END IF;
  SELECT jsonb_agg(work.source ORDER BY work.id),array_agg(work.id ORDER BY work.id) INTO work_rows,work_ids
  FROM native_field_dependency_work work WHERE work.transaction_id=operation_txid AND work.workspace_id=NEW.workspace_id
   AND work.derivation_id=NEW.derivation_id AND work.fired AND NOT work.processed;
  IF work_rows IS NULL THEN
   work_rows:=jsonb_build_array(to_jsonb(NEW));work_ids:=ARRAY[queued.id];batch_header.fallback:=true;
  END IF;
  IF batch_header.fallback IS FALSE THEN
   IF validate_native_field_dependency_batch(NEW.workspace_id,NEW.derivation_id,work_rows) IS TRUE THEN work_rows:='[]';END IF;
  END IF;
 ELSE
  -- A missing scheduling row is not evidence that its source was checked.
  -- Disable aggregation for any surviving header and replay prior fired work.
  SELECT * INTO batch_header FROM native_field_dependency_batches batch
  WHERE batch.transaction_id=operation_txid AND batch.workspace_id=NEW.workspace_id AND batch.derivation_id=NEW.derivation_id FOR UPDATE;
  IF FOUND THEN
   has_queue:=true;batch_header.fallback:=true;
   UPDATE native_field_dependency_batches batch SET fallback=true
   WHERE batch.transaction_id=operation_txid AND batch.workspace_id=NEW.workspace_id AND batch.derivation_id=NEW.derivation_id;
   SELECT coalesce(jsonb_agg(work.source ORDER BY work.id),'[]')||jsonb_build_array(to_jsonb(NEW)),array_agg(work.id ORDER BY work.id)
   INTO work_rows,work_ids FROM native_field_dependency_work work WHERE work.transaction_id=operation_txid
    AND work.workspace_id=NEW.workspace_id AND work.derivation_id=NEW.derivation_id AND work.fired AND NOT work.processed;
  END IF;
 END IF;
 <<original_work>>
 FOR work_row IN SELECT * FROM jsonb_populate_recordset(NULL::scope_derivation_sources,coalesce(work_rows,'[]')) LOOP
  has_fields:=false;history:=false;projection:=NULL;label:=NULL;fields:=NULL;source:=NULL;current:=NULL;
$scheduler$||body||$finish$
 END LOOP original_work;
 IF has_queue THEN
  UPDATE native_field_dependency_work SET processed=true WHERE id=ANY(work_ids);
  IF batch_header.pending_events=0 OR NOT EXISTS(SELECT 1 FROM native_field_dependency_work work
   WHERE work.transaction_id=operation_txid AND work.workspace_id=NEW.workspace_id AND work.derivation_id=NEW.derivation_id AND NOT work.fired) THEN
   DELETE FROM native_field_dependency_work work WHERE work.transaction_id=operation_txid
    AND work.workspace_id=NEW.workspace_id AND work.derivation_id=NEW.derivation_id;
   DELETE FROM native_field_dependency_batches batch WHERE batch.transaction_id=operation_txid
    AND batch.workspace_id=NEW.workspace_id AND batch.derivation_id=NEW.derivation_id;
  ELSIF batch_header.pending_events IS NULL THEN
   -- Corrupt/missing scheduling metadata is never an admission shortcut.
   DELETE FROM native_field_dependency_work WHERE id=ANY(work_ids);
  END IF;
 END IF;
 RETURN NULL;
END
$finish$;
 EXECUTE replace(definition,original,updated);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid='validate_application_field_dependencies()'::regprocedure) IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'Native dependency validator metadata changed';END IF;
END $validator$;

DO $private_acl$
DECLARE relation record;routine record;recipient record;
BEGIN
 FOR relation IN SELECT oid,relname,relkind,relowner,relacl FROM pg_class
 WHERE oid IN('native_field_dependency_batches'::regclass,'native_field_dependency_work'::regclass,
  pg_get_serial_sequence('native_field_dependency_work','id')::regclass) LOOP
  EXECUTE format('REVOKE ALL ON %s public.%I FROM PUBLIC',CASE WHEN relation.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,relation.relname);
  FOR recipient IN SELECT DISTINCT role.rolname FROM aclexplode(coalesce(relation.relacl,acldefault(CASE WHEN relation.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,relation.relowner))) a
   JOIN pg_roles role ON role.oid=a.grantee WHERE a.grantee<>relation.relowner LOOP
   EXECUTE format('REVOKE ALL ON %s public.%I FROM %I',CASE WHEN relation.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,relation.relname,recipient.rolname);
  END LOOP;
 END LOOP;
 FOR routine IN SELECT oid::regprocedure signature,proowner,proacl FROM pg_proc WHERE oid IN(
  'enqueue_native_field_dependency_work()'::regprocedure,'validate_native_field_dependency_batch(uuid,uuid,jsonb)'::regprocedure) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',routine.signature);
  FOR recipient IN SELECT DISTINCT role.rolname FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a
   JOIN pg_roles role ON role.oid=a.grantee WHERE a.grantee<>routine.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',routine.signature,recipient.rolname);
  END LOOP;
 END LOOP;
END $private_acl$;

DO $guard$
DECLARE pins text;pin_count integer;trigger_state jsonb;table_state jsonb;shape_sql text;body text;
BEGIN
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid),count(*) INTO pins,pin_count
 FROM pg_proc p WHERE p.oid IN(
  SELECT tgfoid FROM pg_trigger WHERE tgrelid='scope_derivation_sources'::regclass AND NOT tgisinternal
  UNION SELECT unnest(ARRAY['validate_native_field_dependency_batch(uuid,uuid,jsonb)'::regprocedure,
   'read_application_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure,
   'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,
   'application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)'::regprocedure,
   'application_native_file_capture_helpers_current()'::regprocedure,
   'application_empty_query_helpers_current()'::regprocedure,
   'application_memory_statement_helpers_current()'::regprocedure]::oid[]));
 SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO trigger_state FROM pg_trigger t
 WHERE t.tgrelid IN('scope_derivation_sources'::regclass,'native_field_dependency_batches'::regclass,'native_field_dependency_work'::regclass);
 shape_sql:=$shape$SELECT jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.oid)
  FROM pg_class c WHERE c.oid IN('public.native_field_dependency_batches'::regclass,'public.native_field_dependency_work'::regclass,
   pg_get_serial_sequence('public.native_field_dependency_work','id')::regclass)),
 'columns',(SELECT jsonb_agg(jsonb_build_array(a.attrelid,a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.atthasdef,a.attidentity,a.attgenerated,a.attisdropped,a.attacl) ORDER BY a.attrelid,a.attnum)
  FROM pg_attribute a WHERE a.attnum>0 AND a.attrelid IN('public.native_field_dependency_batches'::regclass,'public.native_field_dependency_work'::regclass)),
 'defaults',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_attrdef d
  WHERE d.adrelid IN('public.native_field_dependency_batches'::regclass,'public.native_field_dependency_work'::regclass)),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p
  WHERE p.polrelid IN('public.native_field_dependency_batches'::regclass,'public.native_field_dependency_work'::regclass)),
 'rules',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid) FROM pg_rewrite r
  WHERE r.ev_class IN('public.native_field_dependency_batches'::regclass,'public.native_field_dependency_work'::regclass)),
 'sequence',(SELECT to_jsonb(s) FROM pg_sequence s WHERE s.seqrelid=pg_get_serial_sequence('public.native_field_dependency_work','id')::regclass),
 'constraints',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_constraint c
  WHERE c.conrelid IN('public.native_field_dependency_batches'::regclass,'public.native_field_dependency_work'::regclass)))$shape$;
 EXECUTE shape_sql INTO table_state;
 body:='BEGIN
 IF (SELECT count(*)='||pin_count||' AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
  FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
 IF (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid IN(''public.scope_derivation_sources''::regclass,''public.native_field_dependency_batches''::regclass,''public.native_field_dependency_work''::regclass)) IS DISTINCT FROM '||quote_literal(trigger_state::text)||'::jsonb THEN RETURN false;END IF;
 IF ('||shape_sql||') IS DISTINCT FROM '||quote_literal(table_state::text)||'::jsonb THEN RETURN false;END IF;
 RETURN application_native_file_capture_helpers_current();
 END';
 EXECUTE 'CREATE FUNCTION application_native_dependency_batch_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS '||quote_literal(body);
END $guard$;
REVOKE ALL ON FUNCTION application_native_dependency_batch_helpers_current() FROM PUBLIC;
DO $acl$
DECLARE recipient record;
BEGIN
 FOR recipient IN SELECT DISTINCT role.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  JOIN pg_roles role ON role.oid=a.grantee WHERE p.oid='application_native_dependency_batch_helpers_current()'::regprocedure AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION application_native_dependency_batch_helpers_current() FROM %I',recipient.rolname);
 END LOOP;
END $acl$;
DO $$ BEGIN
 IF application_native_dependency_batch_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Native dependency batch compatibility changed';END IF;
END $$;
COMMIT;
