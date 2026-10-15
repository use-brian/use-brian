-- Governed Project and Department Briefs.
-- Spec: docs/architecture/features/project-briefs.md (platform); decision
-- source: platform docs/plans/project-brief-implementation.md (D09, D11-D13,
-- D16-D30).
--
-- One canonical Brian Page per Department or shared Project. Its Direction
-- region (top-level blocks from direction_start_id up to context_start_id)
-- changes only through brief_publish; guard triggers refuse every other
-- writer. Additive: no existing Project, Department or Page is bound.
BEGIN;

-- ── State ──────────────────────────────────────────────────────────────────

CREATE TABLE public.brief_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  owner_kind text NOT NULL CHECK (owner_kind IN ('department','project')),
  project_id uuid REFERENCES public.project_shared_scopes(project_id) ON DELETE CASCADE,
  department_id uuid,
  owner_id uuid GENERATED ALWAYS AS (coalesce(project_id, department_id)) STORED,
  page_id uuid UNIQUE REFERENCES public.saved_views(id) ON DELETE SET NULL,
  direction_start_id text NOT NULL CHECK (length(direction_start_id) BETWEEN 1 AND 128),
  context_start_id text NOT NULL CHECK (length(context_start_id) BETWEEN 1 AND 128),
  section_ids jsonb NOT NULL CHECK (jsonb_typeof(section_ids) = 'object'),
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','ja','zh','zh-CN')),
  direction_revision integer NOT NULL DEFAULT 0 CHECK (direction_revision >= 0),
  selection_revision integer NOT NULL DEFAULT 0 CHECK (selection_revision >= 0),
  accepted_direction_hash text NOT NULL CHECK (accepted_direction_hash ~ '^[a-f0-9]{32}$'),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, department_id) REFERENCES public.workspace_groups(workspace_id, id) ON DELETE CASCADE,
  CHECK ((owner_kind = 'project') = (project_id IS NOT NULL AND department_id IS NULL)),
  CHECK ((owner_kind = 'department') = (department_id IS NOT NULL AND project_id IS NULL)),
  UNIQUE (workspace_id, owner_kind, owner_id)
);

-- Immutable accepted history. A revision snapshot is a Page checkpoint of the
-- accepted region, never a second authoritative Brief body.
CREATE TABLE public.brief_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL REFERENCES public.brief_bindings(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('created','apply','restore','repair','selection')),
  direction_revision integer NOT NULL,
  selection_revision integer NOT NULL,
  direction_hash text NOT NULL,
  direction_snapshot jsonb NOT NULL,
  selection jsonb NOT NULL DEFAULT '[]'::jsonb,
  page_id uuid,
  content_seq bigint,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  acting_assistant_id uuid REFERENCES public.assistants(id) ON DELETE SET NULL,
  proposal_id uuid,
  applied_ops jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  active_work text NOT NULL DEFAULT 'pause' CHECK (active_work IN ('pause','continue')),
  idempotency_key uuid,
  request_hash text CHECK (request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$'),
  broadcast_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (binding_id, idempotency_key)
);
CREATE INDEX brief_revisions_binding_idx ON public.brief_revisions(binding_id, created_at);

-- Drafts (one open per author) and proposals. Each keeps its own source
-- envelope; nothing here is ever written into the Page.
CREATE TABLE public.brief_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL REFERENCES public.brief_bindings(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('draft','proposal')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','applied','dismissed','superseded')),
  author_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  author_assistant_id uuid REFERENCES public.assistants(id) ON DELETE SET NULL,
  summary text CHECK (summary IS NULL OR length(summary) <= 2000),
  ops jsonb NOT NULL CHECK (jsonb_typeof(ops) = 'array'),
  base_direction_revision integer NOT NULL,
  base_direction_hash text NOT NULL,
  restore_of uuid REFERENCES public.brief_revisions(id) ON DELETE SET NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  sensitivity text NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public','internal','confidential')),
  compartments text[] NOT NULL DEFAULT '{}',
  private_to_user uuid REFERENCES public.users(id) ON DELETE CASCADE,
  decided_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  revision_id uuid REFERENCES public.brief_revisions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX brief_proposals_one_open_draft ON public.brief_proposals(binding_id, author_user_id)
  WHERE kind = 'draft' AND status = 'open';
CREATE INDEX brief_proposals_binding_idx ON public.brief_proposals(binding_id, status, created_at);

-- A Project's explicitly selected Department Briefs. Order is display only.
CREATE TABLE public.brief_department_selections (
  project_binding_id uuid NOT NULL REFERENCES public.brief_bindings(id) ON DELETE CASCADE,
  department_binding_id uuid NOT NULL REFERENCES public.brief_bindings(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  added_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_binding_id, department_binding_id)
);

-- Idempotent maintenance/reconciliation receipts.
CREATE TABLE public.brief_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL REFERENCES public.brief_bindings(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  source_kind text NOT NULL CHECK (length(source_kind) BETWEEN 1 AND 64),
  source_id text,
  source_version text,
  content_hash text,
  result text NOT NULL CHECK (result IN ('maintained','proposed','no_change','conflict','unavailable')),
  basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposal_id uuid REFERENCES public.brief_proposals(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  acting_assistant_id uuid REFERENCES public.assistants(id) ON DELETE SET NULL,
  sensitivity text NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public','internal','confidential')),
  compartments text[] NOT NULL DEFAULT '{}',
  private_to_user uuid REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (binding_id, idempotency_key)
);

-- Effective-direction basis frozen for unattended work. System only.
CREATE TABLE public.brief_work_bases (
  work_kind text NOT NULL CHECK (work_kind IN ('goal','job')),
  work_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  basis jsonb NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_kind, work_id)
);

-- ── Region helpers ─────────────────────────────────────────────────────────

CREATE FUNCTION public.brief_region(page jsonb, p_start text, p_stop text)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH b AS (
    SELECT t.e, t.o FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(page -> 'blocks') = 'array' THEN page -> 'blocks' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS t(e, o)
  ), s AS (SELECT min(o) AS o FROM b WHERE e ->> 'id' = p_start),
     x AS (SELECT min(o) AS o FROM b WHERE e ->> 'id' = p_stop)
  SELECT CASE WHEN s.o IS NULL OR x.o IS NULL OR x.o < s.o THEN 'null'::jsonb
              ELSE coalesce((SELECT jsonb_agg(b.e ORDER BY b.o) FROM b WHERE b.o >= s.o AND b.o < x.o), '[]'::jsonb) END
    FROM s, x
$$;

CREATE FUNCTION public.brief_outside(page jsonb, p_start text, p_stop text)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH b AS (
    SELECT t.e, t.o FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(page -> 'blocks') = 'array' THEN page -> 'blocks' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS t(e, o)
  ), s AS (SELECT min(o) AS o FROM b WHERE e ->> 'id' = p_start),
     x AS (SELECT min(o) AS o FROM b WHERE e ->> 'id' = p_stop)
  SELECT CASE WHEN s.o IS NULL OR x.o IS NULL OR x.o < s.o THEN 'null'::jsonb
              ELSE coalesce((SELECT jsonb_agg(b.e ORDER BY b.o) FROM b WHERE b.o < s.o OR b.o >= x.o), '[]'::jsonb) END
    FROM s, x
$$;

CREATE FUNCTION public.brief_region_hash(page jsonb, p_start text, p_stop text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT md5(public.brief_region(page, p_start, p_stop)::text)
$$;

-- ── Guards on every writer ─────────────────────────────────────────────────

-- A bound page's persisted snapshot must carry the accepted Direction region.
-- Only brief_publish moves the accepted hash (binding first, same transaction).
CREATE FUNCTION public.documents_brief_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE b public.brief_bindings%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.brief_bindings x WHERE x.page_id = OLD.page_id)
       AND EXISTS (SELECT 1 FROM public.saved_views sv WHERE sv.id = OLD.page_id) THEN
      RAISE EXCEPTION 'brief_page_bound';
    END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO b FROM public.brief_bindings x WHERE x.page_id = NEW.page_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.snapshot_json IS NOT DISTINCT FROM OLD.snapshot_json THEN RETURN NEW; END IF;
  IF public.brief_region_hash(NEW.snapshot_json, b.direction_start_id, b.context_start_id) IS DISTINCT FROM b.accepted_direction_hash THEN
    RAISE EXCEPTION 'brief_direction_protected';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_brief_guard BEFORE INSERT OR UPDATE OR DELETE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_brief_guard();

-- A bound page always has a documents row, so its legacy body is frozen; its
-- placement is fixed and it cannot be deleted outside workspace teardown.
CREATE FUNCTION public.saved_views_brief_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.brief_bindings x WHERE x.page_id = OLD.id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = OLD.workspace_id) THEN RAISE EXCEPTION 'brief_page_bound'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.page IS DISTINCT FROM OLD.page THEN RAISE EXCEPTION 'brief_direction_protected'; END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.shared_project_id IS DISTINCT FROM OLD.shared_project_id
     OR (NEW.nest_parent_id IS DISTINCT FROM OLD.nest_parent_id
         AND NOT (NEW.nest_parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.saved_views p WHERE p.id = OLD.nest_parent_id)))
     OR (NEW.teamspace_id IS DISTINCT FROM OLD.teamspace_id
         AND NOT (NEW.teamspace_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.teamspaces t WHERE t.id = OLD.teamspace_id))) THEN
    RAISE EXCEPTION 'brief_page_bound';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saved_views_brief_guard BEFORE UPDATE OR DELETE ON public.saved_views
  FOR EACH ROW EXECUTE FUNCTION public.saved_views_brief_guard();

-- Accepted history is immutable: only the broadcast stamp may be set once, and
-- erased actor references may become NULL.
CREATE FUNCTION public.brief_revisions_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.brief_bindings b WHERE b.id = OLD.binding_id) THEN
      RAISE EXCEPTION 'brief_history_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'broadcast_at' - 'actor_user_id' - 'acting_assistant_id')
       IS DISTINCT FROM (to_jsonb(OLD) - 'broadcast_at' - 'actor_user_id' - 'acting_assistant_id')
     OR (OLD.broadcast_at IS NOT NULL AND NEW.broadcast_at IS DISTINCT FROM OLD.broadcast_at)
     OR (NEW.actor_user_id IS NOT NULL AND NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id)
     OR (NEW.acting_assistant_id IS NOT NULL AND NEW.acting_assistant_id IS DISTINCT FROM OLD.acting_assistant_id) THEN
    RAISE EXCEPTION 'brief_history_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brief_revisions_immutable BEFORE UPDATE OR DELETE ON public.brief_revisions
  FOR EACH ROW EXECUTE FUNCTION public.brief_revisions_immutable();

-- ── Authority ──────────────────────────────────────────────────────────────

-- owner | participant | oversight | NULL. The acting assistant (if any) must
-- hold its own admission; oversight (D27) exists for Projects only and never
-- writes. A workspace role never substitutes for Brief ownership.
CREATE FUNCTION public.brief_role(p_binding uuid, p_actor uuid, p_assistant uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE b public.brief_bindings%ROWTYPE; member boolean;
BEGIN
  SELECT * INTO b FROM public.brief_bindings x WHERE x.id = p_binding;
  IF NOT FOUND OR p_actor IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = b.workspace_id AND m.user_id = p_actor) THEN RETURN NULL; END IF;
  IF b.owner_kind = 'project' THEN
    IF NOT EXISTS (SELECT 1 FROM public.project_shared_scopes s JOIN public.workspaces w ON w.id = s.workspace_id
                    WHERE s.project_id = b.project_id AND s.status = 'active' AND w.project_shared_spaces) THEN RETURN NULL; END IF;
    IF p_assistant IS NOT NULL AND NOT public.project_member_live(b.project_id, 'assistant', p_assistant) THEN RETURN NULL; END IF;
    member := public.project_member_live(b.project_id, 'user', p_actor);
    IF member AND EXISTS (SELECT 1 FROM public.project_shared_owners o WHERE o.project_id = b.project_id AND o.user_id = p_actor) THEN RETURN 'owner'; END IF;
    IF member THEN RETURN 'participant'; END IF;
    IF EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = b.workspace_id AND m.user_id = p_actor AND m.role = 'owner') THEN RETURN 'oversight'; END IF;
    RETURN NULL;
  END IF;
  IF p_assistant IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.department_edges e
      WHERE e.department_id = b.department_id AND e.assistant_id = p_assistant
        AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.department_owners o WHERE o.department_id = b.department_id AND o.user_id = p_actor) THEN RETURN 'owner'; END IF;
  IF EXISTS (SELECT 1 FROM public.department_edges e WHERE e.department_id = b.department_id AND e.user_id = p_actor
              AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())) THEN RETURN 'participant'; END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION public.brief_actor() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := nullif(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'brief_actor_required'; END IF;
  RETURN actor;
END $$;

-- Read visibility of a binding and its history: the bound page's own current
-- read boundary, or (for a missing page) a current Brief role.
CREATE FUNCTION public.brief_binding_visible(p_binding uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((
    SELECT CASE WHEN b.page_id IS NOT NULL THEN public.saved_view_root_operation_scope_allows(b.page_id, false)
                ELSE public.brief_role(b.id, nullif(current_setting('app.current_user_id', true), '')::uuid,
                                       nullif(current_setting('app.v2_assistant_id', true), '')::uuid) IS NOT NULL END
      FROM public.brief_bindings b WHERE b.id = p_binding), false)
$$;

-- Lock, then require a writing role and current page mutation reach.
CREATE FUNCTION public.brief_lock_for(p_binding uuid, p_assistant uuid, p_need text)
RETURNS public.brief_bindings LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE b public.brief_bindings%ROWTYPE; r text; actor uuid := public.brief_actor();
BEGIN
  SELECT * INTO b FROM public.brief_bindings x WHERE x.id = p_binding;
  IF NOT FOUND THEN RAISE EXCEPTION 'brief_not_found'; END IF;
  PERFORM 1 FROM public.workspaces WHERE id = b.workspace_id FOR SHARE;
  SELECT * INTO b FROM public.brief_bindings x WHERE x.id = p_binding FOR UPDATE;
  r := public.brief_role(b.id, actor, p_assistant);
  IF r IS NULL THEN RAISE EXCEPTION 'brief_not_found'; END IF;
  IF p_need = 'owner' AND r <> 'owner' THEN RAISE EXCEPTION 'brief_owner_required'; END IF;
  IF p_need = 'write' AND r NOT IN ('owner','participant') THEN RAISE EXCEPTION 'brief_owner_required'; END IF;
  IF p_need <> 'repair' AND (b.page_id IS NULL OR NOT public.saved_view_root_operation_scope_allows(b.page_id, true)) THEN
    RAISE EXCEPTION 'brief_unavailable';
  END IF;
  RETURN b;
END $$;

-- ── Commands (actor = app.current_user_id) ─────────────────────────────────

-- Bind a freshly placed page (same transaction as its creation).
CREATE FUNCTION public.brief_bind_page(p_owner_kind text, p_owner_id uuid, p_page uuid, p_layout jsonb, p_locale text, p_assistant uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.brief_actor(); w uuid; snap jsonb; seq bigint; h text; bid uuid; r text;
        start_id text := p_layout ->> 'directionStartId'; stop_id text := p_layout ->> 'contextStartId';
BEGIN
  SELECT sv.workspace_id INTO w FROM public.saved_views sv WHERE sv.id = p_page AND sv.nest_parent_id IS NULL;
  IF w IS NULL THEN RAISE EXCEPTION 'brief_not_found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces x WHERE x.id = w AND x.department_read_v2) THEN
    RAISE EXCEPTION 'brief_requires_department_read';
  END IF;
  IF p_owner_kind = 'project' THEN
    IF NOT EXISTS (SELECT 1 FROM public.saved_views sv WHERE sv.id = p_page AND sv.shared_project_id = p_owner_id) THEN
      RAISE EXCEPTION 'brief_requires_shared_project';
    END IF;
  ELSIF p_owner_kind = 'department' THEN
    IF NOT EXISTS (SELECT 1 FROM public.saved_views sv JOIN public.teamspaces t ON t.id = sv.teamspace_id
                    WHERE sv.id = p_page AND t.workspace_group_id = p_owner_id) THEN
      RAISE EXCEPTION 'brief_not_found';
    END IF;
  ELSE RAISE EXCEPTION 'brief_not_found';
  END IF;
  SELECT d.snapshot_json, d.seq INTO snap, seq FROM public.documents d WHERE d.page_id = p_page;
  IF snap IS NULL THEN RAISE EXCEPTION 'brief_unavailable'; END IF;
  IF public.brief_region(snap, start_id, stop_id) = 'null'::jsonb THEN RAISE EXCEPTION 'brief_ops_invalid'; END IF;
  h := public.brief_region_hash(snap, start_id, stop_id);
  INSERT INTO public.brief_bindings(workspace_id, owner_kind, project_id, department_id, page_id, direction_start_id,
      context_start_id, section_ids, locale, accepted_direction_hash, created_by)
    VALUES (w, p_owner_kind, CASE WHEN p_owner_kind = 'project' THEN p_owner_id END,
      CASE WHEN p_owner_kind = 'department' THEN p_owner_id END, p_page, start_id, stop_id,
      p_layout -> 'sectionIds', coalesce(p_locale, 'en'), h, actor)
    RETURNING id INTO bid;
  r := public.brief_role(bid, actor, p_assistant);
  IF r IS NULL OR r = 'oversight' THEN RAISE EXCEPTION 'brief_not_found'; END IF;
  INSERT INTO public.brief_revisions(workspace_id, binding_id, kind, direction_revision, selection_revision, direction_hash,
      direction_snapshot, page_id, content_seq, actor_user_id, acting_assistant_id)
    VALUES (w, bid, 'created', 0, 0, h, public.brief_region(snap, start_id, stop_id), p_page, seq, actor, p_assistant);
  RETURN bid;
END $$;

CREATE FUNCTION public.brief_save_proposal(p_binding uuid, p_kind text, p_ops jsonb, p_base_revision integer, p_base_hash text,
    p_evidence jsonb, p_sensitivity text, p_compartments text[], p_private_to uuid, p_summary text, p_assistant uuid, p_restore_of uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.brief_actor(); b public.brief_bindings%ROWTYPE; pid uuid;
BEGIN
  b := public.brief_lock_for(p_binding, p_assistant, 'write');
  IF p_kind NOT IN ('draft','proposal') THEN RAISE EXCEPTION 'brief_ops_invalid'; END IF;
  IF p_base_revision > b.direction_revision THEN RAISE EXCEPTION 'brief_revision_stale'; END IF;
  IF p_private_to IS NOT NULL AND p_private_to <> actor THEN RAISE EXCEPTION 'brief_ops_invalid'; END IF;
  IF b.owner_kind = 'project' AND NOT (('project:' || b.project_id::text) = ANY (coalesce(p_compartments, '{}'))) THEN
    RAISE EXCEPTION 'brief_ops_invalid';
  END IF;
  IF p_kind = 'draft' THEN
    UPDATE public.brief_proposals SET ops = p_ops, base_direction_revision = p_base_revision, base_direction_hash = p_base_hash,
        evidence = coalesce(p_evidence, '[]'::jsonb), sensitivity = p_sensitivity, compartments = coalesce(p_compartments, '{}'),
        private_to_user = p_private_to, summary = p_summary, author_assistant_id = p_assistant, updated_at = now()
      WHERE binding_id = p_binding AND author_user_id = actor AND kind = 'draft' AND status = 'open'
      RETURNING id INTO pid;
    IF pid IS NOT NULL THEN RETURN pid; END IF;
  END IF;
  INSERT INTO public.brief_proposals(workspace_id, binding_id, kind, author_user_id, author_assistant_id, summary, ops,
      base_direction_revision, base_direction_hash, restore_of, evidence, sensitivity, compartments, private_to_user)
    VALUES (b.workspace_id, p_binding, p_kind, actor, p_assistant, p_summary, p_ops, p_base_revision, p_base_hash, p_restore_of,
      coalesce(p_evidence, '[]'::jsonb), p_sensitivity, coalesce(p_compartments, '{}'), p_private_to)
    RETURNING id INTO pid;
  RETURN pid;
END $$;

-- Explicit owner acceptance. Atomically writes the binding, the page state,
-- the immutable revision, the proposal status and the receipt. Replays of the
-- same request return the stored receipt.
CREATE FUNCTION public.brief_publish(p_binding uuid, p_proposal uuid, p_ops jsonb, p_expected_direction integer,
    p_expected_selection integer, p_base_seq bigint, p_next_ydoc bytea, p_next_state_vector bytea, p_next_snapshot jsonb,
    p_next_title text, p_idempotency uuid, p_request_hash text, p_evidence jsonb, p_active_work text, p_kind text, p_assistant uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.brief_actor(); b public.brief_bindings%ROWTYPE; prior public.brief_revisions%ROWTYPE;
        prop public.brief_proposals%ROWTYPE; cur jsonb; cur_seq bigint; next_hash text; rid uuid; new_seq bigint;
BEGIN
  IF p_idempotency IS NULL OR p_request_hash IS NULL THEN RAISE EXCEPTION 'brief_ops_invalid'; END IF;
  IF p_kind NOT IN ('apply','restore') OR p_active_work NOT IN ('pause','continue') THEN RAISE EXCEPTION 'brief_ops_invalid'; END IF;
  b := public.brief_lock_for(p_binding, p_assistant, 'owner');
  SELECT * INTO prior FROM public.brief_revisions r WHERE r.binding_id = p_binding AND r.idempotency_key = p_idempotency;
  IF FOUND THEN
    IF prior.request_hash IS DISTINCT FROM p_request_hash THEN RAISE EXCEPTION 'brief_idempotency_conflict'; END IF;
    RETURN jsonb_build_object('revisionId', prior.id, 'directionRevision', prior.direction_revision,
      'selectionRevision', prior.selection_revision, 'contentSeq', prior.content_seq, 'replayed', true);
  END IF;
  IF b.direction_revision <> p_expected_direction OR b.selection_revision <> p_expected_selection THEN
    RAISE EXCEPTION 'brief_revision_stale';
  END IF;
  IF p_proposal IS NOT NULL THEN
    SELECT * INTO prop FROM public.brief_proposals p WHERE p.id = p_proposal AND p.binding_id = p_binding FOR UPDATE;
    IF NOT FOUND OR (prop.kind = 'draft' AND prop.author_user_id <> actor) THEN RAISE EXCEPTION 'brief_not_found'; END IF;
    IF prop.status <> 'open' THEN RAISE EXCEPTION 'brief_proposal_closed'; END IF;
  END IF;
  SELECT d.snapshot_json, d.seq INTO cur, cur_seq FROM public.documents d WHERE d.page_id = b.page_id FOR UPDATE;
  IF cur IS NULL THEN RAISE EXCEPTION 'brief_unavailable'; END IF;
  IF cur_seq <> p_base_seq THEN RAISE EXCEPTION 'brief_page_changed'; END IF;
  IF public.brief_region_hash(cur, b.direction_start_id, b.context_start_id) <> b.accepted_direction_hash THEN
    RAISE EXCEPTION 'brief_unavailable';
  END IF;
  IF public.brief_region(p_next_snapshot, b.direction_start_id, b.context_start_id) = 'null'::jsonb
     OR public.brief_outside(p_next_snapshot, b.direction_start_id, b.context_start_id)
        IS DISTINCT FROM public.brief_outside(cur, b.direction_start_id, b.context_start_id) THEN
    RAISE EXCEPTION 'brief_ops_invalid';
  END IF;
  next_hash := public.brief_region_hash(p_next_snapshot, b.direction_start_id, b.context_start_id);
  IF next_hash = b.accepted_direction_hash THEN RAISE EXCEPTION 'brief_ops_invalid'; END IF;
  UPDATE public.brief_bindings SET direction_revision = direction_revision + 1, accepted_direction_hash = next_hash, updated_at = now()
    WHERE id = p_binding RETURNING * INTO b;
  UPDATE public.documents SET ydoc = p_next_ydoc, state_vector = p_next_state_vector, snapshot_json = p_next_snapshot,
      snapshot_title = coalesce(p_next_title, snapshot_title), seq = seq + 1, updated_at = now()
    WHERE page_id = b.page_id RETURNING seq INTO new_seq;
  INSERT INTO public.brief_revisions(workspace_id, binding_id, kind, direction_revision, selection_revision, direction_hash,
      direction_snapshot, selection, page_id, content_seq, actor_user_id, acting_assistant_id, proposal_id, applied_ops, evidence,
      active_work, idempotency_key, request_hash)
    VALUES (b.workspace_id, p_binding, p_kind, b.direction_revision, b.selection_revision, next_hash,
      public.brief_region(p_next_snapshot, b.direction_start_id, b.context_start_id),
      coalesce((SELECT jsonb_agg(s.department_binding_id ORDER BY s.position) FROM public.brief_department_selections s
                 WHERE s.project_binding_id = p_binding), '[]'::jsonb),
      b.page_id, new_seq, actor, p_assistant, p_proposal, p_ops, coalesce(p_evidence, '[]'::jsonb), p_active_work,
      p_idempotency, p_request_hash)
    RETURNING id INTO rid;
  IF p_proposal IS NOT NULL THEN
    UPDATE public.brief_proposals SET status = 'applied', decided_by = actor, decided_at = now(), revision_id = rid, updated_at = now()
      WHERE id = p_proposal;
  END IF;
  -- The applier's own open draft is consumed by any Apply.
  UPDATE public.brief_proposals SET status = 'superseded', updated_at = now()
    WHERE binding_id = p_binding AND author_user_id = actor AND kind = 'draft' AND status = 'open' AND id IS DISTINCT FROM p_proposal;
  RETURN jsonb_build_object('revisionId', rid, 'directionRevision', b.direction_revision,
    'selectionRevision', b.selection_revision, 'contentSeq', new_seq, 'replayed', false);
END $$;

CREATE FUNCTION public.brief_dismiss(p_proposal uuid, p_assistant uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.brief_actor(); prop public.brief_proposals%ROWTYPE; r text;
BEGIN
  SELECT * INTO prop FROM public.brief_proposals p WHERE p.id = p_proposal FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'brief_not_found'; END IF;
  r := public.brief_role(prop.binding_id, actor, p_assistant);
  IF r IS NULL OR (prop.kind = 'draft' AND prop.author_user_id <> actor) THEN RAISE EXCEPTION 'brief_not_found'; END IF;
  IF r <> 'owner' AND prop.author_user_id <> actor THEN RAISE EXCEPTION 'brief_owner_required'; END IF;
  IF prop.status <> 'open' THEN RAISE EXCEPTION 'brief_proposal_closed'; END IF;
  UPDATE public.brief_proposals SET status = 'dismissed', decided_by = actor, decided_at = now(), updated_at = now() WHERE id = p_proposal;
END $$;

-- Explicit Department rule bindings (D29). No source access is granted and no
-- rule is copied; selection order is display only.
CREATE FUNCTION public.brief_select_departments(p_binding uuid, p_departments uuid[], p_expected_selection integer,
    p_idempotency uuid, p_request_hash text, p_active_work text, p_assistant uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.brief_actor(); b public.brief_bindings%ROWTYPE; prior public.brief_revisions%ROWTYPE;
        cur jsonb; rid uuid; ids uuid[] := coalesce(p_departments, '{}');
BEGIN
  IF p_idempotency IS NULL OR p_request_hash IS NULL OR p_active_work NOT IN ('pause','continue') THEN RAISE EXCEPTION 'brief_selection_invalid'; END IF;
  b := public.brief_lock_for(p_binding, p_assistant, 'owner');
  IF b.owner_kind <> 'project' THEN RAISE EXCEPTION 'brief_selection_invalid'; END IF;
  SELECT * INTO prior FROM public.brief_revisions r WHERE r.binding_id = p_binding AND r.idempotency_key = p_idempotency;
  IF FOUND THEN
    IF prior.request_hash IS DISTINCT FROM p_request_hash THEN RAISE EXCEPTION 'brief_idempotency_conflict'; END IF;
    RETURN jsonb_build_object('revisionId', prior.id, 'directionRevision', prior.direction_revision,
      'selectionRevision', prior.selection_revision, 'replayed', true);
  END IF;
  IF b.selection_revision <> p_expected_selection THEN RAISE EXCEPTION 'brief_revision_stale'; END IF;
  IF cardinality(ids) > 20 OR cardinality(ids) <> (SELECT count(DISTINCT x) FROM unnest(ids) x)
     OR EXISTS (SELECT 1 FROM unnest(ids) x WHERE NOT EXISTS (SELECT 1 FROM public.brief_bindings d
                 WHERE d.id = x AND d.owner_kind = 'department' AND d.workspace_id = b.workspace_id)) THEN
    RAISE EXCEPTION 'brief_selection_invalid';
  END IF;
  DELETE FROM public.brief_department_selections WHERE project_binding_id = p_binding;
  INSERT INTO public.brief_department_selections(project_binding_id, department_binding_id, workspace_id, position, added_by)
    SELECT p_binding, x.id, b.workspace_id, x.ord - 1, actor FROM unnest(ids) WITH ORDINALITY AS x(id, ord);
  UPDATE public.brief_bindings SET selection_revision = selection_revision + 1, updated_at = now() WHERE id = p_binding RETURNING * INTO b;
  SELECT d.snapshot_json INTO cur FROM public.documents d WHERE d.page_id = b.page_id;
  INSERT INTO public.brief_revisions(workspace_id, binding_id, kind, direction_revision, selection_revision, direction_hash,
      direction_snapshot, selection, page_id, actor_user_id, acting_assistant_id, active_work, idempotency_key, request_hash)
    VALUES (b.workspace_id, p_binding, 'selection', b.direction_revision, b.selection_revision, b.accepted_direction_hash,
      public.brief_region(cur, b.direction_start_id, b.context_start_id), to_jsonb(ids), b.page_id, actor, p_assistant,
      p_active_work, p_idempotency, p_request_hash)
    RETURNING id INTO rid;
  RETURN jsonb_build_object('revisionId', rid, 'directionRevision', b.direction_revision,
    'selectionRevision', b.selection_revision, 'replayed', false);
END $$;

-- Idempotent maintenance receipt. A repeated key returns the stored row.
CREATE FUNCTION public.brief_record_receipt(p_binding uuid, p_key text, p_source_kind text, p_source_id text, p_source_version text,
    p_content_hash text, p_result text, p_basis jsonb, p_proposal uuid, p_sensitivity text, p_compartments text[],
    p_private_to uuid, p_assistant uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.brief_actor(); b public.brief_bindings%ROWTYPE; rec public.brief_receipts%ROWTYPE;
BEGIN
  b := public.brief_lock_for(p_binding, p_assistant, 'write');
  SELECT * INTO rec FROM public.brief_receipts r WHERE r.binding_id = p_binding AND r.idempotency_key = p_key;
  IF FOUND THEN RETURN jsonb_build_object('receiptId', rec.id, 'result', rec.result, 'basis', rec.basis, 'replayed', true); END IF;
  IF p_private_to IS NOT NULL AND p_private_to <> actor THEN RAISE EXCEPTION 'brief_ops_invalid'; END IF;
  INSERT INTO public.brief_receipts(workspace_id, binding_id, idempotency_key, source_kind, source_id, source_version, content_hash,
      result, basis, proposal_id, actor_user_id, acting_assistant_id, sensitivity, compartments, private_to_user)
    VALUES (b.workspace_id, p_binding, p_key, p_source_kind, p_source_id, p_source_version, p_content_hash, p_result,
      coalesce(p_basis, '{}'::jsonb), p_proposal, actor, p_assistant, p_sensitivity, coalesce(p_compartments, '{}'), p_private_to)
    RETURNING * INTO rec;
  RETURN jsonb_build_object('receiptId', rec.id, 'result', rec.result, 'basis', rec.basis, 'replayed', false);
END $$;

-- Rebind a missing Brief to a recreated page holding the last accepted region.
CREATE FUNCTION public.brief_repair_bind(p_binding uuid, p_page uuid, p_assistant uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.brief_actor(); b public.brief_bindings%ROWTYPE; snap jsonb; seq bigint; rid uuid;
BEGIN
  b := public.brief_lock_for(p_binding, p_assistant, 'repair');
  IF public.brief_role(b.id, actor, p_assistant) <> 'owner' THEN RAISE EXCEPTION 'brief_owner_required'; END IF;
  IF b.page_id IS NOT NULL THEN RAISE EXCEPTION 'brief_ops_invalid'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.saved_views sv WHERE sv.id = p_page AND sv.workspace_id = b.workspace_id AND sv.nest_parent_id IS NULL
      AND CASE WHEN b.owner_kind = 'project' THEN sv.shared_project_id = b.project_id
               ELSE EXISTS (SELECT 1 FROM public.teamspaces t WHERE t.id = sv.teamspace_id AND t.workspace_group_id = b.department_id) END) THEN
    RAISE EXCEPTION 'brief_not_found';
  END IF;
  SELECT d.snapshot_json, d.seq INTO snap, seq FROM public.documents d WHERE d.page_id = p_page;
  IF snap IS NULL OR public.brief_region_hash(snap, b.direction_start_id, b.context_start_id) <> b.accepted_direction_hash THEN
    RAISE EXCEPTION 'brief_ops_invalid';
  END IF;
  UPDATE public.brief_bindings SET page_id = p_page, updated_at = now() WHERE id = p_binding;
  INSERT INTO public.brief_revisions(workspace_id, binding_id, kind, direction_revision, selection_revision, direction_hash,
      direction_snapshot, page_id, content_seq, actor_user_id, acting_assistant_id)
    VALUES (b.workspace_id, p_binding, 'repair', b.direction_revision, b.selection_revision, b.accepted_direction_hash,
      public.brief_region(snap, b.direction_start_id, b.context_start_id), p_page, seq, actor, p_assistant)
    RETURNING id INTO rid;
  RETURN jsonb_build_object('revisionId', rid, 'directionRevision', b.direction_revision, 'pageId', p_page);
END $$;

-- ── Effective direction (ids and revisions only, no content) ───────────────

CREATE FUNCTION public.brief_effective_basis(p_project_binding uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
      'binding', b.id, 'direction', b.direction_revision, 'selection', b.selection_revision,
      'departments', coalesce((SELECT jsonb_agg(jsonb_build_object('binding', d.id, 'direction', d.direction_revision) ORDER BY d.id)
                                 FROM public.brief_department_selections s JOIN public.brief_bindings d ON d.id = s.department_binding_id
                                WHERE s.project_binding_id = b.id), '[]'::jsonb))
    FROM public.brief_bindings b WHERE b.id = p_project_binding
$$;

-- In a shared Project chat, a Department rule set fits only when every human
-- on the Project roster can read its page at its clearance.
CREATE FUNCTION public.brief_department_fits_audience(p_department_binding uuid, p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((
    SELECT NOT EXISTS (
      SELECT 1 FROM public.project_shared_members m
       WHERE m.project_id = p_project AND m.principal_kind = 'user'
         AND (m.expires_at IS NULL OR m.expires_at > clock_timestamp())
         AND NOT EXISTS (SELECT 1 FROM public.department_edges e
                          WHERE e.department_id = d.department_id AND e.user_id = m.user_id
                            AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())
                            AND public.sensitivity_rank(e.clearance) >= public.sensitivity_rank(sv.clearance)))
      FROM public.brief_bindings d JOIN public.saved_views sv ON sv.id = d.page_id
     WHERE d.id = p_department_binding AND d.owner_kind = 'department'), false)
$$;

-- ── Read policies (writes only through the commands above) ─────────────────

ALTER TABLE public.brief_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brief_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brief_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brief_department_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brief_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brief_work_bases ENABLE ROW LEVEL SECURITY;

CREATE POLICY brief_bindings_read ON public.brief_bindings FOR SELECT USING (public.brief_binding_visible(id));
CREATE POLICY brief_revisions_read ON public.brief_revisions FOR SELECT USING (public.brief_binding_visible(binding_id));
CREATE POLICY brief_selections_read ON public.brief_department_selections FOR SELECT USING (public.brief_binding_visible(project_binding_id));
CREATE POLICY brief_proposals_read ON public.brief_proposals FOR SELECT USING (
  public.brief_binding_visible(binding_id)
  AND (kind <> 'draft' OR author_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  AND (private_to_user IS NULL OR private_to_user = nullif(current_setting('app.current_user_id', true), '')::uuid)
  AND public.department_row_allows((SELECT public.department_read_grants()), workspace_id, sensitivity, compartments, private_to_user));
CREATE POLICY brief_receipts_read ON public.brief_receipts FOR SELECT USING (
  public.brief_binding_visible(binding_id)
  AND (private_to_user IS NULL OR private_to_user = nullif(current_setting('app.current_user_id', true), '')::uuid)
  AND public.department_row_allows((SELECT public.department_read_grants()), workspace_id, sensitivity, compartments, private_to_user));

SELECT public.crm_install_erasure_capture();

COMMIT;
