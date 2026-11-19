-- [COMP:api/authority-lease] Retire the unconsumed action-snapshot notification path.
-- Historical migration 8208 stays immutable. Unknown dependents fail RESTRICT.
DO $retire_snapshot_events$
DECLARE item record; owner_id oid; helper oid:=to_regprocedure('public.notify_permission_snapshot_event()');
BEGIN
 SELECT oid INTO owner_id FROM pg_roles WHERE rolname=current_user;
 IF helper IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=helper AND p.proowner=owner_id
  AND p.prorettype='trigger'::regtype AND p.prosecdef
  AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='897264c9e446071d0f868305d932f82902caae1b80369eddc4ab847d2eca4472') THEN
  RAISE EXCEPTION 'conversation_snapshot_notification_predecessor_changed';END IF;
 FOR item IN SELECT * FROM (VALUES
  ('application_policy_workspace_epochs','permission_snapshot_workspace_event',29),
  ('application_policy_contract_epoch','permission_snapshot_contract_event',28),
  ('application_policy_workspace_epochs','permission_snapshot_workspace_truncate',32),
  ('application_policy_contract_epoch','permission_snapshot_contract_truncate',32)) expected(relation,name,kind) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.'||item.relation)
   AND t.tgname=item.name AND t.tgfoid=helper AND t.tgtype=item.kind AND NOT t.tgisinternal
   AND t.tgenabled='O' AND t.tgqual IS NULL AND t.tgnargs=0) THEN
   RAISE EXCEPTION 'conversation_snapshot_notification_trigger_changed';END IF;
  EXECUTE format('DROP TRIGGER %I ON public.%I',item.name,item.relation);
 END LOOP;
END $retire_snapshot_events$;
DROP FUNCTION public.notify_permission_snapshot_event() RESTRICT;
