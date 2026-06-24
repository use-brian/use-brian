-- 281_workspace_page_templates.sql
--
-- Custom, workspace-shared doc-page templates.
--
-- The built-in template catalog (`PAGE_TEMPLATES` in
-- packages/core/src/doc/templates.ts) is code; this table is the persistence
-- for USER-authored templates. A row is a reusable page skeleton: a name +
-- icon + category + a snapshot of the page block list (`blocks` jsonb). Two
-- authoring paths write it -- "Save as template" (snapshot a live page's
-- blocks) and "New template" (author from scratch) -- and the gallery merges
-- these rows with the built-in catalog at render/instantiate time.
--
-- Deliberately a SEPARATE table, not a `saved_views` flag: a template must be
-- invisible everywhere a page is visible (sidebar tree, home recents,
-- `findPage`, the `listPages` MCP tool, brain ingest/prune). A dedicated table
-- isolates it with zero changes to those page-listing/search/brain surfaces.
--
-- Workspace-shared visibility comes from the RLS policy (membership via
-- `app.current_user_id`), mirroring `saved_views_workspace_member`.
--
-- Stores / readers: packages/api/src/db/page-templates-store.ts.
-- Spec: docs/architecture/features/doc-templates.md -> "Custom templates".

BEGIN;

CREATE TABLE public.workspace_page_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    created_by uuid NOT NULL,
    name text NOT NULL,
    description text,
    icon text,
    category text NOT NULL,
    blocks jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_page_templates_pkey PRIMARY KEY (id),
    CONSTRAINT workspace_page_templates_workspace_id_fkey
        FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
    CONSTRAINT workspace_page_templates_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES public.users(id),
    CONSTRAINT workspace_page_templates_name_check
        CHECK (((length(name) >= 1) AND (length(name) <= 256))),
    CONSTRAINT workspace_page_templates_description_check
        CHECK (((description IS NULL) OR (length(description) <= 2000))),
    CONSTRAINT workspace_page_templates_category_check
        CHECK ((category = ANY (ARRAY['meeting'::text, 'planning'::text, 'team'::text, 'personal'::text, 'knowledge'::text])))
);

CREATE INDEX workspace_page_templates_workspace_id_idx
    ON public.workspace_page_templates (workspace_id);
CREATE INDEX workspace_page_templates_workspace_updated_idx
    ON public.workspace_page_templates (workspace_id, updated_at DESC);

CREATE TRIGGER workspace_page_templates_set_updated_at
    BEFORE UPDATE ON public.workspace_page_templates
    FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.workspace_page_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_page_templates_workspace_member ON public.workspace_page_templates
    USING ((workspace_id IN ( SELECT workspace_members.workspace_id
       FROM public.workspace_members
      WHERE (workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid))));

COMMIT;
