BEGIN;
-- [COMP:api/application-persistence] Retain initial qualification and one complete
-- independent final proof. No permission result crosses a capture boundary.
DO $capture$
DECLARE actual pg_proc;pins text;trusted text;pin_count integer;trigger_state jsonb;table_state jsonb;shape_sql text;body text;
 fk_state jsonb;fk_query text;previous_pins jsonb;change record;
 original text;definition text;updated text;before text;after text;metadata jsonb;
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
 IF body IS DISTINCT FROM (SELECT prosrc FROM pg_proc WHERE oid='application_native_dependency_batch_helpers_current()'::regprocedure) THEN RAISE EXCEPTION 'Native field reference dependency guard changed';END IF;
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid) INTO pins
 FROM pg_proc p WHERE p.oid IN(
 'read_native_field_reference_snapshot(uuid,uuid,uuid,text)'::regprocedure,
 'validate_scope_resource_reference()'::regprocedure,
 'application_current_field_snapshot(uuid,uuid)'::regprocedure,
 'read_scope_source(uuid,text,uuid)'::regprocedure,
 'recording_source_read_allowed(uuid,text,uuid)'::regprocedure,
 'application_native_dependency_batch_helpers_current()'::regprocedure,
 'application_native_file_capture_helpers_current()'::regprocedure,
 'application_memory_statement_helpers_current()'::regprocedure);
 fk_query:=$fk$SELECT jsonb_build_object(
 'constraint',(SELECT to_jsonb(c) FROM pg_catalog.pg_constraint c WHERE c.conrelid='public.scope_derivation_sources'::regclass AND c.conname='scope_derivation_sources_workspace_id_derivation_id_fkey'),
 'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=(SELECT c.oid FROM pg_catalog.pg_constraint c WHERE c.conrelid='public.scope_derivation_sources'::regclass AND c.conname='scope_derivation_sources_workspace_id_derivation_id_fkey')),
 'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_proc p WHERE p.oid IN(SELECT t.tgfoid FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=(SELECT c.oid FROM pg_catalog.pg_constraint c WHERE c.conrelid='public.scope_derivation_sources'::regclass AND c.conname='scope_derivation_sources_workspace_id_derivation_id_fkey'))),
 'relations',(SELECT jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl,c.relkind,c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.oid IN('public.scope_derivation_sources'::regclass,'public.scope_derivations'::regclass)),
 'rules',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid) FROM pg_catalog.pg_rewrite r WHERE r.ev_class IN('public.scope_derivation_sources'::regclass,'public.scope_derivations'::regclass)))$fk$;
 EXECUTE fk_query INTO fk_state;
 body:='BEGIN
 IF (SELECT count(*)=8 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
 FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
 IF ('||fk_query||') IS DISTINCT FROM '||quote_literal(fk_state::text)||'::jsonb THEN RETURN false;END IF;
 RETURN application_native_dependency_batch_helpers_current();
 END';
 IF body IS DISTINCT FROM (SELECT prosrc FROM pg_proc WHERE oid='application_native_field_reference_helpers_current()'::regprocedure) THEN RAISE EXCEPTION 'File final proof reference guard changed';END IF;
 FOR actual IN SELECT * FROM pg_proc WHERE oid IN(
 'application_native_dependency_batch_helpers_current()'::regprocedure,
 'application_native_field_reference_helpers_current()'::regprocedure) LOOP
 IF actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proname'] IS DISTINCT FROM $guard_metadata${"probin":null,"procost":100,"prokind":"f","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$guard_metadata$::jsonb
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
 WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'File final proof guard metadata changed: %',actual.oid::regprocedure;END IF;
 END LOOP;
 IF application_empty_query_helpers_current() IS NOT TRUE
 OR application_native_file_capture_helpers_current() IS NOT TRUE
 OR application_native_dependency_batch_helpers_current() IS NOT TRUE
 OR application_native_field_reference_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'File final proof canonical prerequisites changed';END IF;
 SELECT jsonb_object_agg(oid::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')) INTO previous_pins
 FROM pg_proc p WHERE oid IN('capture_native_session_projection_batch(uuid,uuid,integer,text)'::regprocedure,
 'application_native_file_capture_helpers_current()'::regprocedure,'application_native_dependency_batch_helpers_current()'::regprocedure);
 SELECT * INTO actual FROM pg_proc WHERE oid='capture_native_session_projection_batch(uuid,uuid,integer,text)'::regprocedure;
 IF encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM 'fbf98052b401d35fb33c70a99b1986b95c02308f4c50fd39eaf39998dc6f10d4'
  OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
  OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace'] IS DISTINCT FROM $metadata${"probin":null,"procost":100,"prokind":"f","proname":"capture_native_session_projection_batch","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","through","t"],"proargtypes":["2950","2950","23","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$metadata$::jsonb
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) acl
   WHERE acl.grantee<>actual.proowner OR acl.grantor<>actual.proowner OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable) THEN
  RAISE EXCEPTION 'File final proof capture prerequisite changed';END IF;
 original:=actual.prosrc;definition:=pg_get_functiondef(actual.oid);metadata:=to_jsonb(actual)-'prosrc';updated:=original;
 before:=$before0$file_frame boolean:=false;$before0$;
 after:=$after0$file_frame boolean:=false;file_final_proof boolean:=false;file_final_frame jsonb;file_reader_context jsonb;file_final_lineage jsonb;$after0$;
 IF length(updated)-length(replace(updated,before,''))<>length(before) THEN RAISE EXCEPTION 'File final proof capture splice changed';END IF;
 updated:=replace(updated,before,after);
 before:=$before1$     frame_result:=read_native_file_session_cohort_frame(w,frame_kinds,frame_ids,frame_versions,true);$before1$;
 after:=$after1$     file_reader_context:=jsonb_build_object('sessionUser',session_user,'currentUser',current_user,'settings',(SELECT jsonb_object_agg(setting_name,current_setting(setting_name,true)) FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']) setting_name));
     frame_result:=read_native_file_session_cohort_frame(w,frame_kinds,frame_ids,frame_versions,true);
 IF jsonb_build_object('sessionUser',session_user,'currentUser',current_user,'settings',(SELECT jsonb_object_agg(setting_name,current_setting(setting_name,true)) FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']) setting_name)) IS DISTINCT FROM file_reader_context THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;$after1$;
 IF length(updated)-length(replace(updated,before,''))<>length(before) THEN RAISE EXCEPTION 'File final proof capture splice changed';END IF;
 updated:=replace(updated,before,after);
 before:=$before2$ -- Discard the entire buffered batch on a changed file frame. The outer
 -- projection reader then runs its unchanged generic capture from fresh data.
 IF file_frame THEN
  IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
  IF application_native_file_frame_current(w,frame_kinds,frame_ids,frame_versions,frame_result) IS NOT TRUE THEN RETURN NULL;END IF;
 END IF;
 PERFORM application_materialize_field_envelope(w,envelope);$before2$;
 after:=$after2$ -- The initial proof already qualified selected fields and buffered payload.
 -- Bounded captures receive one independent final proof after materialization.
 -- Larger captures retain the original pre-materialization and snapshot path.
 file_final_proof:=file_frame AND jsonb_array_length(coalesce(envelope->'children','[]'))<100;
 IF file_frame THEN
  IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
  IF file_final_proof THEN
 IF jsonb_build_object('sessionUser',session_user,'currentUser',current_user,'settings',(SELECT jsonb_object_agg(setting_name,current_setting(setting_name,true)) FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']) setting_name)) IS DISTINCT FROM file_reader_context THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   -- Preserve the original pre-write discard when the covered graph changes.
   -- This bounded metadata comparison grants no permission or selected value.
   BEGIN
    SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO file_final_lineage
     FROM application_scope_lineage(w,frame_kinds,frame_ids,frame_versions) n;
   EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM='scope_ancestry_unavailable' THEN RETURN NULL;END IF;
    RAISE;
   END;
   IF file_final_lineage IS DISTINCT FROM frame_result->'lineage' THEN RETURN NULL;END IF;
  ELSIF application_native_file_frame_current(w,frame_kinds,frame_ids,frame_versions,frame_result) IS NOT TRUE THEN RETURN NULL;END IF;
 END IF;
 PERFORM application_materialize_field_envelope(w,envelope);$after2$;
 IF length(updated)-length(replace(updated,before,''))<>length(before) THEN RAISE EXCEPTION 'File final proof capture splice changed';END IF;
 updated:=replace(updated,before,after);
 before:=$before3$ -- This new call owns a fresh private worklist. No initial admission is reused.
 IF file_frame THEN
  IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 FOR snap IN SELECT * FROM read_native_file_session_field_snapshots(w,ids,versions) ORDER BY ord LOOP
  position:=position+1;expected:=captures->(position-1);
  IF snap.ord IS DISTINCT FROM position OR snap.snapshot IS NULL OR snap.snapshot->>'held' IS DISTINCT FROM 'false'
   OR snap.snapshot->>'version' IS DISTINCT FROM expected#>>'{source,version}' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 ELSE
 FOR snap IN SELECT * FROM read_native_session_field_snapshots(w,ids,versions) ORDER BY ord LOOP
  position:=position+1;expected:=captures->(position-1);
  IF snap.ord IS DISTINCT FROM position OR snap.snapshot IS NULL OR snap.snapshot->>'held' IS DISTINCT FROM 'false'
   OR snap.snapshot->>'version' IS DISTINCT FROM expected#>>'{source,version}' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 END IF;
$before3$;
 after:=$after3$ -- This final call creates a new proof for every materialized domain/child.
 -- Its complete current sources already are the independent field snapshots.
 IF file_final_proof THEN
 IF jsonb_build_object('sessionUser',session_user,'currentUser',current_user,'settings',(SELECT jsonb_object_agg(setting_name,current_setting(setting_name,true)) FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']) setting_name)) IS DISTINCT FROM file_reader_context THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
  file_final_frame:=read_native_file_session_cohort_frame(w,
   ARRAY(SELECT 'application_field'::text FROM unnest(ids)),ids,versions,true);
 IF jsonb_build_object('sessionUser',session_user,'currentUser',current_user,'settings',(SELECT jsonb_object_agg(setting_name,current_setting(setting_name,true)) FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']) setting_name)) IS DISTINCT FROM file_reader_context THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
  IF file_final_frame->>'admitted'='true'
   AND file_final_frame#>>'{memo,memoryStatement,workspaceId}'=w::text THEN
   IF jsonb_typeof(file_final_frame->'current') IS DISTINCT FROM 'array'
    OR file_final_frame#>'{memo,memoryStatement,context}' IS DISTINCT FROM frame_result#>'{memo,memoryStatement,context}' THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   FOR expected IN SELECT value FROM jsonb_array_elements(captures) LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(file_final_frame->'current') current_source
     WHERE current_source=expected->'source') THEN
     RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
    position:=position+1;
   END LOOP;
  ELSE
   -- Preserve the original independent reader on an unsupported/denied frame.
   -- A returned held or changed snapshot still raises the original refusal.
 FOR snap IN SELECT * FROM read_native_session_field_snapshots(w,ids,versions) ORDER BY ord LOOP
  position:=position+1;expected:=captures->(position-1);
  IF snap.ord IS DISTINCT FROM position OR snap.snapshot IS NULL OR snap.snapshot->>'held' IS DISTINCT FROM 'false'
   OR snap.snapshot->>'version' IS DISTINCT FROM expected#>>'{source,version}' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
   IF application_memory_query_context(w) IS DISTINCT FROM frame_result#>'{memo,memoryStatement,context}' THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  END IF;
 IF jsonb_build_object('sessionUser',session_user,'currentUser',current_user,'settings',(SELECT jsonb_object_agg(setting_name,current_setting(setting_name,true)) FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']) setting_name)) IS DISTINCT FROM file_reader_context THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 ELSE
 IF file_frame THEN
  IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 FOR snap IN SELECT * FROM read_native_file_session_field_snapshots(w,ids,versions) ORDER BY ord LOOP
  position:=position+1;expected:=captures->(position-1);
  IF snap.ord IS DISTINCT FROM position OR snap.snapshot IS NULL OR snap.snapshot->>'held' IS DISTINCT FROM 'false'
   OR snap.snapshot->>'version' IS DISTINCT FROM expected#>>'{source,version}' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 ELSE
 FOR snap IN SELECT * FROM read_native_session_field_snapshots(w,ids,versions) ORDER BY ord LOOP
  position:=position+1;expected:=captures->(position-1);
  IF snap.ord IS DISTINCT FROM position OR snap.snapshot IS NULL OR snap.snapshot->>'held' IS DISTINCT FROM 'false'
   OR snap.snapshot->>'version' IS DISTINCT FROM expected#>>'{source,version}' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 END IF;
 END IF;
$after3$;
 IF length(updated)-length(replace(updated,before,''))<>length(before) THEN RAISE EXCEPTION 'File final proof capture splice changed';END IF;
 updated:=replace(updated,before,after);
 EXECUTE replace(definition,original,updated);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=actual.oid) IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'File final proof capture metadata changed';END IF;
 -- Only the reviewed capture row and its three dependent guards change.
 FOR change IN SELECT * FROM (VALUES
 ('application_native_file_capture_helpers_current()'::regprocedure,'capture_native_session_projection_batch(uuid,uuid,integer,text)'::regprocedure),
 ('application_native_dependency_batch_helpers_current()'::regprocedure,'application_native_file_capture_helpers_current()'::regprocedure),
 ('application_native_field_reference_helpers_current()'::regprocedure,'application_native_file_capture_helpers_current()'::regprocedure),
 ('application_native_field_reference_helpers_current()'::regprocedure,'application_native_dependency_batch_helpers_current()'::regprocedure)) changes(target,dependency) LOOP
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO original,definition,metadata FROM pg_proc p WHERE oid=change.target;
 before:=previous_pins->>change.dependency::oid::text;
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO after FROM pg_proc p WHERE oid=change.dependency;
 IF before IS NULL OR after IS NULL OR before=after
 OR length(original)-length(replace(original,before,''))<>length(before) THEN
 RAISE EXCEPTION 'File final proof dependency fingerprint changed: %',change.target;END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=change.target) IS DISTINCT FROM metadata THEN
 RAISE EXCEPTION 'File final proof guard metadata changed';END IF;
 END LOOP;
 IF application_empty_query_helpers_current() IS NOT TRUE
 OR application_native_file_capture_helpers_current() IS NOT TRUE
 OR application_native_dependency_batch_helpers_current() IS NOT TRUE
 OR application_native_field_reference_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'File final proof final guards failed';END IF;
END $capture$;
COMMIT;
