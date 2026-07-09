-- Teamspaces — Notion-style page containers above the doc page tree.
--
-- A teamspace is a member-gated container with a sensitivity tier; every
-- saved_views row either belongs to one teamspace or is private to its
-- creator (teamspace_id IS NULL). Membership is the HARD access boundary,
-- carried by RLS; the sensitivity tier is enforced app-side (doc-sync
-- clearance-gate + routes), mirroring how per-page clearance already works.
-- Every workspace gets one undeletable `is_default` "General" teamspace all
-- members auto-join; the backfill files every existing page into it, so
-- nothing changes visibility at cutover.
--
-- saved_views.teamspace_id is ON DELETE SET NULL, never RESTRICT: a RESTRICT
-- FK would abort workspace deletion mid-cascade (the workspace delete reaches
-- saved_views and teamspaces on independent cascade paths with no guaranteed
-- order — the mig-232/233 class of failure). The store reassigns pages to
-- General inside the teamspace-delete transaction, so SET NULL is only the
-- crash-safe fallback.
--
-- Spec: docs/architecture/features/teamspaces.md. [COMP:api/teamspace-store]

BEGIN;

CREATE TABLE public.teamspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    icon text,
    description text,
    sensitivity text DEFAULT 'internal'::text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT teamspaces_pkey PRIMARY KEY (id),
    CONSTRAINT teamspaces_sensitivity_check
      CHECK (sensitivity = ANY (ARRAY['public'::text, 'internal'::text, 'confidential'::text])),
    CONSTRAINT teamspaces_workspace_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
    CONSTRAINT teamspaces_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL
);

-- Exactly one default (General) teamspace per workspace.
CREATE UNIQUE INDEX teamspaces_workspace_default_unique
  ON public.teamspaces (workspace_id) WHERE (is_default = true);

CREATE INDEX idx_teamspaces_workspace
  ON public.teamspaces (workspace_id, "position");

CREATE TRIGGER teamspaces_set_updated_at
  BEFORE UPDATE ON public.teamspaces
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

CREATE TABLE public.teamspace_members (
    teamspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT teamspace_members_pkey PRIMARY KEY (teamspace_id, user_id),
    CONSTRAINT teamspace_members_teamspace_fkey
      FOREIGN KEY (teamspace_id) REFERENCES public.teamspaces(id) ON DELETE CASCADE,
    CONSTRAINT teamspace_members_user_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- Backs the RLS membership subquery (WHERE user_id = current user).
CREATE INDEX idx_teamspace_members_user
  ON public.teamspace_members (user_id);

ALTER TABLE public.saved_views
  ADD COLUMN teamspace_id uuid,
  ADD CONSTRAINT saved_views_teamspace_fkey
    FOREIGN KEY (teamspace_id) REFERENCES public.teamspaces(id) ON DELETE SET NULL;

CREATE INDEX idx_saved_views_teamspace
  ON public.saved_views (teamspace_id);

-- ---------------------------------------------------------------------------
-- Backfill: one General teamspace per workspace, every member joined, every
-- existing page (all depths, saved + draft) filed into it.
-- ---------------------------------------------------------------------------

INSERT INTO public.teamspaces (workspace_id, name, sensitivity, is_default, created_by)
SELECT w.id, 'General', 'internal', true, w.owner_user_id
FROM public.workspaces w;

INSERT INTO public.teamspace_members (teamspace_id, user_id)
SELECT t.id, wm.user_id
FROM public.teamspaces t
JOIN public.workspace_members wm ON wm.workspace_id = t.workspace_id
WHERE t.is_default = true
ON CONFLICT DO NOTHING;

UPDATE public.saved_views sv
SET teamspace_id = t.id
FROM public.teamspaces t
WHERE t.workspace_id = sv.workspace_id AND t.is_default = true;

-- ---------------------------------------------------------------------------
-- RLS.
--
-- teamspaces / teamspace_members are SELECT-only under RLS (self-scoped, the
-- wm_own_workspace shape); every write goes through the owner pool behind
-- route-level clearance gates, and roster reads use the owner pool after a
-- membership check (the memberCountsSystem pattern).
-- ---------------------------------------------------------------------------

ALTER TABLE public.teamspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY teamspaces_member ON public.teamspaces
  FOR SELECT
  USING (id IN (
    SELECT tm.teamspace_id FROM public.teamspace_members tm
    WHERE tm.user_id = (current_setting('app.current_user_id'::text, true))::uuid));

ALTER TABLE public.teamspace_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY teamspace_members_self ON public.teamspace_members
  FOR SELECT
  USING (user_id = (current_setting('app.current_user_id'::text, true))::uuid);

-- The hard boundary: a page is visible iff the caller is a workspace member
-- AND (the page is their own private page, or they belong to its teamspace).
-- documents + page_grants policies subquery saved_views, so they inherit this
-- tightening for free. The teamspace sensitivity tier is deliberately NOT
-- here — it is enforced app-side like saved_views.clearance (doc-sync gate),
-- and add-member gating keeps below-clearance members out to begin with.
DROP POLICY saved_views_workspace_member ON public.saved_views;

CREATE POLICY saved_views_workspace_member ON public.saved_views
  USING (
    workspace_id IN (
      SELECT workspace_members.workspace_id
      FROM public.workspace_members
      WHERE workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid)
    AND (
      (teamspace_id IS NULL
        AND created_by = (current_setting('app.current_user_id'::text, true))::uuid)
      OR teamspace_id IN (
        SELECT tm.teamspace_id FROM public.teamspace_members tm
        WHERE tm.user_id = (current_setting('app.current_user_id'::text, true))::uuid)
    )
  );

COMMIT;
