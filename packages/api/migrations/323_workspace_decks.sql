-- 323: workspace_decks — persistent deck artifacts for first-party PPTX
-- generation. The row holds the editable spec (JSON) + resolved reference
-- style; the built .pptx binary lives in workspace_files at file_path
-- (stable: decks/<id>.pptx, rewritten in place per edit).
-- Spec: docs/architecture/features/deck-generation.md

BEGIN;

CREATE TABLE public.workspace_decks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL,
  spec jsonb NOT NULL,
  style jsonb,
  style_source text,
  file_path text NOT NULL,
  version integer DEFAULT 1 NOT NULL,
  created_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT workspace_decks_pkey PRIMARY KEY (id),
  CONSTRAINT workspace_decks_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX workspace_decks_workspace_idx
  ON public.workspace_decks (workspace_id, updated_at DESC);

CREATE TRIGGER workspace_decks_set_updated_at BEFORE UPDATE ON public.workspace_decks
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.workspace_decks ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_decks_workspace_member ON public.workspace_decks
  USING ((workspace_id IN ( SELECT workspace_members.workspace_id
     FROM public.workspace_members
    WHERE (workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid))));

COMMIT;
