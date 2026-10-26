-- [COMP:api/workspace-scope-review] Saved native review metadata classification.
-- Ordinary task editing, source/ancestry and assistant teardown guards are unchanged.
BEGIN;
DO $migration$
DECLARE entry record;p pg_proc;
BEGIN
 FOR entry IN SELECT * FROM (VALUES
  ('application_force_native_task_written_field()','9de042a0ad8db22b36ccee11c59b24af36b3e40c4ac8f4f82b903d86bddbcc9f'),
  ('application_record_native_task_write_intent(tasks,text[],text)','68686ea1edfa1579a6a5b1192342da12fd08ca87c5391975ad4692f44b3b790b'),
  ('application_recheck_native_task_write_intent()','7e5016040ba60e44ab5872f595ec78d2fcc46a879d1c6de0477afa27b020c6a5')) AS expected(signature,body_hash) LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=('public.'||entry.signature)::regprocedure;
  IF encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') IS DISTINCT FROM entry.body_hash
   OR p.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.tasks'::regclass)
   OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql') OR p.prokind<>'f'
   OR NOT p.prosecdef OR p.provolatile<>'v' OR p.proretset OR p.proisstrict OR p.proleakproof OR p.proparallel<>'u'
   OR p.proargmodes IS NOT NULL OR p.proallargtypes IS NOT NULL OR p.pronargdefaults<>0 OR p.provariadic<>0
   OR p.prorettype<>(CASE WHEN entry.signature LIKE 'application_record_native_task_write_intent(%' THEN 'void'::regtype ELSE 'trigger'::regtype END)
   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)
   THEN RAISE EXCEPTION 'Native task review prerequisite changed: %',entry.signature;END IF;
 END LOOP;
 -- Baseline table ACLs may include app_user defaults; the existing ledger is
 -- private through enabled RLS with no policies. Preserve that exact boundary.
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.application_native_task_write_intents'::regclass
  AND c.relowner=(SELECT relowner FROM pg_class WHERE oid='public.tasks'::regclass) AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND NOT EXISTS(SELECT 1 FROM pg_policy policy_row WHERE policy_row.polrelid=c.oid)) THEN
  RAISE EXCEPTION 'Native task intent ledger policy changed';END IF;
END $migration$;
ALTER TABLE application_native_task_write_intents ADD COLUMN native_review jsonb
 CHECK(native_review IS NULL OR jsonb_typeof(native_review)='object');

-- Current administrative context, never a business-field permission result.
-- Take current role locks before any epoch lock; absent historical epochs fail closed.
CREATE FUNCTION application_native_task_review_current(w uuid,administrator uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE revision text;context jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.tasks'::regclass
   WHERE r.rolname=session_user AND r.oid=c.relowner)
  OR nullif(current_setting('app.scope_review_actor',true),'') IS DISTINCT FROM administrator::text
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.current_user_id',true),'') IS NOT NULL AND current_setting('app.current_user_id',true)<>administrator::text THEN
  RAISE EXCEPTION 'access_unavailable: native review identity unavailable' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=administrator AND m.role IN('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable: current administrator required' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM application_native_role_assignments r WHERE r.workspace_id=w AND r.module_key='native' AND r.status='active' ORDER BY r.id FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM application_policy_workspace_epochs e WHERE e.workspace_id=w)
  OR NOT EXISTS(SELECT 1 FROM application_policy_contract_epoch) THEN
  RAISE EXCEPTION 'access_unavailable: native review epoch missing' USING ERRCODE='42501';END IF;
 revision:=application_native_task_write_policy_revision(w);
 IF revision IS NULL THEN RAISE EXCEPTION 'access_unavailable: native review policy unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_object_agg(name,to_jsonb(nullif(current_setting(name,true),''))) INTO context FROM unnest(ARRAY[
  'app.current_user_id','app.application_id','app.application_assistant_id','app.v2_assistant_id','app.application_command_key',
  'app.agent_workspace_id','app.agent_actor_id','app.agent_assistant_id','app.scope_review_actor','app.system_bypass',
  'app.agent_clearance','app.agent_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_mutation_compartments',
  'app.agent_visibility_assistants','app.v2_active','app.v2_context_department','app.v2_binding','app.v2_cap','app.native_task_write_intent']) name;
 RETURN jsonb_build_object('session',session_user,'contextDigest',application_field_digest(context),'policy',revision);
END $$;
REVOKE ALL ON FUNCTION application_native_task_review_current(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION application_perform_native_task_review(w uuid,review_id uuid,expected_version bigint,payload text,task_id uuid,administrator uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job workspace_scope_reviews;item workspace_scope_review_items;task tasks;after_task tasks;current_state jsonb;record_policy jsonb;binding jsonb;locked_revision bigint;prior_revision bigint;prior_count bigint;
BEGIN
 PERFORM 1 FROM workspaces WHERE id=w FOR UPDATE;
 current_state:=application_native_task_review_current(w,administrator);
 SELECT revision INTO locked_revision FROM workspace_access_policies WHERE workspace_id=w FOR UPDATE;
 SELECT * INTO job FROM workspace_scope_reviews r WHERE r.workspace_id=w AND r.id=review_id AND r.application_assistant_id IS NULL FOR UPDATE;
 IF NOT FOUND OR job.resource_kind<>'task' OR job.action NOT IN('assign_team','consolidate_default')
  OR job.status NOT IN('preview','running') OR job.version<>expected_version OR job.payload_hash IS DISTINCT FROM payload
  OR job.action='consolidate_default' AND (job.expires_at IS NULL OR job.expires_at<=clock_timestamp()) THEN
  RAISE EXCEPTION 'access_unavailable: saved native review unavailable' USING ERRCODE='42501';END IF;
 SELECT count(*),max((i.native_review->>'policyRevisionAfter')::bigint) INTO prior_count,prior_revision
 FROM application_native_task_write_intents i WHERE i.transaction_id=txid_current() AND i.backend_pid=pg_backend_pid()
  AND i.workspace_id=w AND i.native_review->>'reviewId'=job.id::text;
 IF prior_count=0 AND job.policy_revision IS DISTINCT FROM locked_revision
  OR prior_count>0 AND (prior_revision IS DISTINCT FROM locked_revision OR EXISTS(
   SELECT 1 FROM application_native_task_write_intents i WHERE i.transaction_id=txid_current() AND i.backend_pid=pg_backend_pid()
    AND i.workspace_id=w AND i.native_review->>'reviewId'=job.id::text
    AND (i.native_review->>'phase' IS DISTINCT FROM 'written' OR i.native_review->'current' IS DISTINCT FROM current_state))) THEN
  RAISE EXCEPTION 'access_unavailable: saved task review policy changed' USING ERRCODE='42501';END IF;
 SELECT * INTO item FROM workspace_scope_review_items i WHERE i.workspace_id=w AND i.review_id=job.id AND i.resource_kind='task' AND i.resource_id=task_id FOR UPDATE;
 IF NOT FOUND OR item.status<>'pending' OR item.source_snapshot IS DISTINCT FROM read_scope_review_source(w,'task',task_id)
  OR item.content_snapshot IS DISTINCT FROM read_scope_review_content(w,'task',task_id) THEN
  RAISE EXCEPTION 'access_unavailable: saved task review changed' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM workspace_groups g WHERE g.workspace_id=w AND g.id=job.target_team_id AND g.compartment_key=job.target_compartment AND g.kind='team' AND g.status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable: saved task target unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO task FROM tasks t WHERE t.workspace_id=w AND t.id=task_id AND NOT t.scope_held AND t.valid_to IS NULL AND t.retracted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR task.scope_version::text IS DISTINCT FROM item.resource_version
  OR job.action='assign_team' AND cardinality(task.compartments)<>0 THEN
  RAISE EXCEPTION 'access_unavailable: saved task source unavailable' USING ERRCODE='42501';END IF;
 record_policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}','task',task_id::text);
 IF record_policy->>'registered' IS DISTINCT FROM 'false' AND
  (record_policy->>'registered' IS DISTINCT FROM 'true' OR record_policy->>'held' IS DISTINCT FROM 'false') THEN
  RAISE EXCEPTION 'access_unavailable: task record restriction unavailable' USING ERRCODE='42501';END IF;
 binding:=jsonb_build_object('reviewId',job.id,'expectedVersion',expected_version,'payloadHash',payload,'administrator',administrator,
  'target',job.target_compartment,'beforeSource',item.source_snapshot,'beforeDigest',application_field_digest(to_jsonb(task)),
  'unchangedDigest',application_field_digest(to_jsonb(task)-ARRAY['compartments','scope_version','updated_at']),
  'current',current_state,'phase','prepared');
 INSERT INTO application_native_task_write_intents(transaction_id,backend_pid,workspace_id,logical_id,physical_id,source_version,action,actor_user_id,policy_revision,fields,native_review)
 VALUES(txid_current(),pg_backend_pid(),w,task.logical_id,task.id,task.scope_version+1,'patch',administrator,current_state->>'policy','{}',binding);
 UPDATE tasks SET compartments=ARRAY[job.target_compartment] WHERE workspace_id=w AND id=task.id RETURNING * INTO after_task;
 IF NOT FOUND OR after_task.scope_version<>task.scope_version+1 OR after_task.compartments IS DISTINCT FROM ARRAY[job.target_compartment]
  OR application_field_digest(to_jsonb(after_task)-ARRAY['compartments','scope_version','updated_at']) IS DISTINCT FROM binding->>'unchangedDigest' THEN
  RAISE EXCEPTION 'access_unavailable: task classification changed other fields' USING ERRCODE='42501';END IF;
 record_policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}','task',task_id::text);
 IF record_policy->>'registered' IS DISTINCT FROM 'false' AND
  (record_policy->>'registered' IS DISTINCT FROM 'true' OR record_policy->>'held' IS DISTINCT FROM 'false') THEN
  RAISE EXCEPTION 'access_unavailable: task record restriction changed' USING ERRCODE='42501';END IF;
 UPDATE application_native_task_write_intents i SET native_review=i.native_review||jsonb_build_object('phase','written',
  'afterDigest',application_field_digest(to_jsonb(after_task)),'afterSource',read_scope_review_source(w,'task',task_id),
  'recordPolicy',application_field_digest(record_policy),'policyRevisionAfter',(SELECT p.revision FROM workspace_access_policies p WHERE p.workspace_id=w))
 WHERE i.transaction_id=txid_current() AND i.backend_pid=pg_backend_pid() AND i.workspace_id=w AND i.physical_id=task.id
  AND i.source_version=after_task.scope_version AND i.action='patch' AND i.native_review->>'phase'='admitted';
 IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable: task classification witness not consumed' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION application_perform_native_task_review(uuid,uuid,bigint,text,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION application_finalize_native_task_review(w uuid,review_id uuid,expected_version bigint,payload text,administrator uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job workspace_scope_reviews;current_state jsonb;next_state jsonb;before_policy jsonb;after_policy jsonb;entry application_native_task_write_intents;counted integer:=0;written_revision bigint;
BEGIN
 PERFORM 1 FROM workspaces WHERE id=w FOR UPDATE;
 current_state:=application_native_task_review_current(w,administrator);
 SELECT to_jsonb(p) INTO before_policy FROM workspace_access_policies p WHERE p.workspace_id=w FOR UPDATE;
 SELECT * INTO job FROM workspace_scope_reviews r WHERE r.workspace_id=w AND r.id=review_id AND r.application_assistant_id IS NULL FOR UPDATE;
 IF NOT FOUND OR job.version<>expected_version OR job.payload_hash IS DISTINCT FROM payload OR job.resource_kind<>'task'
  OR job.action NOT IN('assign_team','consolidate_default') OR job.status NOT IN('preview','running') THEN
  RAISE EXCEPTION 'access_unavailable: native review finalization unavailable' USING ERRCODE='42501';END IF;
 -- Reuse the policy UPDATE's existing policy -> epoch order. Fresh VOLATILE
 -- checks after waits cannot rebase an unrelated contraction into this page.
 PERFORM 1 FROM application_policy_contract_epoch FOR SHARE;
 PERFORM 1 FROM application_policy_workspace_epochs e WHERE e.workspace_id=w FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable: native review epoch missing' USING ERRCODE='42501';END IF;
 current_state:=application_native_task_review_current(w,administrator);
 FOR entry IN SELECT i.* FROM application_native_task_write_intents i WHERE i.transaction_id=txid_current() AND i.backend_pid=pg_backend_pid()
  AND i.workspace_id=w AND i.native_review->>'reviewId'=review_id::text FOR UPDATE LOOP
  IF entry.native_review->>'phase' IS DISTINCT FROM 'written' OR entry.native_review->>'expectedVersion' IS DISTINCT FROM expected_version::text
   OR entry.native_review->>'payloadHash' IS DISTINCT FROM payload OR entry.native_review->'current' IS DISTINCT FROM current_state THEN
   RAISE EXCEPTION 'access_unavailable: native review policy changed before finalization' USING ERRCODE='42501';END IF;
  counted:=counted+1;written_revision:=greatest(written_revision,(entry.native_review->>'policyRevisionAfter')::bigint);
 END LOOP;
 IF counted=0 OR written_revision IS DISTINCT FROM (before_policy->>'revision')::bigint THEN RAISE EXCEPTION 'access_unavailable: native review witness or policy changed' USING ERRCODE='42501';END IF;
 UPDATE workspace_access_policies SET classification_mode=CASE WHEN classification_mode='legacy' AND job.action NOT IN('consolidate_default','release') THEN 'review' ELSE classification_mode END,
  revision=revision+1,updated_at=now() WHERE workspace_id=w RETURNING to_jsonb(workspace_access_policies.*) INTO after_policy;
 IF before_policy-ARRAY['classification_mode','revision','updated_at'] IS DISTINCT FROM after_policy-ARRAY['classification_mode','revision','updated_at']
  OR after_policy->>'classification_mode' IS DISTINCT FROM (CASE WHEN before_policy->>'classification_mode'='legacy' AND job.action='assign_team' THEN 'review' ELSE before_policy->>'classification_mode' END) THEN
  RAISE EXCEPTION 'access_unavailable: native review self policy transition changed' USING ERRCODE='42501';END IF;
 next_state:=application_native_task_review_current(w,administrator);
 UPDATE application_native_task_write_intents i SET policy_revision=next_state->>'policy',native_review=i.native_review||jsonb_build_object('phase','finalized','current',next_state)
 WHERE i.transaction_id=txid_current() AND i.backend_pid=pg_backend_pid() AND i.workspace_id=w AND i.native_review->>'reviewId'=review_id::text;
END $$;
REVOKE ALL ON FUNCTION application_finalize_native_task_review(uuid,uuid,bigint,text,uuid) FROM PUBLIC;

CREATE FUNCTION application_recheck_native_task_review(pending application_native_task_write_intents) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE binding jsonb:=pending.native_review;stored tasks;job workspace_scope_reviews;item workspace_scope_review_items;record_policy jsonb;administrator uuid:=(binding->>'administrator')::uuid;
BEGIN
 IF pending.transaction_id<>txid_current() OR pending.backend_pid<>pg_backend_pid() OR pending.action<>'patch' OR pending.fields<>'{}'::text[]
  OR pending.actor_user_id<>administrator OR binding->>'phase' IS DISTINCT FROM 'finalized'
  OR binding->'current' IS DISTINCT FROM application_native_task_review_current(pending.workspace_id,administrator) THEN
  RAISE EXCEPTION 'access_unavailable: task review finalization or context missing' USING ERRCODE='42501';END IF;
 SELECT * INTO stored FROM tasks t WHERE t.workspace_id=pending.workspace_id AND t.id=pending.physical_id;
 IF NOT FOUND OR stored.logical_id<>pending.logical_id OR stored.scope_version<>pending.source_version
  OR stored.valid_to IS NOT NULL OR stored.retracted_at IS NOT NULL OR stored.scope_held
  OR application_task_live_id(pending.workspace_id,pending.logical_id) IS DISTINCT FROM stored.id
  OR application_field_digest(to_jsonb(stored)) IS DISTINCT FROM binding->>'afterDigest'
  OR read_scope_review_source(pending.workspace_id,'task',stored.id) IS DISTINCT FROM binding->'afterSource' THEN
  RAISE EXCEPTION 'access_unavailable: classified task changed' USING ERRCODE='42501';END IF;
 SELECT * INTO job FROM workspace_scope_reviews r WHERE r.workspace_id=pending.workspace_id AND r.id=(binding->>'reviewId')::uuid AND r.application_assistant_id IS NULL;
 IF NOT FOUND OR job.resource_kind<>'task' OR job.action NOT IN('assign_team','consolidate_default')
  OR job.version<>(binding->>'expectedVersion')::bigint+1 OR job.status NOT IN('running','complete','stale')
  OR job.payload_hash IS DISTINCT FROM binding->>'payloadHash' OR job.target_compartment IS DISTINCT FROM binding->>'target'
  OR job.policy_revision IS DISTINCT FROM (SELECT p.revision FROM workspace_access_policies p WHERE p.workspace_id=pending.workspace_id) THEN
  RAISE EXCEPTION 'access_unavailable: task review outcome missing' USING ERRCODE='42501';END IF;
 SELECT * INTO item FROM workspace_scope_review_items i WHERE i.workspace_id=pending.workspace_id AND i.review_id=job.id AND i.resource_kind='task' AND i.resource_id=stored.id;
 IF NOT FOUND OR item.status<>'applied' OR item.result_version IS DISTINCT FROM pending.source_version::text
  OR item.source_snapshot IS DISTINCT FROM binding->'beforeSource'
  OR NOT EXISTS(SELECT 1 FROM scope_resource_states s WHERE s.workspace_id=pending.workspace_id AND s.resource_kind='task' AND s.resource_id=stored.id
   AND s.resource_version=pending.source_version::text AND s.review_state='reviewed') THEN
  RAISE EXCEPTION 'access_unavailable: task review item missing' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM workspace_access_events e
  CROSS JOIN LATERAL (SELECT txid_current() AS top_xid) x
  CROSS JOIN LATERAL (SELECT mod(e.xmin::text::bigint-mod(x.top_xid,4294967296::bigint)+4294967296::bigint,4294967296::bigint) AS distance) child
  WHERE e.workspace_id=pending.workspace_id AND e.actor_user_id=administrator
  AND e.kind='scope.review.apply' AND e.subject_id=job.id AND e.policy_revision=job.policy_revision
  -- Own visible in-progress tuples include released SAVEPOINT children; their
  -- transactionid lock no longer exists. Lift only forward child XIDs within
  -- the transaction's half-range horizon; never depend on age()'s cached reference.
  -- Committed historical tuples are not current-transaction audit evidence.
  AND CASE WHEN e.changes @> jsonb_build_object('payloadHash',job.payload_hash,'applied',jsonb_build_array(jsonb_build_object('before',binding->'beforeSource','after',binding->'afterSource')))
   THEN CASE WHEN child.distance<2147483648::bigint THEN pg_xact_status((x.top_xid+child.distance)::text::xid8)='in progress' ELSE false END
   ELSE false END) THEN
  RAISE EXCEPTION 'access_unavailable: task review page audit missing' USING ERRCODE='42501';END IF;
 record_policy:=application_native_field_contract_for(pending.workspace_id,'{"kind":"native","moduleKey":"native"}','task',stored.id::text);
 IF application_field_digest(record_policy) IS DISTINCT FROM binding->>'recordPolicy'
  OR record_policy->>'registered' IS DISTINCT FROM 'false' AND (record_policy->>'registered' IS DISTINCT FROM 'true' OR record_policy->>'held' IS DISTINCT FROM 'false') THEN
  RAISE EXCEPTION 'access_unavailable: classified task restriction changed' USING ERRCODE='42501';END IF;
 DELETE FROM application_native_task_write_intents i WHERE i.transaction_id=pending.transaction_id AND i.backend_pid=pending.backend_pid
  AND i.workspace_id=pending.workspace_id AND i.physical_id=pending.physical_id AND i.source_version=pending.source_version AND i.action=pending.action;
END $$;
REVOKE ALL ON FUNCTION application_recheck_native_task_review(application_native_task_write_intents) FROM PUBLIC;

-- Amend the three existing consumers in place: fixed predecessor body checks
-- above and exact metadata equality below preserve OIDs/owner/ACL/properties.
DO $migration$
DECLARE target oid;definition text;metadata jsonb;before text;replacement text;
BEGIN
 target:='public.application_record_native_task_write_intent(tasks,text[],text)'::regprocedure;
 before:=$source$ WHERE application_native_task_write_intents.actor_user_id=EXCLUDED.actor_user_id$source$;
 replacement:=$source$ WHERE application_native_task_write_intents.native_review IS NULL
  AND application_native_task_write_intents.actor_user_id=EXCLUDED.actor_user_id$source$;
 SELECT pg_get_functiondef(target),to_jsonb(p)-'prosrc' INTO definition,metadata FROM pg_proc p WHERE p.oid=target;
 IF length(definition)-length(replace(definition,before,''))<>length(before) THEN RAISE EXCEPTION 'Native task recorder seam changed';END IF;
 EXECUTE replace(definition,before,replacement);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=target) IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'Native task recorder metadata changed';END IF;
 target:='public.application_force_native_task_written_field()'::regprocedure;
 before:=$source$ state:=application_task_patch_state(OLD.workspace_id,OLD.id,CASE WHEN key='' THEN '{}'::text[] ELSE ARRAY[key] END);
 IF state IS NULL THEN RAISE EXCEPTION 'access_unavailable: canonical task field unavailable' USING ERRCODE='42501';END IF;
 IF NEW.scope_version=OLD.scope_version THEN NEW.scope_version:=OLD.scope_version+1;NEW.updated_at:=clock_timestamp();END IF;
 PERFORM application_record_native_task_write_intent(NEW,CASE WHEN key='' THEN '{}'::text[] ELSE ARRAY[key] END,'patch');RETURN NEW;$source$;
 replacement:=$source$ IF TG_NAME='zz_application_task_field_compartments' AND key='' THEN
  UPDATE application_native_task_write_intents i SET native_review=i.native_review||'{"phase":"admitted"}'::jsonb
  WHERE i.transaction_id=txid_current() AND i.backend_pid=pg_backend_pid() AND i.workspace_id=OLD.workspace_id
   AND i.logical_id=OLD.logical_id AND i.physical_id=OLD.id AND i.source_version=OLD.scope_version+1 AND i.action='patch' AND i.fields='{}'::text[]
   AND i.native_review->>'phase'='prepared' AND i.native_review->>'beforeDigest'=application_field_digest(to_jsonb(OLD))
   AND i.native_review->>'unchangedDigest'=application_field_digest(to_jsonb(NEW)-ARRAY['compartments','scope_version','updated_at'])
   AND NEW.compartments=ARRAY[i.native_review->>'target']
   AND NEW.scope_version IN(OLD.scope_version,OLD.scope_version+1)
   AND i.native_review->'current'=application_native_task_review_current(OLD.workspace_id,i.actor_user_id);
  review_admitted:=FOUND;
 END IF;
 IF NOT review_admitted THEN
  state:=application_task_patch_state(OLD.workspace_id,OLD.id,CASE WHEN key='' THEN '{}'::text[] ELSE ARRAY[key] END);
  IF state IS NULL THEN RAISE EXCEPTION 'access_unavailable: canonical task field unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF NEW.scope_version=OLD.scope_version THEN NEW.scope_version:=OLD.scope_version+1;NEW.updated_at:=clock_timestamp();END IF;
 IF NOT review_admitted THEN PERFORM application_record_native_task_write_intent(NEW,CASE WHEN key='' THEN '{}'::text[] ELSE ARRAY[key] END,'patch');END IF;
 RETURN NEW;$source$;
 SELECT pg_get_functiondef(target),to_jsonb(p)-'prosrc' INTO definition,metadata FROM pg_proc p WHERE p.oid=target;
 IF length(definition)-length(replace(definition,before,''))<>length(before)
  OR length(definition)-length(replace(definition,'DECLARE state jsonb;key text:=TG_ARGV[0];',''))<>length('DECLARE state jsonb;key text:=TG_ARGV[0];') THEN RAISE EXCEPTION 'Native task field seam changed';END IF;
 EXECUTE replace(replace(definition,before,replacement),'DECLARE state jsonb;key text:=TG_ARGV[0];','DECLARE state jsonb;key text:=TG_ARGV[0];review_admitted boolean:=false;');
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=target) IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'Native task field metadata changed';END IF;
 target:='public.application_recheck_native_task_write_intent()'::regprocedure;
 before:=$source$ IF NOT FOUND THEN RETURN NULL;END IF;
 IF pending.transaction_id<>txid_current()$source$;
 replacement:=$source$ IF NOT FOUND THEN RETURN NULL;END IF;
 IF pending.native_review IS NOT NULL THEN PERFORM application_recheck_native_task_review(pending);RETURN NULL;END IF;
 IF pending.transaction_id<>txid_current()$source$;
 SELECT pg_get_functiondef(target),to_jsonb(p)-'prosrc' INTO definition,metadata FROM pg_proc p WHERE p.oid=target;
 IF length(definition)-length(replace(definition,before,''))<>length(before) THEN RAISE EXCEPTION 'Native task deferred seam changed';END IF;
 EXECUTE replace(definition,before,replacement);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=target) IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'Native task deferred metadata changed';END IF;
END $migration$;
COMMIT;
