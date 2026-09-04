-- Assistant-level programmatic capture profiles.
--
-- Reuses Pipeline C's ingest_rules + pending_ingest_batches substrate while
-- keeping reusable profile ownership distinct from account connector
-- instances. One profile can be selected by many assistants; programmatic
-- batches add assistant_id + partition_key so those assignments never
-- co-mingle pending text.
--
-- Spec: docs/architecture/features/programmatic-access.md

BEGIN;

CREATE TABLE public.programmatic_capture_profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  partition_by  text NOT NULL DEFAULT 'session'
                CHECK (partition_by IN ('connection', 'user', 'session', 'subject')),
  enabled       boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX programmatic_capture_profiles_workspace_idx
  ON public.programmatic_capture_profiles (workspace_id, created_at, id);

ALTER TABLE public.ingest_rules
  ALTER COLUMN connector_instance_id DROP NOT NULL,
  ADD COLUMN capture_profile_id uuid
    REFERENCES public.programmatic_capture_profiles(id) ON DELETE CASCADE;

ALTER TABLE public.ingest_rules
  ADD CONSTRAINT ingest_rules_exactly_one_parent CHECK (
    num_nonnulls(connector_instance_id, capture_profile_id) = 1
  ),
  ADD CONSTRAINT ingest_rules_capture_source CHECK (
    capture_profile_id IS NULL OR source = 'programmatic'
  );

CREATE UNIQUE INDEX ingest_rules_capture_profile_order_key
  ON public.ingest_rules (capture_profile_id, rule_order)
  WHERE capture_profile_id IS NOT NULL;

-- Assistant defaults and per-connection overrides select a reusable profile.
-- The credential remains workspace-scoped; these columns affect only routed
-- capture, never the credential's read principal.
ALTER TABLE public.assistants
  ADD COLUMN capture_profile_id uuid
    REFERENCES public.programmatic_capture_profiles(id) ON DELETE SET NULL;

ALTER TABLE public.brain_keys
  ADD COLUMN capture_assistant_id uuid REFERENCES public.assistants(id) ON DELETE SET NULL,
  ADD COLUMN capture_profile_id uuid
    REFERENCES public.programmatic_capture_profiles(id) ON DELETE SET NULL;

ALTER TABLE public.oauth_authorizations
  ADD COLUMN capture_assistant_id uuid REFERENCES public.assistants(id) ON DELETE SET NULL,
  ADD COLUMN capture_profile_id uuid
    REFERENCES public.programmatic_capture_profiles(id) ON DELETE SET NULL;

-- Programmatic batches share the durable Pipeline-C queue but carry the
-- assistant + partition dimensions missing from connector-only batches.
ALTER TABLE public.pending_ingest_batches
  ADD COLUMN assistant_id uuid REFERENCES public.assistants(id) ON DELETE CASCADE,
  ADD COLUMN partition_key text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX pending_programmatic_batch_pool_key
  ON public.pending_ingest_batches (rule_id, assistant_id, partition_key, fires_at)
  WHERE source = 'programmatic' AND processed_at IS NULL;

CREATE TABLE public.programmatic_capture_receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  principal_kind  text NOT NULL
                  CHECK (principal_kind IN ('api_key', 'oauth_token', 'home_app')),
  principal_id    uuid NOT NULL,
  event_id        text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  rule_id         uuid REFERENCES public.ingest_rules(id) ON DELETE SET NULL,
  batch_id        uuid REFERENCES public.pending_ingest_batches(id) ON DELETE CASCADE,
  status          text NOT NULL
                  CHECK (status IN ('processing', 'queued', 'completed', 'dropped', 'failed')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_kind, principal_id, event_id)
);

CREATE INDEX programmatic_capture_receipts_workspace_created_idx
  ON public.programmatic_capture_receipts (workspace_id, created_at DESC);

-- Reject cross-workspace profile/assistant bindings even if a future caller
-- bypasses the REST validation. The trigger deliberately validates only
-- non-null bindings so deleting a profile/assistant can SET NULL normally.
CREATE FUNCTION public.validate_programmatic_capture_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  bound_workspace uuid;
BEGIN
  IF TG_TABLE_NAME = 'assistants' THEN
    IF NEW.capture_profile_id IS NULL THEN RETURN NEW; END IF;
    SELECT workspace_id INTO bound_workspace
      FROM public.programmatic_capture_profiles WHERE id = NEW.capture_profile_id;
    IF bound_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'capture profile must belong to the assistant workspace';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.capture_assistant_id IS NOT NULL THEN
    SELECT workspace_id INTO bound_workspace
      FROM public.assistants WHERE id = NEW.capture_assistant_id;
    IF bound_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'capture assistant must belong to the credential workspace';
    END IF;
  END IF;

  IF NEW.capture_profile_id IS NOT NULL THEN
    SELECT workspace_id INTO bound_workspace
      FROM public.programmatic_capture_profiles WHERE id = NEW.capture_profile_id;
    IF bound_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'capture profile must belong to the credential workspace';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assistants_capture_binding_guard
  BEFORE INSERT OR UPDATE OF workspace_id, capture_profile_id ON public.assistants
  FOR EACH ROW EXECUTE FUNCTION public.validate_programmatic_capture_binding();
CREATE TRIGGER brain_keys_capture_binding_guard
  BEFORE INSERT OR UPDATE OF workspace_id, capture_assistant_id, capture_profile_id ON public.brain_keys
  FOR EACH ROW EXECUTE FUNCTION public.validate_programmatic_capture_binding();
CREATE TRIGGER oauth_authorizations_capture_binding_guard
  BEFORE INSERT OR UPDATE OF workspace_id, capture_assistant_id, capture_profile_id ON public.oauth_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.validate_programmatic_capture_binding();

ALTER TABLE public.programmatic_capture_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.programmatic_capture_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY programmatic_capture_profiles_member
  ON public.programmatic_capture_profiles
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
       WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )
  )
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
       WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )
  );

CREATE POLICY programmatic_capture_profiles_system
  ON public.programmatic_capture_profiles
  USING (current_setting('app.system_bypass', true) = 'true')
  WITH CHECK (current_setting('app.system_bypass', true) = 'true');

CREATE POLICY programmatic_capture_receipts_system
  ON public.programmatic_capture_receipts
  USING (current_setting('app.system_bypass', true) = 'true')
  WITH CHECK (current_setting('app.system_bypass', true) = 'true');

-- The pre-existing policy only recognizes connector_instance parents. Extend
-- it to reusable programmatic profiles without weakening connector access.
DROP POLICY ingest_rules_member ON public.ingest_rules;
CREATE POLICY ingest_rules_member ON public.ingest_rules
  USING (
    connector_instance_id IN (SELECT id FROM public.connector_instance)
    OR capture_profile_id IN (SELECT id FROM public.programmatic_capture_profiles)
  )
  WITH CHECK (
    connector_instance_id IN (SELECT id FROM public.connector_instance)
    OR capture_profile_id IN (SELECT id FROM public.programmatic_capture_profiles)
  );

COMMIT;
