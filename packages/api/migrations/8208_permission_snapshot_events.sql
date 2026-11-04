-- Best-effort permission dirty hints; NOTIFY is delivered only on commit.
-- No revisions/replay: listeners must invalidate everything after reconnect.
BEGIN;

CREATE FUNCTION public.notify_permission_snapshot_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w uuid; old_w uuid;
BEGIN
 IF TG_TABLE_NAME='application_policy_contract_epoch' OR TG_OP='TRUNCATE' THEN
  PERFORM pg_notify('permission_invalidation', '{"global":true}');
  RETURN NULL;
 END IF;
 IF TG_OP<>'DELETE' THEN w:=NEW.workspace_id; END IF;
 IF TG_OP<>'INSERT' THEN old_w:=OLD.workspace_id; END IF;
 -- Cover both identities if an epoch row's workspace key is changed.
 FOR w IN SELECT DISTINCT id FROM unnest(ARRAY[w,old_w]) id WHERE id IS NOT NULL LOOP
  PERFORM pg_notify('permission_invalidation', json_build_object('workspaceId',w)::text);
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.notify_permission_snapshot_event() FROM PUBLIC;

CREATE TRIGGER permission_snapshot_workspace_event
 AFTER INSERT OR UPDATE OR DELETE ON public.application_policy_workspace_epochs
 FOR EACH ROW EXECUTE FUNCTION public.notify_permission_snapshot_event();
CREATE TRIGGER permission_snapshot_contract_event
 AFTER INSERT OR UPDATE OR DELETE ON public.application_policy_contract_epoch
 FOR EACH STATEMENT EXECUTE FUNCTION public.notify_permission_snapshot_event();
CREATE TRIGGER permission_snapshot_workspace_truncate
 AFTER TRUNCATE ON public.application_policy_workspace_epochs
 FOR EACH STATEMENT EXECUTE FUNCTION public.notify_permission_snapshot_event();
CREATE TRIGGER permission_snapshot_contract_truncate
 AFTER TRUNCATE ON public.application_policy_contract_epoch
 FOR EACH STATEMENT EXECUTE FUNCTION public.notify_permission_snapshot_event();

COMMIT;
