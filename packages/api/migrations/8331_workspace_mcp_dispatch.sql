-- [COMP:api/workspace-mcp] Discover active jobs without reading protected run contents.
BEGIN;
CREATE TABLE public.workspace_mcp_dispatch (
  run_id uuid PRIMARY KEY REFERENCES public.workspace_mcp_runs(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  poll_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_mcp_dispatch_due ON public.workspace_mcp_dispatch(poll_at, run_id);
ALTER TABLE public.workspace_mcp_dispatch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_mcp_dispatch FROM PUBLIC, app_user;

CREATE FUNCTION public.sync_workspace_mcp_dispatch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid;
BEGIN
  IF NEW.status IN ('queued','running','waiting_approval','waiting_input') THEN
    SELECT user_id INTO STRICT actor FROM public.workspace_mcp_contexts WHERE id=NEW.context_id;
    INSERT INTO public.workspace_mcp_dispatch(run_id,actor_id,poll_at)
      VALUES(NEW.id,actor,CASE WHEN NEW.status='running' THEN coalesce(NEW.heartbeat_at,now())+interval '2 minutes' ELSE now() END)
      ON CONFLICT(run_id) DO UPDATE SET actor_id=excluded.actor_id,poll_at=excluded.poll_at;
  ELSE
    DELETE FROM public.workspace_mcp_dispatch WHERE run_id=NEW.id;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.sync_workspace_mcp_dispatch() FROM PUBLIC, app_user;
CREATE TRIGGER workspace_mcp_dispatch_sync AFTER INSERT OR UPDATE OF status,heartbeat_at
  ON public.workspace_mcp_runs FOR EACH ROW EXECUTE FUNCTION public.sync_workspace_mcp_dispatch();

-- The migration owner also observes forced actor RLS. Seed pending work for
-- each existing machine session while the new trigger fences concurrent writes.
DO $$
DECLARE actor uuid; previous_actor text := current_setting('app.current_user_id',true);
BEGIN
  FOR actor IN SELECT DISTINCT user_id FROM public.sessions WHERE channel_id LIKE 'workspace-mcp:%' LOOP
    PERFORM set_config('app.current_user_id',actor::text,true);
    INSERT INTO public.workspace_mcp_dispatch(run_id,actor_id)
      SELECT r.id,c.user_id FROM public.workspace_mcp_runs r JOIN public.workspace_mcp_contexts c ON c.id=r.context_id
      WHERE c.user_id=actor AND r.status IN ('queued','running','waiting_approval','waiting_input');
  END LOOP;
  PERFORM set_config('app.current_user_id',coalesce(previous_actor,''),true);
END $$;
COMMIT;
