-- [COMP:api/native-turn-frame] Bind each generic source-edge lookup to its narrow derivation parent.
BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;

DO $scope_derivation_parent_lookup$
DECLARE
 dispatch_signature constant text:='application_native_source_edges_dispatch(uuid,text,uuid,text)';
 lineage_signature constant text:='application_scope_lineage(uuid,text[],uuid[],text[])';
 worklist_signature constant text:='application_native_worklist_helpers_current()';
 file_frame_signature constant text:='read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)';
 file_evidence_signature constant text:='read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)';
 file_guard_signature constant text:='application_native_file_capture_helpers_current()';
 title_group_signature constant text:='application_native_title_group_helpers_current()';
 title_signature constant text:='application_native_title_acquisition_helpers_current()';
 query_stage_signature constant text:='capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)';
 title_evidence_signature constant text:='read_native_personal_title_group_evidence(uuid,uuid[],uuid[])';
 dispatch_before_sha constant text:='e8df0ffdc3f459a5c4bbf6be0703d087ca4e02ad8bf04ce0b0e536dbb82566ca';
 dispatch_after_sha constant text:='d12a3ac064d8a4c490c833755b09830f3d2fbc027fbbc2600194a893acc0bc37';
 signatures constant text[]:=ARRAY[dispatch_signature,lineage_signature,worklist_signature,file_frame_signature,
  file_evidence_signature,file_guard_signature,title_group_signature,title_signature,query_stage_signature,title_evidence_signature];
 before_fingerprints jsonb:='{}';
 after_fingerprints jsonb:='{}';
 retired_fingerprints text[]:='{}';
 routine_signature text;
 pin_signature text;
 dependencies text[];
 pin_count integer;
 registered boolean;
 normalized_source text;
 expected_source text;
 expected_metadata text;
 owner_role oid:=(SELECT relowner FROM pg_class WHERE oid='public.workspaces'::regclass);
 expected_acl aclitem[];
 pinned pg_proc;
 original pg_proc;
 successor pg_proc;
 changed text;
 marker text;
 replacement text;
 before_fingerprint text;
 after_fingerprint text;
 dispatch_oid oid;
 semantic_before text;
 semantic_after text;
BEGIN
 LOCK TABLE public.native_turn_contract_helpers IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
  OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8350_conversation_graph_ordinal_edges.sql')
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE OR public.native_conversation_conversion_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_derivation_lookup_predecessor_changed';END IF;

 FOREACH routine_signature IN ARRAY signatures LOOP
  SELECT * INTO STRICT original FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('public.'||routine_signature);
  changed:=original.prosrc;
  registered:=routine_signature IN(dispatch_signature,lineage_signature,worklist_signature,file_frame_signature,
   file_evidence_signature,file_guard_signature);
  IF EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=routine_signature) IS DISTINCT FROM registered
   OR EXISTS(SELECT 1 FROM public.native_retained_contract_helpers h WHERE h.signature=routine_signature)
   OR EXISTS(SELECT 1 FROM public.private_session_display_contract h WHERE h.signature='public.'||routine_signature)
    IS DISTINCT FROM (routine_signature=lineage_signature)
  THEN RAISE EXCEPTION 'scope_derivation_lookup_registry_changed: %',routine_signature;END IF;
  IF NOT registered THEN
   -- Authenticate the four remaining routines against their 8350 declarations.
   -- Remove only the reviewed installation-local catalog bindings when hashing.
   normalized_source:=changed;
   IF routine_signature IN(title_group_signature,title_signature) THEN
    dependencies:=CASE routine_signature WHEN title_group_signature THEN ARRAY[
     'session_context_revision_allowed(uuid,uuid)','read_session_context_revision(uuid,uuid)',
     'read_session_title_revision(uuid,uuid,uuid)','native_turn_helpers_current()',
     file_evidence_signature,'application_empty_query_helpers_current()','read_native_personal_title_group(uuid,uuid[],uuid[])']
    ELSE ARRAY[lineage_signature,'read_entity_derivation_source(uuid,text,uuid)','session_recording_read_allowed(uuid)',
     'recording_source_read_allowed(uuid,text,uuid)',file_evidence_signature,'read_native_personal_title_group(uuid,uuid[],uuid[])',
     title_group_signature,'native_personal_title_group_acquisition(uuid,uuid[],uuid[])'] END;
    FOREACH pin_signature IN ARRAY dependencies LOOP
     SELECT * INTO STRICT pinned FROM pg_proc WHERE oid=to_regprocedure('public.'||pin_signature);
     marker:=format('(%s::oid,%L::text)',pinned.oid,coalesce(before_fingerprints->>pin_signature,
      encode(sha256(convert_to(to_jsonb(pinned)::text,'UTF8')),'hex')));
     IF (length(normalized_source)-length(replace(normalized_source,marker,'')))/length(marker)<>1
     THEN RAISE EXCEPTION 'scope_derivation_lookup_title_pin_changed: %',pin_signature;END IF;
     normalized_source:=replace(normalized_source,marker,format('(0::oid,%L::text)',repeat('0',64)));
    END LOOP;
   ELSE
    pin_signature:=CASE routine_signature WHEN query_stage_signature THEN file_guard_signature ELSE title_signature END;
    normalized_source:=replace(normalized_source,before_fingerprints->>pin_signature,repeat('0',64));
   END IF;
   expected_source:=CASE routine_signature
    WHEN title_group_signature THEN 'effb3a054d234ec6c494ee11be6148495b769191de90360e7bce837e242f889c'
    WHEN title_signature THEN '24deb72ddfb53344beda034349e2c2690c127293eb0d899ef6581f3c7012ed8a'
    WHEN query_stage_signature THEN '4733080835ab52018e1d4bd3bf529b1b31cd3f0cd6561db430983da0b6b76b86'
    WHEN title_evidence_signature THEN '88577b021f1c3748631865cff7b886b98cb02cbf4d8cd28620de2c14bd9f8f28'
   END;
   expected_metadata:=CASE routine_signature
    WHEN title_group_signature THEN 'ca93e838fc87c3676c4b8b881b01099f61ce86d10d46d03f499b1ae3714139b3'
    WHEN title_signature THEN '0a276b8887d1fa0493d2a9eef6270014c641514f62d0c5a63d7c2bc28bb554d5'
    WHEN query_stage_signature THEN '37911bd8edc4a0533ccc86bd935566df65db36474b3cd0be05f0fcf307a17396'
    WHEN title_evidence_signature THEN '233b796c3911b1080eac5318b39ee1fa79eae97f4aa9dbe94c7e45cf267f153f'
   END;
   expected_acl:=ARRAY[makeaclitem(owner_role,owner_role,'EXECUTE',false)];
   IF routine_signature=title_evidence_signature THEN
    expected_acl:=array_append(expected_acl,makeaclitem('app_user'::regrole,owner_role,'EXECUTE',false));
   END IF;
   IF encode(sha256(convert_to(normalized_source,'UTF8')),'hex') IS DISTINCT FROM expected_source
    OR encode(sha256(convert_to((to_jsonb(original)-ARRAY['oid','prosrc','pronamespace','proowner','proacl','prolang'])::text,'UTF8')),'hex')
     IS DISTINCT FROM expected_metadata
    OR original.pronamespace<>'public'::regnamespace OR original.proowner IS DISTINCT FROM owner_role
    OR original.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
    OR original.proacl IS DISTINCT FROM expected_acl
   THEN RAISE EXCEPTION 'scope_derivation_lookup_legacy_predecessor_changed: %',routine_signature;END IF;
  END IF;
  IF routine_signature=dispatch_signature THEN
   IF encode(sha256(convert_to(changed,'UTF8')),'hex')<>dispatch_before_sha
   THEN RAISE EXCEPTION 'scope_derivation_lookup_dispatch_source_changed';END IF;
   -- A correlated lookup fixes the join order even with stale workspace stats.
   -- Filter child workspace outside the barrier so the lookup uses the derivation ID.
   changed:=replace(changed,$before$FROM scope_derivations d
  JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
  WHERE d.workspace_id=w AND d.resource_kind=k AND d.resource_id=i$before$,$after$FROM public.scope_derivations d
  CROSS JOIN LATERAL (
   SELECT source.workspace_id,source.source_kind,source.source_id,source.source_version
   FROM public.scope_derivation_sources source
   WHERE source.derivation_id=d.id
   OFFSET 0
  ) s
  WHERE d.workspace_id=w AND d.resource_kind=k AND d.resource_id=i AND s.workspace_id=w$after$);
   IF encode(sha256(convert_to(changed,'UTF8')),'hex')<>dispatch_after_sha
   THEN RAISE EXCEPTION 'scope_derivation_lookup_dispatch_result_changed';END IF;
   dispatch_oid:=original.oid;
   semantic_before:=public.application_field_digest(jsonb_build_object('name',original.proname,'namespace',original.pronamespace,
    'body',original.prosrc,'config',original.proconfig,'language',original.prolang,'securityDefiner',original.prosecdef,
    'volatility',original.provolatile,'strict',original.proisstrict,'parallel',original.proparallel));
   semantic_after:=public.application_field_digest(jsonb_build_object('name',original.proname,'namespace',original.pronamespace,
    'body',changed,'config',original.proconfig,'language',original.prolang,'securityDefiner',original.prosecdef,
    'volatility',original.provolatile,'strict',original.proisstrict,'parallel',original.proparallel));
  ELSIF routine_signature=lineage_signature THEN
   IF encode(sha256(convert_to(regexp_replace(changed,$binding$\([0-9]+::oid,'[0-9a-f]{64}'::text\)$binding$,
    format('(0::oid,%L::text)',repeat('0',64)),'g'),'UTF8')),'hex')<>'3481267f130e5877eaf4ed285fef07aa69709a9c9df319f7e65799775a5a87f6'
   THEN RAISE EXCEPTION 'scope_derivation_lookup_lineage_source_changed';END IF;
   marker:=format('(%s::oid,%L::text)',dispatch_oid,semantic_before);
   replacement:=format('(%s::oid,%L::text)',dispatch_oid,semantic_after);
   IF (length(changed)-length(replace(changed,marker,'')))/length(marker)<>1
    OR (length(changed)-length(replace(changed,dispatch_before_sha,'')))/length(dispatch_before_sha)<>1
   THEN RAISE EXCEPTION 'scope_derivation_lookup_lineage_pin_changed';END IF;
   changed:=replace(replace(changed,marker,replacement),dispatch_before_sha,dispatch_after_sha);
  ELSE
   -- These legacy entry points still authenticate their original members.
   -- Propagate only their named catalog pins, in dependency order.
   dependencies:=CASE routine_signature
    WHEN worklist_signature THEN ARRAY[dispatch_signature,lineage_signature]
    WHEN file_frame_signature THEN ARRAY[worklist_signature]
    WHEN file_evidence_signature THEN ARRAY[worklist_signature]
    WHEN file_guard_signature THEN ARRAY[file_frame_signature,file_evidence_signature]
    WHEN title_group_signature THEN ARRAY[file_evidence_signature]
    WHEN title_signature THEN ARRAY[lineage_signature,file_evidence_signature,title_group_signature]
    WHEN query_stage_signature THEN ARRAY[file_guard_signature]
    WHEN title_evidence_signature THEN ARRAY[title_signature]
   END;
   FOREACH pin_signature IN ARRAY dependencies LOOP
    marker:=before_fingerprints->>pin_signature;
    pin_count:=CASE WHEN routine_signature=query_stage_signature THEN 3
     WHEN routine_signature IN(file_frame_signature,file_evidence_signature,title_evidence_signature) THEN 2
     ELSE 1 END;
    IF (length(changed)-length(replace(changed,marker,'')))/length(marker) IS DISTINCT FROM pin_count
    THEN RAISE EXCEPTION 'scope_derivation_lookup_consumer_pin_changed: %',routine_signature;END IF;
    changed:=replace(changed,marker,after_fingerprints->>pin_signature);
   END LOOP;
  END IF;

  EXECUTE replace(pg_get_functiondef(original.oid),original.prosrc,changed);
  SELECT * INTO STRICT successor FROM pg_catalog.pg_proc WHERE oid=original.oid;
  IF to_jsonb(successor) IS DISTINCT FROM jsonb_set(to_jsonb(original),'{prosrc}',to_jsonb(changed))
  THEN RAISE EXCEPTION 'scope_derivation_lookup_metadata_changed: %',routine_signature;END IF;
  before_fingerprint:=encode(sha256(convert_to(to_jsonb(original)::text,'UTF8')),'hex');
  after_fingerprint:=encode(sha256(convert_to(to_jsonb(successor)::text,'UTF8')),'hex');
  before_fingerprints:=before_fingerprints||jsonb_build_object(routine_signature,before_fingerprint);
  after_fingerprints:=after_fingerprints||jsonb_build_object(routine_signature,after_fingerprint);
  retired_fingerprints:=retired_fingerprints||ARRAY[before_fingerprint,md5(original.prosrc),
   encode(sha256(convert_to(original.prosrc,'UTF8')),'hex')];

  IF registered THEN
   UPDATE public.native_turn_contract_helpers h
    SET contract=jsonb_populate_record(h.contract,jsonb_build_object('prosrc',changed))
    WHERE h.signature=routine_signature AND (h.contract).oid=original.oid AND (h.contract).prosrc=original.prosrc;
   IF NOT FOUND THEN RAISE EXCEPTION 'scope_derivation_lookup_registry_changed: %',routine_signature;END IF;
  END IF;
  IF routine_signature=lineage_signature THEN
   UPDATE public.private_session_display_contract h SET fingerprint=after_fingerprint
    WHERE h.signature='public.'||routine_signature AND h.fingerprint=before_fingerprint;
   IF NOT FOUND THEN RAISE EXCEPTION 'scope_derivation_lookup_display_pin_changed';END IF;
  END IF;
 END LOOP;

 IF EXISTS(
  SELECT 1 FROM pg_proc p JOIN unnest(retired_fingerprints||semantic_before) retired(fingerprint)
   ON strpos(p.prosrc,retired.fingerprint)>0
  WHERE p.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(p.pronamespace)
 ) THEN RAISE EXCEPTION 'scope_derivation_lookup_unreviewed_pin';END IF;
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_derivation_lookup_witness_refresh_failed';END IF;
 IF public.native_turn_publication_contract() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE OR public.native_conversation_conversion_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_derivation_lookup_witness_changed';END IF;
END $scope_derivation_parent_lookup$;

-- The reverse source index starts with workspace_id. When the current workspace
-- is absent from planner statistics, that prefix looks cheaper than the actual
-- resource lookup. Give privacy and lineage reads their full equality key.
CREATE INDEX application_field_observation_sources_by_resource
 ON public.application_field_observation_sources(workspace_id,resource_id,version);

COMMIT;
