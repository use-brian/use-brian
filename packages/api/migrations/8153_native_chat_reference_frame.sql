-- [COMP:api/native-chat-read-cost] Every reference gets a fresh private proof.
-- No proof is shared with another trigger invocation or accepted from an app.
BEGIN;
DO $native_reference_frame$
DECLARE target regprocedure:='public.validate_scope_resource_reference()'::regprocedure;
 original text;definition text;metadata jsonb;changed text;triggers jsonb;
 declaration_before constant text:='expected_version text; expected_kind text;';
 declaration_after constant text:='expected_version text; expected_kind text; frame_result jsonb; output scope_derivations;';
 reader_before constant text:=$old$  source_row=CASE WHEN TG_TABLE_NAME='scope_resource_states'
    THEN read_scope_review_source(NEW.workspace_id,expected_kind,expected_id)
    ELSE read_scope_source(NEW.workspace_id,expected_kind,expected_id) END;$old$;
 reader_after constant text:=$new$  source_row:=NULL;
  IF TG_TABLE_NAME='scope_derivation_sources' AND expected_kind='application_field'
   AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=NEW.workspace_id AND f.id=expected_id
    AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND f.type_key IN('session_message','session_message_annotation'))
   AND NOT EXISTS(
    SELECT 1 FROM (VALUES
     ('public.read_scope_source(uuid,text,uuid)','318a98c7d1f20f7e590b53adef942d7a3b7dcdd273821e594116613172ccf37d'),
     ('public.read_scope_source_before_persistent_context(uuid,text,uuid)','98938b6884001253442193cb62258afd99fad56ce83409e9466c33dfb923b0e3'),
     ('public.application_current_field_snapshot(uuid,uuid)','06f3bd17edf6103a9d2014856a9abff19dba216614e6ce17cb13cd1705355403'),
     ('public.read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','310f37bf5fc5c989e42c76d6fff068345c95621479cb7716c24f4268b8fdf01b')
    ) contract(signature,body)
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(contract.signature)
    WHERE p.oid IS NULL OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') IS DISTINCT FROM contract.body
     OR p.prosecdef IS NOT TRUE OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
     OR p.prorettype<>'jsonb'::regtype OR p.proretset OR p.proisstrict OR p.proleakproof
     OR p.provolatile<>'v' OR p.proparallel<>'u'
     OR p.proowner IS DISTINCT FROM (SELECT proowner FROM pg_proc
      WHERE oid='public.read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure)) THEN
   SELECT d.* INTO output FROM scope_derivations d WHERE d.workspace_id=NEW.workspace_id AND d.id=NEW.derivation_id;
   IF FOUND AND output.resource_version='1' AND (
    (output.resource_kind='session_message' AND EXISTS(
     SELECT 1 FROM session_messages m WHERE m.workspace_id=output.workspace_id AND m.id=output.resource_id
      AND m.scope_version=1 AND m.scope_held IS FALSE
      AND (m.user_id,m.assistant_id,m.sensitivity,m.compartments,m.project_ids)
       IS NOT DISTINCT FROM (output.user_id,output.assistant_id,output.sensitivity,output.compartments,output.project_ids)))
    OR (output.resource_kind='session_context_revision' AND EXISTS(
     SELECT 1 FROM session_context_scope_revisions r WHERE r.workspace_id=output.workspace_id AND r.id=output.resource_id
      AND r.parent_kind='message_annotation' AND r.scope_version=1 AND r.scope_held IS FALSE
      AND (r.user_id,r.assistant_id,r.sensitivity,r.compartments,r.project_ids)
       IS NOT DISTINCT FROM (output.user_id,output.assistant_id,output.sensitivity,output.compartments,output.project_ids))))
    -- Metadata only: ordinary short histories keep the cheaper original path.
    -- This hint grants nothing; the frame below re-proves the exact source.
    AND EXISTS(SELECT 1 FROM session_context_scope_revisions r
     JOIN scope_derivations d ON d.workspace_id=r.workspace_id AND d.resource_kind='session_context_revision' AND d.resource_id=r.id
     JOIN scope_derivation_sources e ON e.workspace_id=d.workspace_id AND e.derivation_id=d.id AND e.source_kind='application_field'
     WHERE r.workspace_id=NEW.workspace_id AND r.parent_kind='message_annotation'
      AND r.session_id=CASE WHEN output.resource_kind='session_message'
       THEN (SELECT m.session_id FROM session_messages m WHERE m.workspace_id=output.workspace_id AND m.id=output.resource_id)
       ELSE (SELECT c.session_id FROM session_context_scope_revisions c WHERE c.workspace_id=output.workspace_id AND c.id=output.resource_id) END) THEN
    frame_result:=read_native_session_cohort_frame(NEW.workspace_id,ARRAY[expected_kind],ARRAY[expected_id],ARRAY[expected_version],true);
    IF frame_result->>'admitted'='true' AND frame_result#>>'{memo,memoryStatement,workspaceId}'=NEW.workspace_id::text THEN
     SELECT point.value||jsonb_build_object('held',false) INTO source_row
      FROM jsonb_array_elements(frame_result->'current') point(value)
      WHERE point.value->>'resourceKind'=expected_kind AND point.value->>'resourceId'=expected_id::text LIMIT 1;
    END IF;
   END IF;
  END IF;
  IF source_row IS NULL THEN
   source_row=CASE WHEN TG_TABLE_NAME='scope_resource_states'
    THEN read_scope_review_source(NEW.workspace_id,expected_kind,expected_id)
    ELSE read_scope_source(NEW.workspace_id,expected_kind,expected_id) END;
  END IF;$new$;
BEGIN
 IF application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native reference frame prerequisite changed';END IF;
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO original,definition,metadata FROM pg_proc p WHERE oid=target;
 SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO triggers FROM pg_trigger t WHERE t.tgfoid=target;
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM '25028ddfeefca64f4d03d06785d6a17d10950910a66c0cf2c4a005ae0024c539'
  OR array_length(string_to_array(original,declaration_before),1)<>2
  OR array_length(string_to_array(original,reader_before),1)<>2
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgfoid=target) THEN
  RAISE EXCEPTION 'Native reference frame predecessor changed';END IF;
 changed:=replace(replace(original,declaration_before,declaration_after),reader_before,reader_after);
 EXECUTE replace(definition,original,changed);
 IF (SELECT prosrc FROM pg_proc WHERE oid=target) IS DISTINCT FROM changed
  OR (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=target) IS DISTINCT FROM metadata
  OR (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t WHERE t.tgfoid=target) IS DISTINCT FROM triggers
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native reference frame changed function authority';END IF;
END $native_reference_frame$;
COMMIT;
