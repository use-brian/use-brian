-- M3 metadata evidence only. Does not update policy, grants or migration status.
BEGIN;
CREATE TABLE public.workspace_access_inventory_checkpoints (
  workspace_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  family text NOT NULL,
  manifest_version text NOT NULL CHECK(manifest_version ~ '^[a-f0-9]{64}$'),
  policy_fingerprint text NOT NULL CHECK(policy_fingerprint ~ '^[a-f0-9]{64}$'),
  pages bigint NOT NULL DEFAULT 0,
  changed_rows bigint NOT NULL DEFAULT 0,
  quiet_at timestamptz,
  coverage_blocker text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(plan_id,family),
  UNIQUE(workspace_id,plan_id,family),
  FOREIGN KEY(workspace_id,plan_id) REFERENCES public.workspace_access_migration_plans(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE public.workspace_access_inventory_snapshots (
  workspace_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  family text NOT NULL,
  subject_id text NOT NULL,
  metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),
  source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
  policy_fingerprint text NOT NULL CHECK(policy_fingerprint ~ '^[a-f0-9]{64}$'),
  manifest_version text NOT NULL CHECK(manifest_version ~ '^[a-f0-9]{64}$'),
  deleted boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(plan_id,family,subject_id),
  FOREIGN KEY(workspace_id,plan_id,family) REFERENCES public.workspace_access_inventory_checkpoints(workspace_id,plan_id,family) ON DELETE CASCADE
);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['workspace_access_inventory_checkpoints','workspace_access_inventory_snapshots'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY inventory_admin_read ON public.%I FOR SELECT USING(EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=%I.workspace_id AND m.user_id=nullif(current_setting(''app.current_user_id'',true),'''')::uuid AND m.role IN(''owner'',''admin'')))',tab,tab);
    -- Application principals cannot manufacture inventory evidence.
    EXECUTE format('CREATE POLICY inventory_system ON public.%I FOR ALL USING(current_setting(''app.system_bypass'',true)=''true'') WITH CHECK(current_setting(''app.system_bypass'',true)=''true'')',tab);
  END LOOP;
END $$;
COMMIT;
