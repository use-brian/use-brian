-- [COMP:api/native-turn-frame] Canonical publication owns scheduling and completion.
-- All predecessor executables/table contracts were authenticated by the installer.
LOCK TABLE public.native_field_dependency_work,public.native_field_dependency_batches IN ACCESS EXCLUSIVE MODE;
DO $empty_old_work$ BEGIN
 IF EXISTS(SELECT 1 FROM native_field_dependency_work) OR EXISTS(SELECT 1 FROM native_field_dependency_batches)
 THEN RAISE EXCEPTION 'conversation_legacy_field_work_not_empty';END IF;
END $empty_old_work$;
DO $per_event_constraint$ DECLARE definition text;body text;prefix text;original text;begin_at integer;end_at integer;native_event text;
 marker constant text:=' FOR work_row IN SELECT * FROM jsonb_populate_recordset(NULL::scope_derivation_sources,coalesce(work_rows,''[]'')) LOOP';
BEGIN
 SELECT pg_get_functiondef(oid),prosrc INTO STRICT definition,body FROM pg_proc WHERE oid='validate_application_field_dependencies()'::regprocedure;
 begin_at:=strpos(body,marker);end_at:=strpos(body,' END LOOP original_work;');
 IF begin_at=0 OR end_at<=begin_at OR strpos(body,' work_row scope_derivation_sources;')=0
  OR strpos(body,' work_rows:=jsonb_build_array(to_jsonb(NEW));')=0
 THEN RAISE EXCEPTION 'conversation_generic_constraint_predecessor_changed';END IF;
 prefix:=left(body,strpos(body,' work_row scope_derivation_sources;')-1);
 native_event:=substring(body FROM strpos(body,E'BEGIN\n')+length(E'BEGIN\n') FOR strpos(body,' work_rows:=jsonb_build_array(to_jsonb(NEW));')-strpos(body,E'BEGIN\n')-length(E'BEGIN\n'));
 original:=substring(body FROM begin_at+length(marker) FOR end_at-begin_at-length(marker));
 original:=replace(replace(original,'work_row.','NEW.'),'CONTINUE original_work;','RETURN NULL;');
 EXECUTE replace(definition,body,prefix||E'BEGIN\n'||native_event||original||E'\n RETURN NULL;\nEND');
END $per_event_constraint$;
DO $remove_specialized_reference$ DECLARE definition text;old_branch constant text:=$old$  IF source_row IS NULL AND TG_RELID='public.scope_derivation_sources'::regclass AND TG_OP='INSERT' AND expected_kind='application_field' THEN
    IF application_native_field_reference_helpers_current() IS TRUE THEN
      source_row:=read_native_field_reference_snapshot(NEW.workspace_id,NEW.derivation_id,expected_id,expected_version);
    END IF;
  END IF;
$old$;
BEGIN
 definition:=pg_get_functiondef('validate_scope_resource_reference()'::regprocedure);
 IF strpos(definition,old_branch)=0 THEN RAISE EXCEPTION 'conversation_reference_fallback_predecessor_changed';END IF;
 EXECUTE replace(definition,old_branch,'');
END $remove_specialized_reference$;
CREATE FUNCTION public.native_turn_capture_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
BEGIN
 -- Only the canonical collector may claim this event. Unowned events retain
 -- the generic named constraint's complete fresh per-event validation.
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p
  WHERE p.oid='native_turn_capture_event(jsonb)'::regprocedure)='__CONVERSATION_EVENT_FINGERPRINT__'
 THEN PERFORM native_turn_capture_event(to_jsonb(NEW));END IF;
 RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.native_turn_capture_event() FROM PUBLIC,app_user;
DO $event_collector_pin$ DECLARE definition text;pin text;BEGIN
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT pin FROM pg_proc p WHERE p.oid='native_turn_capture_event(jsonb)'::regprocedure;
 definition:=pg_get_functiondef('native_turn_capture_event()'::regprocedure);
 EXECUTE replace(definition,'__CONVERSATION_EVENT_FINGERPRINT__',pin);
END $event_collector_pin$;
DROP TRIGGER application_field_dependency_work ON public.scope_derivation_sources;
-- PostgreSQL fires same-kind triggers by name. Collect before the unchanged
-- application_field_derivation_dependencies constraint even in IMMEDIATE mode.
CREATE TRIGGER application_field_capture AFTER INSERT OR UPDATE ON public.scope_derivation_sources
 FOR EACH ROW EXECUTE FUNCTION public.native_turn_capture_event();
