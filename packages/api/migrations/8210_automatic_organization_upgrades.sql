-- Product maintenance is system-attributed; it never invents human consent.
BEGIN;
ALTER TABLE public.workspace_organization_cutover_reviews
 ADD COLUMN execution_kind text NOT NULL DEFAULT 'attended' CHECK(execution_kind IN ('attended','background')),
 ALTER COLUMN actor_user_id DROP NOT NULL,
 ALTER COLUMN auth_session_id DROP NOT NULL,
 ALTER COLUMN target_department_id DROP NOT NULL,
 ADD CONSTRAINT organization_cutover_principal CHECK(
   (execution_kind='attended' AND actor_user_id IS NOT NULL AND auth_session_id IS NOT NULL AND target_department_id IS NOT NULL)
   OR (execution_kind='background' AND actor_user_id IS NULL AND auth_session_id IS NULL));

CREATE TABLE public.workspace_organization_upgrade_jobs (
 workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','blocked','completed')),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_attempt_at timestamptz,
 diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(diagnostics)='array')
);
CREATE INDEX workspace_organization_upgrade_due ON public.workspace_organization_upgrade_jobs(next_attempt_at,workspace_id)
 WHERE status<>'completed';
ALTER TABLE public.workspace_organization_upgrade_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_organization_upgrade_jobs FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON public.workspace_organization_upgrade_jobs FROM app_user;
 END IF;
END $$;

-- Extend only the existing exact schedule-conversion review. The review table
-- is backend-written with RLS and no app-role write policy. A GUC or JSON value
-- cannot manufacture one. All old/source fingerprints and snapshots stay checked.
DO $migration$
DECLARE definition text; updated text;
BEGIN
 definition:=pg_get_functiondef('public.protect_pinned_workflow_schedule()'::regprocedure);
 updated:=replace(definition,
  'JOIN public.workspaces workspace ON workspace.id=r.workspace_id AND workspace.owner_user_id=r.actor_user_id',
  'JOIN public.workspaces workspace ON workspace.id=r.workspace_id AND (r.execution_kind=''background'' OR workspace.owner_user_id=r.actor_user_id)');
 IF updated=definition THEN RAISE EXCEPTION 'automatic_cutover_guard_schema_changed'; END IF;
 definition:=updated;
 updated:=replace(definition,'JOIN public.auth_sessions session ON session.id=r.auth_session_id','LEFT JOIN public.auth_sessions session ON session.id=r.auth_session_id');
 IF updated=definition THEN RAISE EXCEPTION 'automatic_cutover_session_guard_schema_changed'; END IF;
 definition:=updated;
 updated:=replace(definition,'JOIN public.users actor ON actor.id=r.actor_user_id AND actor.auth_version=session.auth_version','LEFT JOIN public.users actor ON actor.id=r.actor_user_id AND actor.auth_version=session.auth_version');
 IF updated=definition THEN RAISE EXCEPTION 'automatic_cutover_actor_guard_schema_changed'; END IF;
 definition:=updated;
 updated:=replace(definition,
  'AND r.actor_user_id::text=nullif(current_setting(''app.current_user_id'',true),'''')',
  'AND (r.execution_kind=''background'' AND r.actor_user_id IS NULL AND r.auth_session_id IS NULL AND nullif(current_setting(''app.current_user_id'',true),'''') IS NULL
    OR r.execution_kind=''attended'' AND r.actor_user_id::text=nullif(current_setting(''app.current_user_id'',true),'''') AND actor.id IS NOT NULL)');
 IF updated=definition THEN RAISE EXCEPTION 'automatic_cutover_attribution_guard_schema_changed'; END IF;
 definition:=updated;
 updated:=replace(definition,
  'AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()',
  'AND (r.execution_kind=''background'' OR session.revoked_at IS NULL AND session.expires_at>clock_timestamp())');
 IF updated=definition THEN RAISE EXCEPTION 'automatic_cutover_expiry_guard_schema_changed'; END IF;
 EXECUTE updated;
END
$migration$;
COMMIT;
