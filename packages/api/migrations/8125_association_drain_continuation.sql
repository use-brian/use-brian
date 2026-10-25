-- Spec: features/association-operations.md, features/application-platform.md.
-- [COMP:crm/association-lifecycle] Continuation of accepted intent, not human authority.
BEGIN;
DO $prerequisites$
DECLARE item record;owner_id oid;runtime_id oid;
BEGIN
 SELECT relowner INTO owner_id FROM pg_class WHERE oid='public.application_native_field_contracts'::regclass;
 SELECT oid INTO runtime_id FROM pg_roles WHERE rolname='app_user';
 FOR item IN SELECT * FROM (VALUES
  ('application_prepare_native_module_lifecycle(uuid,text,text,integer,text)','368dd9507b67b7024b9596b12feeae3e',true,'void'),
  ('application_guard_native_module_lifecycle()','7fc7a2f12040b6c2b6a9bce5099e47fe',false,'trigger'),
  ('application_record_native_module_lifecycle()','033621862c1dc585a46fb705f82a021b',false,'trigger'),
  ('application_finish_native_module_lifecycle(uuid,text)','15545e066a4ed1b708d6b8cc944a47a1',true,'void')
 ) expected(signature,body_digest,runtime_execute,result_type) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=('public.'||item.signature)::regprocedure
   AND p.proowner=owner_id AND p.prosecdef AND p.prokind='f' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
   AND p.provolatile='v' AND p.proparallel='u' AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset
   AND p.prorettype=item.result_type::regtype AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']
   AND md5(p.prosrc)=item.body_digest
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable
     OR NOT(a.grantee=owner_id OR item.runtime_execute AND runtime_id IS NOT NULL AND a.grantee=runtime_id))
   AND EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=owner_id)
   AND (runtime_id IS NULL OR NOT item.runtime_execute OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=runtime_id))) THEN
   RAISE EXCEPTION 'association_drain_prerequisite_changed: %',item.signature;END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.application_native_module_lifecycle_reviews'::regclass
  AND c.relowner=owner_id AND c.relrowsecurity
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>owner_id))
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.application_native_module_lifecycle_reviews'::regclass
   AND attname='continuation_before' AND NOT attisdropped)
  OR (SELECT count(*) FROM pg_attribute WHERE attrelid='public.application_native_module_lifecycle_reviews'::regclass
   AND attname IN('actor_user_id','assistant_id') AND attnotnull AND NOT attisdropped)<>2 THEN
  RAISE EXCEPTION 'association_drain_prerequisite_changed: private witness';END IF;
END $prerequisites$;
ALTER TABLE application_native_module_lifecycle_reviews
 ADD COLUMN continuation_before jsonb,
 ALTER COLUMN actor_user_id DROP NOT NULL,
 ALTER COLUMN assistant_id DROP NOT NULL,
 ADD CONSTRAINT application_native_lifecycle_identity CHECK(
  continuation_before IS NULL AND actor_user_id IS NOT NULL AND assistant_id IS NOT NULL
  OR continuation_before IS NOT NULL AND actor_user_id IS NULL AND assistant_id IS NULL
   AND action='finish_disable' AND default_state='draining' AND observed_version>0
   AND jsonb_typeof(continuation_before)='object');
DO $consumers$
DECLARE definition text;needle text;replacement text;
BEGIN
 definition:=pg_get_functiondef('public.application_guard_native_module_lifecycle()'::regprocedure);
 needle:=$old$ IF NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=w)$old$;
 replacement:=$new$ -- A private, fixed-operation continuation is checked before the unowned early return.
 SELECT * INTO review FROM public.application_native_module_lifecycle_reviews r
  WHERE r.transaction_id=txid_current() AND r.backend_pid=pg_backend_pid()
   AND r.workspace_id=w AND r.module_key=module AND r.continuation_before IS NOT NULL;
 IF FOUND THEN
  IF TG_OP<>'UPDATE' OR module<>'association' OR review.initialized OR review.used
   OR review.actor_user_id IS NOT NULL OR review.assistant_id IS NOT NULL
   OR review.action<>'finish_disable' OR review.default_state<>'draining'
   OR OLD.state<>'draining' OR OLD.disable_requested_at IS NULL OR OLD.disabled_at IS NOT NULL
   OR review.observed_version<>OLD.version OR review.continuation_before IS DISTINCT FROM to_jsonb(OLD)
   OR NEW.state<>'disabled' OR NEW.version<>OLD.version+1 OR NEW.updated_by_user_id IS NOT NULL
   OR NEW.disabled_at IS NULL OR NEW.updated_at IS DISTINCT FROM NEW.disabled_at
   OR (to_jsonb(NEW)-ARRAY['state','version','disabled_at','updated_at','updated_by_user_id'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','disabled_at','updated_at','updated_by_user_id'])
   OR review.authority_revision IS DISTINCT FROM public.application_field_digest(jsonb_build_object(
    'purpose','association_module_drain_v1','workspaceId',w,'moduleKey',module,'before',to_jsonb(OLD),'after',to_jsonb(NEW))) THEN
   RAISE EXCEPTION 'access_unavailable: invalid drain continuation' USING ERRCODE='42501';END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=w)$new$;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'association_drain_prerequisite_changed: application_guard_native_module_lifecycle branch';END IF;
 definition:=replace(definition,needle,replacement);
 EXECUTE definition;
 definition:=pg_get_functiondef('public.application_record_native_module_lifecycle()'::regprocedure);
 needle:=$old$ IF NOT FOUND THEN RETURN NULL;END IF;
$old$;
 replacement:=$new$ IF NOT FOUND THEN RETURN NULL;END IF;
 IF review.continuation_before IS NOT NULL THEN
  IF review.initialized OR review.used OR NEW.module_key<>'association'
   OR review.authority_revision IS DISTINCT FROM public.application_field_digest(jsonb_build_object(
    'purpose','association_module_drain_v1','workspaceId',NEW.workspace_id,'moduleKey',NEW.module_key,
    'before',review.continuation_before,'after',to_jsonb(NEW))) THEN
   RAISE EXCEPTION 'access_unavailable: invalid drain completion' USING ERRCODE='42501';END IF;
  UPDATE public.application_native_module_lifecycle_reviews SET initialized=true,used=true
   WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND workspace_id=NEW.workspace_id AND module_key=NEW.module_key;
  RETURN NULL;
 END IF;
$new$;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'association_drain_prerequisite_changed: application_record_native_module_lifecycle branch';END IF;
 definition:=replace(definition,needle,replacement);
 EXECUTE definition;
 definition:=pg_get_functiondef('public.application_finish_native_module_lifecycle(uuid,text)'::regprocedure);
 needle:=$old$DECLARE review public.application_native_module_lifecycle_reviews;$old$;
 replacement:=$new$DECLARE review public.application_native_module_lifecycle_reviews;current_module public.workspace_modules;$new$;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'association_drain_prerequisite_changed: application_finish_native_module_lifecycle branch';END IF;
 definition:=replace(definition,needle,replacement);
 needle:=$old$ IF NOT FOUND THEN RETURN;END IF;
$old$;
 replacement:=$new$ IF NOT FOUND THEN RETURN;END IF;
 IF review.continuation_before IS NOT NULL THEN
  SELECT * INTO current_module FROM public.workspace_modules WHERE workspace_id=w AND module_key=module FOR UPDATE;
  IF NOT FOUND OR NOT review.initialized OR NOT review.used OR module<>'association'
   OR current_module.state<>'disabled' OR current_module.version<>review.observed_version+1
   OR review.authority_revision IS DISTINCT FROM public.application_field_digest(jsonb_build_object(
    'purpose','association_module_drain_v1','workspaceId',w,'moduleKey',module,
    'before',review.continuation_before,'after',to_jsonb(current_module))) THEN
   RAISE EXCEPTION 'module drain continuation changed' USING ERRCODE='40001';END IF;
  DELETE FROM public.application_native_module_lifecycle_reviews WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND workspace_id=w AND module_key=module;
  RETURN;
 END IF;
$new$;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'association_drain_prerequisite_changed: application_finish_native_module_lifecycle branch';END IF;
 definition:=replace(definition,needle,replacement);
 EXECUTE definition;
END $consumers$;

-- Fixed app-owned blocker and row transition; no caller-supplied actor, action or count.
CREATE FUNCTION association_finish_module_drain(w uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row public.workspace_modules;after_row public.workspace_modules;completed_at timestamptz;
BEGIN
 SELECT * INTO before_row FROM public.workspace_modules WHERE workspace_id=w AND module_key='association' FOR UPDATE;
 IF NOT FOUND OR before_row.state<>'draining' OR before_row.disable_requested_at IS NULL OR before_row.disabled_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.association_orders WHERE workspace_id=w AND status='pending') THEN RETURN false;END IF;
 completed_at:=clock_timestamp();after_row:=before_row;
 after_row.state:='disabled';after_row.version:=before_row.version+1;after_row.disabled_at:=completed_at;
 after_row.updated_at:=completed_at;after_row.updated_by_user_id:=NULL;
 INSERT INTO public.application_native_module_lifecycle_reviews(transaction_id,backend_pid,workspace_id,module_key,
  actor_user_id,assistant_id,observed_version,action,default_state,authority_revision,continuation_before)
 VALUES(txid_current(),pg_backend_pid(),w,'association',NULL,NULL,before_row.version,'finish_disable','draining',
  public.application_field_digest(jsonb_build_object('purpose','association_module_drain_v1','workspaceId',w,'moduleKey','association',
   'before',to_jsonb(before_row),'after',to_jsonb(after_row))),to_jsonb(before_row));
 UPDATE public.workspace_modules SET state=after_row.state,version=after_row.version,disabled_at=completed_at,updated_at=completed_at,updated_by_user_id=NULL
  WHERE workspace_id=w AND module_key='association';
 INSERT INTO public.workspace_audit_log(workspace_id,event_type,subject_id,details)
 VALUES(w,'workspace.module_changed',w,jsonb_build_object('moduleKey','association','action','finish_disable',
  'from','draining','to','disabled','version',after_row.version,'actorKind','system_job'));
 PERFORM public.application_finish_native_module_lifecycle(w,'association');
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION association_finish_module_drain(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON FUNCTION association_finish_module_drain(uuid) FROM app_user;
END IF;END $$;
COMMIT;
