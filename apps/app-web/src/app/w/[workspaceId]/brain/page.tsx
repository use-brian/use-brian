"use client";

/**
 * Brain page — `/w/[workspaceId]/brain` (app-web).
 *
 * Ported from `apps/web/src/app/(app)/brain/page.tsx` as the brain surface
 * migration of the app consolidation
 * (docs/plans/doc-web-app-consolidation.md §5a — brain is XL). Primary
 * "browse your stuff" reading/trust surface over the company brain, organised
 * into THREE TOP-LEVEL SECTIONS (the sidebar's Entries / Skills / Reviews
 * rows — brain-skill-management-ux follow-up IA):
 *   - entries — the declarative brain: the force-directed `BrainGraphView`
 *     (the DEFAULT — opens in group colors) or the grouped overview
 *     (`BrainGroupedView` — every primitive bucketed by kind, entities
 *     decorated with degree/neighbour dots, content with sensitivity badges)
 *     behind the topbar's List tab, OR a `<PristineBrainNudge />` hero when
 *     the brain is pristine (the nudge outranks the graph default).
 *   - skills — LIBRARY-FIRST (brain-skill-management-ux.md §11d): the pane
 *     is the `SkillsLibrary` on every size — the full quiet list with the
 *     pinned amber Needs-review band on the unfiltered landing (the
 *     govern-first `SkillsHome` dashboard is retired). The sidebar
 *     quick-list stays as the hop-between master for the editor sub-route.
 *     The `SkillCreator` opens as a takeover from "+ New skill", and IS the
 *     landing hero when the workspace has no skills.
 *   - reviews — a MASTER-DETAIL over `/api/brain-inbox`: the sidebar's flat
 *     pending list is the master; this page renders the selected item in
 *     `ReviewPanel` (verify / delete / more-options via the existing drawer)
 *     and auto-advances the selection after an action. Both sides share
 *     `fetchReviewItems` + the search/primitive scoping
 *     (`lib/review-queue.ts`) so their queues agree; `ReviewAllClear` is the
 *     queue-empty state.
 *   - Entity row click → `BrainDetailDrawer` (the full review workflow).
 *
 * SURFACE-AWARE SIDEBAR REFACTOR + TOPBAR. The section rows + filter options
 * live in the left sidebar (`BrainSidebarPanel`); the doc-style
 * `BrainTopbar` mounted at the top of this pane carries the rest of the
 * chrome — sidebar collapse, history, the Brain breadcrumb, the entries
 * List|Graph view tabs, counts + the clear-filters chip, the reviews pager,
 * and the quiet "+ New skill". Everything drives this page through the
 * shared `useBrainSurface()` context. On `<md` the sidebar is a slide-in
 * drawer, so a compact section control + the entries filter strip (bound to
 * the same context) stay on the page below the topbar.
 * `?view=graph` / `?view=skills` / `?pending=true` deep links are seeded into
 * the context once on mount (the `memories/review` and `/studio/skills`
 * redirects land on the matching section).
 *
 * app-web ADAPTATIONS (vs apps/web):
 *   - Workspace scoping comes from `activeId` via the `useWorkspaces()`
 *     adapter ([COMP:app-web/workspaces-adapter]); the route workspace
 *     IS the active workspace.
 *   - The pristine-nudge CTAs hand into the one assistant chat dock (the
 *     `FloatingChat` mounted once by `WorkspaceChrome` across every surface)
 *     via the `doc:surface-chat-seed` bus.
 *   - `ProvenanceProvider` + `ProvenanceSheet` are mounted locally so the
 *     entity surfaces' `useProvenance()` works without app-chrome.
 *   - Renders full-width inside the `/w/[workspaceId]` layout's `<main>`
 *     (its own chrome, NOT the doc page shell).
 *
 * Spec: docs/plans/company-brain/ui.md → §IA → Brain page.
 *
 * [COMP:app-web/brain-page]
 */

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { useWorkspaces } from "@/contexts/workspace-context";
import { useT, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import {
  getActiveAssistantId,
  onActiveAssistantChanged,
} from "@/lib/sidebar-cache";
import {
  getBrainFacets,
  getBrainGraph,
  listBrain,
  type BrainFacets,
  type BrainGraph,
  type BrainRow,
} from "@/lib/api/brain";
import {
  listWorkspaceSkills,
  type WorkspaceSkillSummary,
} from "@/lib/api/skills";
import {
  createDraft,
  deleteCustomPageTemplate,
  listCustomPageTemplates,
} from "@/lib/api/views";
import type { CustomPageTemplateSummary } from "@sidanclaw/doc-model";
import { blankBlueprintBlocks, filterBlueprints } from "@/lib/blueprints";
import { docPagePath } from "@/lib/doc-page-url";
import {
  BRAIN_REFRESH_EVENT,
  requestBrainRefresh,
  type BrainRefreshDetail,
} from "@/lib/brain-events";
import { useBrainStream } from "@/lib/brain-stream";
import {
  fetchReviewItems,
  filterReviewItems,
  nextReviewKey,
  resolveReviewIndex,
  reviewItemKey,
  type PendingReviewItem,
} from "@/lib/review-queue";
import { suggestedSkillCount } from "@/lib/skills-view";
import { FilterStrip } from "@/components/brain/filter-strip";
import { EmptyState, PristineBrainNudge } from "@/components/brain/empty-state";
import { ReviewAllClear, ReviewPanel } from "@/components/brain/review-panel";
import { BrainTopbar, BrainTopbarPager } from "@/components/brain/brain-topbar";
import { BrainDetailDrawer } from "@/components/brain/detail-drawer";
import { BrainGraphView } from "@/components/brain/graph-view";
import { BrainGroupedView } from "@/components/brain/grouped-view";
import { SkillsLibrary } from "@/components/brain/skills-library";
import { SkillCreator } from "@/components/brain/skill-creator";
import { BlueprintsLibrary } from "@/components/brain/blueprints-library";
import { ProvenanceProvider, useProvenanceState } from "@/components/provenance/provenance-context";
import { ProvenanceSheet } from "@/components/provenance/provenance-sheet";
import {
  useBrainSurface,
  type BrainSection,
} from "@/contexts/brain-surface-context";
import { Button } from "@/components/ui/button";

function BrainPageInner() {
  const { activeId } = useWorkspaces();
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT();
  // The Brain controls live in the sidebar (`BrainSidebarPanel`); this page
  // reads + reacts to their shared state. The mobile inline strip below also
  // binds to these setters. `pendingOnly` is derived (section === 'reviews').
  const {
    section,
    setSection,
    viewMode,
    setViewMode,
    pendingOnly,
    reviewUnconfirmed,
    skillCreatorOpen,
    openSkillCreator,
    closeSkillCreator,
    selectedReviewKey,
    setSelectedReviewKey,
    primitives,
    togglePrimitive,
    reviewFilters,
    setSkillStatusFilter,
    search,
    setSearch,
  } = useBrainSurface();

  // Seed section/view from the URL ONCE on mount — deep links (memories/review
  // → `?pending=true`, a bookmarked `?view=graph`, the `/studio/skills`
  // redirect + skill-editor BackButton → `?view=skills`). Positive-only: an
  // absent param never resets the user's current choice on a normal nav back
  // to Brain.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (searchParams.get("pending") === "true") setSection("reviews");
    if (searchParams.get("view") === "graph") {
      setSection("entries");
      setViewMode("graph");
    }
    if (searchParams.get("view") === "skills") setSection("skills");
  }, [searchParams, setSection, setViewMode]);

  // Any search / filter / pending engagement flips off the pristine nudge, and
  // stays off even after the user clears back to empty.
  const [hasEngaged, setHasEngaged] = useState(false);
  useEffect(() => {
    if (search.length > 0 || primitives.length > 0 || pendingOnly) {
      setHasEngaged(true);
    }
  }, [search, primitives, pendingOnly]);

  const [rows, setRows] = useState<BrainRow[] | null>(null);
  const [selected, setSelected] = useState<BrainRow | null>(null);
  // Completed (done / archived) tasks — fetched separately from the main list
  // (which hides them) so the grouped view can tuck them behind a "Show
  // completed" disclosure that leads with live work. Only fetched when tasks
  // are in scope (All or the Tasks chip).
  const [completedTasks, setCompletedTasks] = useState<BrainRow[] | null>(null);
  const [showCompletedTasks, setShowCompletedTasks] = useState(false);
  // Skills — the procedural-brain primitive, fetched separately (skills don't
  // flow through `/api/brain/list`). The Skills SECTION owns the library; this
  // page-level copy backs the library pane, the graph-node → drawer
  // resolution, and the pristine-nudge count.
  const [skills, setSkills] = useState<WorkspaceSkillSummary[] | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<WorkspaceSkillSummary | null>(
    null,
  );
  // Blueprints — fillable page templates (those carrying an `extraction` spec).
  // Fetched from the page-templates list and filtered client-side; refetched on
  // every brain refresh so a create/delete converges. The Blueprints SECTION
  // owns the library pane. See structural-synthesis.md.
  const [blueprints, setBlueprints] = useState<
    CustomPageTemplateSummary[] | null
  >(null);
  // The Reviews detail pool — fetched via the SAME `fetchReviewItems`
  // composition the sidebar's master list uses, so scope + order agree and
  // the shared selection key resolves identically on both sides.
  const [reviewItems, setReviewItems] = useState<PendingReviewItem[] | null>(
    null,
  );
  // Active assistant — caps what brain rows are returned (clearance ceiling).
  // app-web has no chrome picker writing it yet, so this is null by default
  // (= no viewpoint cap). See sidebar-cache.ts.
  const [viewpointAssistantId, setViewpointAssistantId] = useState<string | null>(() => getActiveAssistantId());
  useEffect(() => onActiveAssistantChanged(setViewpointAssistantId), []);

  const [refreshTick, setRefreshTick] = useState(0);

  const [graph, setGraph] = useState<BrainGraph | null>(null);
  const [facets, setFacets] = useState<BrainFacets | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<BrainRefreshDetail>).detail;
      if (detail?.workspaceId && detail.workspaceId !== activeId) return;
      setRefreshTick((n) => n + 1);
    };
    window.addEventListener(BRAIN_REFRESH_EVENT, handler);
    return () => window.removeEventListener(BRAIN_REFRESH_EVENT, handler);
  }, [activeId]);

  // Realtime brain stream — listens for cross-process writes (Claude Code via
  // MCP, chat from another tab/device) and dispatches `BRAIN_REFRESH_EVENT`.
  useBrainStream(activeId);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;

    // Reviews — the master-detail pool, scoped by the Reviews filter
    // selection (search needle-filters client-side below, so a keystroke
    // never refetches).
    if (section === "reviews") {
      fetchReviewItems(activeId, reviewFilters).then((items) => {
        if (cancelled) return;
        setReviewItems(items);
      });
      return () => {
        cancelled = true;
      };
    }

    listBrain({
      workspaceId: activeId,
      primitives: primitives.length ? primitives : undefined,
      search: search || undefined,
      viewpointAssistantId,
      limit: 100,
    }).then((result) => {
      if (cancelled) return;
      setRows(result.rows);
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeId,
    section,
    primitives,
    reviewFilters,
    search,
    viewpointAssistantId,
    refreshTick,
  ]);

  // Completed tasks for the grouped view's "Show completed" disclosure. Only
  // fetched when the Entries section has tasks in scope (All, or the Tasks
  // chip selected) — otherwise the completed list is cleared so it never
  // surfaces under an unrelated primitive filter. The main list above hides
  // these (`taskStatus` defaults to active), so there's no overlap.
  const tasksInScope = primitives.length === 0 || primitives.includes("tasks");
  useEffect(() => {
    if (!activeId || section !== "entries" || !tasksInScope) {
      setCompletedTasks(null);
      return;
    }
    let cancelled = false;
    listBrain({
      workspaceId: activeId,
      primitives: ["tasks"],
      taskStatus: "completed",
      search: search || undefined,
      viewpointAssistantId,
      limit: 100,
    }).then((result) => {
      if (cancelled) return;
      setCompletedTasks(result.rows);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, section, tasksInScope, search, viewpointAssistantId, refreshTick]);

  // Workspace graph snapshot — needed by BOTH browse modes: the grouped default
  // decorates its entity rows with degree + neighbour-kind dots, and the graph
  // mode renders the force-directed doc. Fetched whenever the workspace /
  // viewpoint changes (not gated on viewMode). `showMemory` is always on —
  // memory is a first-class node kind (connected-only keeps the set bounded).
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    getBrainGraph({
      workspaceId: activeId,
      viewpointAssistantId,
      showMemory: true,
    }).then((result) => {
      if (cancelled) return;
      setGraph(result);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, viewpointAssistantId, refreshTick]);

  // Facets (which primitive types have ≥1 row) back the mobile FilterStrip's
  // chip presence; the sidebar panel fetches its own copy for the desktop strip.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    getBrainFacets(activeId, viewpointAssistantId).then((result) => {
      if (cancelled) return;
      setFacets(result);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, viewpointAssistantId, refreshTick]);

  // Workspace skills (the procedural-brain primitive) — refetched on every
  // brain refresh so confirm / edit / delete from the detail panel converge.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    listWorkspaceSkills(activeId).then((result) => {
      if (cancelled) return;
      setSkills(result);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, refreshTick]);

  // Workspace blueprints (fillable templates) — fetched on every brain refresh,
  // the same contract as skills, so a create/delete from the library converges.
  // The list API returns every page template; the library filters to those with
  // an `extraction` spec.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    listCustomPageTemplates(activeId).then((result) => {
      if (cancelled) return;
      setBlueprints(result);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, refreshTick]);

  // Skill row clicks (library + sidebar quick-list) open the FULL editor page
  // (brain-skill-management-ux.md §3.1); only the graph-node click path keeps
  // the quick-look drawer.
  const openSkillEditor = (skill: WorkspaceSkillSummary) => {
    if (!activeId) return;
    router.push(`/w/${activeId}/brain/skills/${skill.rowId}`);
  };

  // "+ New blueprint" — seed a blank blueprint doc (a heading + an empty
  // extraction slot) and open it in the editor, where the author fills the slot
  // and saves it as a blueprint template. Mirrors the doc-shell "New template"
  // create flow (createDraft -> navigate). The author saves it as a template
  // (with its extraction spec) from the editor's "Save as template" path.
  const openNewBlueprint = async () => {
    if (!activeId) return;
    try {
      const created = await createDraft({
        workspaceId: activeId,
        name: t.brainPage.blueprints.newBlueprintTitle,
        blocks: blankBlueprintBlocks() as never,
      });
      router.push(docPagePath(activeId, created.id));
    } catch {
      // Surface nothing destructive — a failed draft create is a no-op; the
      // user can retry. (The doc-shell create path owns the richer error UI.)
    }
  };

  // Delete a blueprint (a page template) after the library's confirm resolved.
  // Optimistically drop it, then refetch to converge with the server.
  const deleteBlueprint = async (template: CustomPageTemplateSummary) => {
    if (!activeId) return;
    setBlueprints((prev) => prev?.filter((b) => b.id !== template.id) ?? prev);
    await deleteCustomPageTemplate(activeId, template.id).catch(() => {});
    requestBrainRefresh(activeId);
  };

  // Knowledge rows open the ENTRY READER directly (grouped list + graph
  // node click alike) — the reader is the default knowledge surface, not
  // a drawer hop (knowledge-base.md → "Reader surface"). Every other kind
  // keeps the quick-look drawer (entities + memories carry their
  // verify/adjust governance there).
  const openRow = (row: BrainRow) => {
    if (row.kind === "knowledge" && activeId) {
      router.push(`/w/${activeId}/brain/entry/knowledge/${row.id}`);
      return;
    }
    setSelected(row);
  };

  // The VISIBLE review queue (search needle applied) — selection, position,
  // and auto-advance all run over this list so they match what the sidebar
  // master shows.
  const visibleReviews =
    reviewItems === null ? null : filterReviewItems(reviewItems, search);
  const reviewIndex =
    visibleReviews === null ? -1 : resolveReviewIndex(visibleReviews, selectedReviewKey);
  const currentReview =
    visibleReviews !== null && reviewIndex >= 0
      ? visibleReviews[reviewIndex]
      : null;

  // Keep the stored selection explicit: when nothing is selected (or the
  // selected item vanished — acted on from the drawer, filtered out, or
  // refreshed away) snap it to the resolved item so the sidebar highlight
  // always matches the panel.
  useEffect(() => {
    if (section !== "reviews" || visibleReviews === null) return;
    if (visibleReviews.length === 0) {
      if (selectedReviewKey !== null) setSelectedReviewKey(null);
      return;
    }
    const resolved = reviewItemKey(
      visibleReviews[resolveReviewIndex(visibleReviews, selectedReviewKey)],
    );
    if (resolved !== selectedReviewKey) setSelectedReviewKey(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visibleReviews derives from reviewItems+search
  }, [section, reviewItems, search, selectedReviewKey, setSelectedReviewKey]);

  // Auto-advance: after a verify/delete, select the next item (previous when
  // the last one was acted on) BEFORE the refresh drops the acted row.
  const handleReviewActed = (actedKey: string) => {
    setSelectedReviewKey(nextReviewKey(visibleReviews ?? [], actedKey));
    if (activeId) requestBrainRefresh(activeId);
  };

  const loading = rows === null;
  // The graph is a SEPARATE data source from the `/list` rows: `/list` searches
  // the CRM (contact/company/deal) + memory/file/task scopes, while the graph
  // surfaces knowledge-graph ENTITIES (person/company/project/… in `entities`).
  // A workspace can have graph entities but zero list rows — so "pristine" must
  // consider BOTH, else a brain with only entity nodes (e.g. one extracted
  // person) renders the empty nudge and hides the populated graph. Treat the
  // graph as still-loading (null) as "not yet empty" to avoid a nudge flash
  // before it arrives.
  const graphLoading = graph === null;
  const graphHasNodes = (graph?.nodes.length ?? 0) > 0;
  // The pristine nudge counts skills too — a workspace whose only brain
  // content is a skill isn't pristine.
  const showNoData =
    !loading &&
    !graphLoading &&
    rows.length === 0 &&
    !graphHasNodes &&
    (skills?.length ?? 0) === 0 &&
    !search &&
    primitives.length === 0 &&
    !pendingOnly &&
    !hasEngaged;
  const showNoResults =
    !loading &&
    rows.length === 0 &&
    (search.length > 0 || primitives.length > 0 || pendingOnly || hasEngaged);

  // ── Topbar clusters (page-injected — the bar itself stays generic). ──
  const topbarCopy = t.brainPage.topbar;
  // Search counts as one active filter alongside the primitive chips.
  const activeFilterCount = primitives.length + (search.trim() ? 1 : 0);
  const clearFilters = () => {
    primitives.forEach(togglePrimitive);
    setSearch("");
  };
  const suggestedCount = suggestedSkillCount(skills ?? []);

  const topbarCenter =
    section === "entries" ? (
      /* List | Graph view tabs — the topbar owns the view switch on every
         size now (the sidebar VIEW block + mobile toggle are gone). */
      <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5 text-[12px]">
        {/* Graph leads — it is the entries default. */}
        <button
          type="button"
          aria-label={t.brainPage.viewToggle.graphAria}
          aria-pressed={viewMode === "graph"}
          onClick={() => setViewMode("graph")}
          className={cn(
            "rounded px-2.5 py-0.5 transition-colors",
            viewMode === "graph"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t.brainPage.viewToggle.graph}
        </button>
        <button
          type="button"
          aria-label={t.brainPage.viewToggle.listAria}
          aria-pressed={viewMode === "grouped"}
          onClick={() => setViewMode("grouped")}
          className={cn(
            "rounded px-2.5 py-0.5 transition-colors",
            viewMode === "grouped"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t.brainPage.viewToggle.list}
        </button>
      </div>
    ) : section === "reviews" &&
      visibleReviews !== null &&
      visibleReviews.length > 0 ? (
      <BrainTopbarPager
        current={reviewIndex + 1}
        total={visibleReviews.length}
        onPrev={() => {
          const prev = visibleReviews[reviewIndex - 1];
          if (prev) setSelectedReviewKey(reviewItemKey(prev));
        }}
        onNext={() => {
          const next = visibleReviews[reviewIndex + 1];
          if (next) setSelectedReviewKey(reviewItemKey(next));
        }}
      />
    ) : null;

  const topbarRight =
    section === "entries" ? (
      <>
        {rows !== null && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {rows.length === 1
              ? topbarCopy.entryCountOne
              : format(topbarCopy.entryCountMany, { count: rows.length })}
          </span>
        )}
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-full border border-border bg-card px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {activeFilterCount === 1
              ? topbarCopy.filtersOne
              : format(topbarCopy.filtersMany, { count: activeFilterCount })}
            {" · "}
            {topbarCopy.clearFilters}
          </button>
        )}
      </>
    ) : section === "skills" ? (
      <>
        {skills !== null && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {skills.length === 1
              ? t.brainPage.skillsLibrary.countOne
              : format(t.brainPage.skillsLibrary.countMany, {
                  count: skills.length,
                })}
          </span>
        )}
        {suggestedCount > 0 && (
          /* Amber jump chip — scopes the library to exactly the suggested
             rows (the topbar's one governance shortcut). */
          <button
            type="button"
            onClick={() => setSkillStatusFilter(["suggested"])}
            className="text-xs tabular-nums text-amber-700 underline-offset-4 transition-colors hover:underline dark:text-amber-400"
          >
            {format(topbarCopy.suggestedCount, { count: suggestedCount })}
          </button>
        )}
        <button
          type="button"
          onClick={openSkillCreator}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3.5" aria-hidden />
          {t.brainPage.skills.newSkill}
        </button>
      </>
    ) : section === "blueprints" ? (
      <>
        {blueprints !== null && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {filterBlueprints(blueprints).length === 1
              ? t.brainPage.blueprints.countOne
              : format(t.brainPage.blueprints.countMany, {
                  count: filterBlueprints(blueprints).length,
                })}
          </span>
        )}
        <button
          type="button"
          onClick={() => void openNewBlueprint()}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3.5" aria-hidden />
          {t.brainPage.blueprints.newBlueprint}
        </button>
      </>
    ) : null;

  return (
    <div className="h-full w-full overflow-y-auto flex flex-col">
      <BrainTopbar
        workspaceId={activeId ?? ""}
        center={topbarCenter}
        right={topbarRight}
      />

      {/* Mobile-only inline controls — the section switch + entry filters
          live in the sidebar on desktop, but the sidebar is a slide-in drawer
          at `<md`, so keep them here, bound to the same context. (The view
          switch and "+ New skill" live in the topbar on every size.) */}
      <div className="md:hidden flex flex-col gap-2 border-b border-border bg-muted/20 px-3 py-2.5">
        {/* Three-way section segmented control — Entries / Skills / Reviews. */}
        <div className="inline-flex w-full rounded-md border border-border bg-muted/30 p-0.5 text-[12px]">
          {(["entries", "skills", "blueprints", "reviews"] as BrainSection[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={section === s}
              onClick={() => setSection(s)}
              className={cn(
                "flex-1 rounded px-2 py-1 transition-colors",
                section === s
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.brainPage.sections[s]}
            </button>
          ))}
        </div>
        {section === "entries" && (
          <FilterStrip
            collapsed
            hidePending
            selectedPrimitives={primitives}
            onTogglePrimitive={togglePrimitive}
            search={search}
            onSearch={setSearch}
            pendingOnly={pendingOnly}
            onTogglePending={reviewUnconfirmed}
            presentPrimitives={facets}
          />
        )}
      </div>

      <div className="flex flex-1 min-h-0 flex-col">
        {section === "reviews" ? (
          /* Reviews master-detail — the sidebar lists the queue; this pane
             shows the selected item with verify / delete / more-options and
             auto-advances after an action. */
          visibleReviews === null ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              …
            </div>
          ) : currentReview === null ? (
            (reviewItems?.length ?? 0) > 0 ? (
              /* The fetch found items but the search/chips filtered them all
                 out — a no-results state, not the all-clear celebration. */
              <EmptyState />
            ) : (
              <ReviewAllClear />
            )
          ) : activeId ? (
            <ReviewPanel
              key={reviewItemKey(currentReview)}
              workspaceId={activeId}
              item={currentReview}
              onActed={handleReviewActed}
              onMoreOptions={() => setSelected(currentReview.row)}
            />
          ) : null
        ) : section === "skills" ? (
          /* Skills section — LIBRARY-FIRST (plan §11d): the pane is the
             `SkillsLibrary` on every size — the full quiet list with the
             pinned amber Needs-review band on the unfiltered landing. The
             sidebar quick-list stays as the hop-between master (it matters
             most on the editor sub-route); the pane and the quick-list
             showing the same collection on the root is deliberate. The
             creator renders as a takeover when "+ New skill" opens it
             (BackButton → library), and as the LANDING hero when the
             workspace has no skills (the creator IS the empty state). */
          activeId ? (
            skillCreatorOpen || (skills !== null && skills.length === 0) ? (
              <SkillCreator
                workspaceId={activeId}
                onBack={
                  skillCreatorOpen && (skills?.length ?? 0) > 0
                    ? closeSkillCreator
                    : undefined
                }
                onCreated={(skill) => {
                  closeSkillCreator();
                  requestBrainRefresh(activeId);
                  openSkillEditor(skill);
                }}
              />
            ) : skills === null ? (
              <div className="flex-1 py-16 text-center text-sm text-muted-foreground">
                …
              </div>
            ) : (
              <SkillsLibrary
                workspaceId={activeId}
                skills={skills}
                onNewSkill={openSkillCreator}
                onOpenSkill={openSkillEditor}
              />
            )
          ) : null
        ) : section === "blueprints" ? (
          /* Blueprints section — the library pane lists the workspace's
             fillable templates (those with an extraction spec). Sibling of the
             skills library; structural-synthesis.md -> "The blueprint object".
             "+ New blueprint" (topbar) seeds a blank blueprint doc and opens
             the editor; row delete confirms through the on-brand dialog. */
          activeId ? (
            <BlueprintsLibrary
              workspaceId={activeId}
              blueprints={blueprints}
              search={search}
              onNewBlueprint={() => void openNewBlueprint()}
              onDeleteBlueprint={(template) => void deleteBlueprint(template)}
            />
          ) : null
        ) : viewMode === "graph" && !showNoData ? (
          /* Graph is the entries DEFAULT — but a pristine brain still gets
             the onboarding nudge below, not an empty canvas. */
          <BrainGraphView
            graph={graph ?? { nodes: [], edges: [], truncated: false }}
            loading={graph === null}
            focusQuery={search}
            onSelect={openRow}
            onSelectSkillNode={(skillRowId) => {
              const match = skills?.find((s) => s.rowId === skillRowId);
              if (match) setSelectedSkill(match);
            }}
          />
        ) : loading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            …
          </div>
        ) : showNoData ? (
          <PristineBrainNudge />
        ) : showNoResults ? (
          <EmptyState />
        ) : (
          <BrainGroupedView
            rows={rows ?? []}
            graph={graph}
            onSelect={openRow}
            completedTasks={completedTasks}
            showCompletedTasks={showCompletedTasks}
            onToggleCompletedTasks={() => setShowCompletedTasks((v) => !v)}
          />
        )}
      </div>

      {activeId && (
        <BrainDetailDrawer
          row={selected}
          skill={selectedSkill}
          workspaceId={activeId}
          onClose={() => {
            setSelected(null);
            setSelectedSkill(null);
          }}
        />
      )}

      {/* The assistant chat dock is mounted ONCE by WorkspaceChrome across all
          non-doc surfaces (it stamps `appOrigin: 'brain'` here). The brain
          pristine-nudge CTAs seed it via `requestBrainChatSeed`. */}

      {/* Provenance sheet host — entity surfaces call `useProvenance().open()`. */}
      <ProvenanceSheetHost />
    </div>
  );
}

/** Renders the provenance sheet from the provider's state. Mounted inside
 *  `ProvenanceProvider` so `useProvenanceState()` resolves. */
function ProvenanceSheetHost() {
  const { row, episode, close } = useProvenanceState();
  return <ProvenanceSheet row={row} episode={episode} onClose={close} />;
}

export default function BrainPage() {
  return (
    <ProvenanceProvider>
      <BrainPageInner />
    </ProvenanceProvider>
  );
}
