"use client";

/**
 * Brain sidebar panel — the Brain surface's controls, hoisted into the left
 * sidebar (the sidebar body is surface-aware; the page tree is Home-only).
 *
 * Three TOP-LEVEL SECTION ROWS (the Studio `.doc-nav-active` nav recipe, on
 * the sidebar palette — no primary blue) drive the page through the shared
 * `useBrainSurface()` context, followed by a section-specific body:
 *   - Entries — FILTERS block (header + the shared `search` input + a
 *     vertical option-row list): search → the `/api/brain/list` q, option
 *     rows = primitive kinds (facet-gated presence, selected rows never
 *     hidden). (The List|Graph switch lives in the Brain TOPBAR now, not
 *     here.) Entries is the one section whose body IS the filters, so the
 *     tall list earns its space.
 *   - Skills — a quiet "+ New skill" (opens the creator rendered by the
 *     page), then a COMPACT filter (`CompactFilterBar`): one row of the
 *     shared `search` input + a `Filter` popover over the status options
 *     (All / Active / Suggested / Stale) bound to the context
 *     `skillStatusFilter` the SkillsLibrary pane also reads, then the flat
 *     skill quick-list (suggested-first; rows link to the editor). The body's
 *     job is to LIST the skills — the collapsed filter keeps as many rows
 *     above the fold as possible.
 *   - Reviews — the same COMPACT filter (`CompactFilterBar`): search + a
 *     `Filter` popover whose rows are `REVIEW_FILTERS` — the inbox-mappable
 *     primitive kinds PLUS a `Relationships` chip for `entity_link` graph
 *     edges (bound to the context's review-only `reviewFilters`, not
 *     `primitives`). The body's job is to LIST the pending queue, so the
 *     filter collapses to keep the flat pending list (the MASTER of the
 *     Reviews master-detail) above the fold: clicking a row selects it into
 *     `selectedReviewKey` for the page's `ReviewPanel`. Selecting every type
 *     is the same as `All` (`inboxPrimitivesForSelection` collapses it to one
 *     unscoped fetch so the one remaining chip-less primitive, `entity`,
 *     isn't stranded). The Reviews section row carries an amber count badge
 *     from `brainInboxCount` (hidden at zero).
 *
 * Option rows are multi-select — a selected row gets `.doc-nav-active` plus
 * a trailing check (the check disambiguates from the single-select section
 * rows). `All` clears the group. Any row/action taken while on a Brain
 * SUB-route (the skill editor) first navigates back to `/w/[id]/brain` so
 * the main pane can actually react.
 *
 * Facets, the unconfirmed count, the skill quick-list, and the pending list
 * are fetched here — the panel only mounts on Brain, so there's no
 * off-surface waste; everything refreshes on `BRAIN_REFRESH_EVENT` so a
 * chat-driven brain write keeps the panel current.
 *
 * [COMP:app-web/sidebar-panel-brain]
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Check, ListFilter, Plus } from "lucide-react";
import { useT, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useBrainSurface,
  type BrainSection,
} from "@/contexts/brain-surface-context";
import {
  getBrainFacets,
  type BrainFacets,
  type BrainPrimitive,
} from "@/lib/api/brain";
import {
  brainInboxCount,
  deleteBrainRow,
  verifyBrainRow,
} from "@/lib/api/brain-inbox";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  listWorkspaceSkills,
  type SkillInductionSource,
  type SkillSensitivity,
  type WorkspaceSkillSummary,
} from "@/lib/api/skills";
import { BRAIN_REFRESH_EVENT, requestBrainRefresh } from "@/lib/brain-events";
import {
  fetchReviewItems,
  filterReviewItems,
  REVIEW_FILTERS,
  reviewItemKey,
  runReviewBatch,
  type PendingReviewItem,
} from "@/lib/review-queue";
import {
  filterSkillsForLibrary,
  skillStatus,
  type SkillStatus,
} from "@/lib/skills-view";
import {
  getActiveAssistantId,
  onActiveAssistantChanged,
} from "@/lib/sidebar-cache";

const SECTION_ORDER: BrainSection[] = [
  "entries",
  "skills",
  "blueprints",
  "reviews",
];

/** Entries option order — the FilterStrip chip order minus `all`. */
const ENTRY_OPTIONS: BrainPrimitive[] = [
  "people",
  "companies",
  "deals",
  "tasks",
  "knowledge",
  "memories",
  "files",
  "sessions",
];

const SKILL_STATUS_OPTIONS: SkillStatus[] = ["active", "suggested", "stale"];
const SKILL_SOURCE_OPTIONS: SkillInductionSource[] = [
  "authored",
  "self",
  "ingested",
];
const SKILL_SENSITIVITY_OPTIONS: SkillSensitivity[] = [
  "public",
  "internal",
  "confidential",
];

/** The Studio sidebar nav-row recipe — shared by the section rows, the
 *  vertical filter options, and the quick-list rows (the de-blue: active is
 *  the `.doc-nav-active` pill, never primary blue). */
const rowCls = (active: boolean) =>
  cn(
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
    active
      ? "doc-nav-active font-medium text-sidebar-accent-foreground"
      : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  );

const sectionHeaderCls =
  "px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45";

export function BrainSidebarPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const brain = useBrainSurface();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const [facets, setFacets] = useState<BrainFacets | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(0);
  const [skills, setSkills] = useState<WorkspaceSkillSummary[] | null>(null);
  const [reviewItems, setReviewItems] = useState<PendingReviewItem[] | null>(
    null,
  );
  // Multi-select over the Reviews master list — a Set of review keys, the
  // same pattern as the approvals panel's SelectionToolbar. Bulk verify /
  // delete loop the per-row endpoints; FAILED keys stay selected for retry.
  const [reviewSelected, setReviewSelected] = useState<Set<string>>(new Set());
  const [reviewBatchBusy, setReviewBatchBusy] = useState(false);
  const [reviewBatchError, setReviewBatchError] = useState<string | null>(null);
  const [viewpointAssistantId, setViewpointAssistantId] = useState<string | null>(
    () => getActiveAssistantId(),
  );
  useEffect(() => onActiveAssistantChanged(setViewpointAssistantId), []);

  // The panel also mounts on Brain SUB-routes (the skill editor), where the
  // Brain page — the thing the context state drives — isn't rendered. Any
  // section/filter/selection interaction first walks back to the Brain root.
  const brainRoot = `/w/${workspaceId}/brain`;
  const ensureBrainRoot = () => {
    if (pathname !== brainRoot) router.push(brainRoot);
  };

  // Chip presence — which primitive types have ≥1 row (gates entry options).
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    getBrainFacets(workspaceId, viewpointAssistantId).then((r) => {
      if (!cancelled) setFacets(r);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, viewpointAssistantId]);

  // Reviews badge count — refetched on mount and whenever the brain changes
  // (chat ingest, cross-tab write) so the badge never goes stale.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const refresh = () => {
      void brainInboxCount(workspaceId).then((c) => {
        if (!cancelled) setUnconfirmed(c.total);
      });
    };
    refresh();
    window.addEventListener(BRAIN_REFRESH_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(BRAIN_REFRESH_EVENT, refresh);
    };
  }, [workspaceId]);

  // Skill quick-list for the Skills section body — same refresh contract as
  // the count, so a confirm/create/delete anywhere converges here too.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const refresh = () => {
      void listWorkspaceSkills(workspaceId).then((list) => {
        if (!cancelled) setSkills(list);
      });
    };
    refresh();
    window.addEventListener(BRAIN_REFRESH_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(BRAIN_REFRESH_EVENT, refresh);
    };
  }, [workspaceId]);

  // Pending list (the Reviews master) — fetched while the Reviews section is
  // open, scoped by the Reviews filter selection (the SAME `fetchReviewItems`
  // composition the page's detail pool uses, so order + scope agree), and
  // refreshed on every brain write so acted-on rows drop out.
  useEffect(() => {
    if (!workspaceId || brain.section !== "reviews") return;
    let cancelled = false;
    const refresh = () => {
      void fetchReviewItems(workspaceId, brain.reviewFilters).then((items) => {
        if (!cancelled) setReviewItems(items);
      });
    };
    refresh();
    window.addEventListener(BRAIN_REFRESH_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(BRAIN_REFRESH_EVENT, refresh);
    };
  }, [workspaceId, brain.section, brain.reviewFilters]);

  const sectionLabel: Record<BrainSection, string> = {
    entries: t.brainPage.sections.entries,
    skills: t.brainPage.sections.skills,
    blueprints: t.brainPage.sections.blueprints,
    reviews: t.brainPage.sections.reviews,
  };

  // Suggested-first (same ordering as the library), narrowed by the SHARED
  // search + governance filters so the quick-list and the library pane agree.
  const panelSkills = filterSkillsForLibrary(skills ?? [], {
    search: brain.search,
    statuses: brain.skillStatusFilter,
    sources: brain.skillSourceFilter,
    sensitivities: brain.skillSensitivityFilter,
  });

  const visibleReviews = filterReviewItems(reviewItems ?? [], brain.search);

  // Prune the selection whenever the queue refreshes — acted-on rows (here or
  // anywhere else: the detail panel, another tab) must not linger as selected
  // ghosts. Runs off reviewItems, not visibleReviews, so a search narrowing
  // doesn't silently drop selections.
  useEffect(() => {
    if (reviewItems === null) return;
    const live = new Set(reviewItems.map(reviewItemKey));
    setReviewSelected((prev) => {
      const next = new Set([...prev].filter((k) => live.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [reviewItems]);

  const visibleReviewKeys = visibleReviews.map(reviewItemKey);
  const selectedVisibleCount = visibleReviewKeys.filter((k) =>
    reviewSelected.has(k),
  ).length;
  const allVisibleSelected =
    visibleReviewKeys.length > 0 &&
    selectedVisibleCount === visibleReviewKeys.length;

  const toggleReviewSelect = (key: string) => {
    setReviewSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleReviewSelectAll = () => {
    setReviewSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const k of visibleReviewKeys) next.delete(k);
        return next;
      }
      return new Set([...prev, ...visibleReviewKeys]);
    });
  };

  // Bulk verify ("Looks correct") / delete over the selected keys. Sequential
  // per-row calls (no server batch); succeeded keys drop out on the refresh,
  // failed keys stay selected with a retry-able error line — the approvals
  // panel's partial-failure contract.
  const runReviewBulk = async (decision: "verify" | "delete") => {
    const keys = visibleReviewKeys.filter((k) => reviewSelected.has(k));
    if (keys.length === 0 || !workspaceId) return;
    if (decision === "delete") {
      const ok = await confirmDialog({
        description: format(t.brainPage.reviewPanel.batch.deleteConfirmBody, {
          count: keys.length,
        }),
        confirmLabel: t.memoriesReview.deleteConfirmAction,
        cancelLabel: t.memoriesReview.cancel,
        variant: "destructive",
      });
      if (!ok) return;
    }
    setReviewBatchBusy(true);
    setReviewBatchError(null);
    const { failed } = await runReviewBatch(keys, (primitive, id) =>
      decision === "verify"
        ? verifyBrainRow(workspaceId, primitive, id)
        : deleteBrainRow(workspaceId, primitive, id),
    );
    setReviewBatchBusy(false);
    setReviewSelected(new Set(failed));
    if (failed.length > 0) {
      setReviewBatchError(
        format(t.brainPage.reviewPanel.batch.partialError, {
          count: failed.length,
        }),
      );
    }
    requestBrainRefresh(workspaceId);
  };

  return (
    <div className="flex flex-col gap-3 px-1 pt-1">
      {/* Top-level section rows — Entries / Skills / Reviews. */}
      <div className="flex flex-col gap-0.5">
        {SECTION_ORDER.map((section) => {
          const active = brain.section === section;
          return (
            <button
              key={section}
              type="button"
              aria-pressed={active}
              onClick={() => {
                brain.setSection(section);
                ensureBrainRoot();
              }}
              className={rowCls(active)}
            >
              <span className="min-w-0 flex-1 truncate">
                {sectionLabel[section]}
              </span>
              {section === "reviews" && unconfirmed > 0 && (
                <span className="shrink-0 min-w-[1.1rem] h-[1.1rem] px-1 inline-flex items-center justify-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 text-[10px] font-semibold tabular-nums">
                  {unconfirmed}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Section-specific body. (The List|Graph view switch moved into the
          Brain TOPBAR — `components/brain/brain-topbar.tsx` owns it on every
          size now, so entries' body is just the filters.) */}
      {brain.section === "entries" && (
        <>
          <FilterOptionsBlock
            search={brain.search}
            onSearch={brain.setSearch}
            searchPlaceholder={t.brainPage.search.placeholder}
            allLabel={t.brainPage.filters.all}
            allActive={brain.primitives.length === 0}
            onAll={() => brain.primitives.forEach(brain.togglePrimitive)}
            loading={facets === null}
            options={ENTRY_OPTIONS.filter(
              (p) =>
                facets === null ||
                facets[p] === true ||
                brain.primitives.includes(p),
            ).map((p) => ({
              key: p,
              label: t.brainPage.filters[p],
              active: brain.primitives.includes(p),
              onToggle: () => brain.togglePrimitive(p),
            }))}
          />
        </>
      )}

      {brain.section === "skills" && (
        <>
          {/* Quiet on-palette create — the page renders the creator. */}
          <button
            type="button"
            onClick={() => {
              brain.openSkillCreator();
              ensureBrainRoot();
            }}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-[12px] font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Plus className="size-3.5" aria-hidden />
            {t.brainPage.skills.newSkill}
          </button>

          {/* Compact filter — the Skills body is primarily the quick-list,
              so ALL the governance filters (status / source / sensitivity)
              collapse into a single search + popover row to keep as many
              skills above the fold as possible. This popover is the ONE
              skill filter surface — the library pane renders the result. */}
          <CompactFilterBar
            search={brain.search}
            onSearch={brain.setSearch}
            searchPlaceholder={t.brainPage.skillsLibrary.searchPlaceholder}
            filterLabel={t.brainPage.filters.filterButton}
            allLabel={t.brainPage.filters.all}
            selectedCount={
              brain.skillStatusFilter.length +
              brain.skillSourceFilter.length +
              brain.skillSensitivityFilter.length
            }
            onAll={() => {
              brain.skillStatusFilter.forEach(brain.toggleSkillStatus);
              brain.skillSourceFilter.forEach(brain.toggleSkillSource);
              brain.skillSensitivityFilter.forEach(
                brain.toggleSkillSensitivity,
              );
            }}
            groups={[
              {
                label: t.brainPage.skillsLibrary.statusGroup,
                options: SKILL_STATUS_OPTIONS.map((s) => ({
                  key: s,
                  label:
                    s === "active"
                      ? t.brainPage.skills.statusActive
                      : s === "suggested"
                        ? t.brainPage.skills.statusSuggested
                        : t.brainPage.skills.statusStale,
                  active: brain.skillStatusFilter.includes(s),
                  onToggle: () => brain.toggleSkillStatus(s),
                })),
              },
              {
                label: t.brainPage.skillsLibrary.sourceGroup,
                options: SKILL_SOURCE_OPTIONS.map((s) => ({
                  key: s,
                  label: t.brainPage.skills.inductionSource[s],
                  active: brain.skillSourceFilter.includes(s),
                  onToggle: () => brain.toggleSkillSource(s),
                })),
              },
              {
                label: t.brainPage.skillsLibrary.sensitivityGroup,
                options: SKILL_SENSITIVITY_OPTIONS.map((s) => ({
                  key: s,
                  label: t.brainPage.skills.sensitivity[s],
                  active: brain.skillSensitivityFilter.includes(s),
                  onToggle: () => brain.toggleSkillSensitivity(s),
                })),
              },
            ]}
          />

          {/* Flat quick-list — status dot + name, rows link to the editor. */}
          <ul className="flex flex-col gap-0.5">
            {panelSkills.map((skill) => {
              const href = `${brainRoot}/skills/${skill.rowId}`;
              const status = skillStatus(skill);
              return (
                <li key={skill.rowId}>
                  <Link href={href} className={rowCls(pathname === href)}>
                    <span
                      aria-hidden
                      className={cn(
                        "inline-block h-2 w-2 shrink-0 rounded-full",
                        status === "active" && "bg-emerald-500",
                        status === "suggested" && "bg-amber-500",
                        status === "stale" && "bg-muted-foreground/40",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {brain.section === "blueprints" && (
        /* Blueprints body — just the shared search input. The library pane
           (the page) lists the workspace blueprints + owns "+ New blueprint";
           blueprints have no status/governance filters, so the sidebar stays
           a single needle row (no popover). */
        <input
          type="search"
          value={brain.search}
          onChange={(e) => brain.setSearch(e.target.value)}
          placeholder={t.brainPage.blueprints.searchPlaceholder}
          className={cn(
            "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px]",
            "outline-none focus:ring-2 focus:ring-ring/50 placeholder:text-muted-foreground/60",
          )}
        />
      )}

      {brain.section === "reviews" && (
        <>
          {/* Compact filter — the Reviews body is primarily the pending list,
              so the type filter collapses into a single search + popover row
              (the vertical option list would push the list below the fold). */}
          <CompactFilterBar
            search={brain.search}
            onSearch={brain.setSearch}
            searchPlaceholder={t.brainPage.reviewPanel.searchPlaceholder}
            filterLabel={t.brainPage.filters.filterButton}
            allLabel={t.brainPage.filters.all}
            selectedCount={brain.reviewFilters.length}
            onAll={() => brain.reviewFilters.forEach(brain.toggleReviewFilter)}
            groups={[
              {
                options: REVIEW_FILTERS.map((f) => ({
                  key: f,
                  label:
                    f === "relationships"
                      ? t.brainPage.filters.relationships
                      : t.brainPage.filters[f],
                  active: brain.reviewFilters.includes(f),
                  onToggle: () => brain.toggleReviewFilter(f),
                })),
              },
            ]}
          />

          {/* Multi-select toolbar — select-all + bulk "Looks correct" /
              delete over the checked rows (approvals SelectionToolbar
              pattern; failed rows stay selected for retry). Only mounts
              ONCE a selection exists: at rest the row checkboxes are
              hover-revealed (the Notion/Gmail "click to enter multi-select"
              feel), so the idle list is just dot + name with no chrome. */}
          {selectedVisibleCount > 0 && (
            <div className="flex flex-col gap-1 px-1">
              <div className="flex items-center gap-2 text-[12px] text-sidebar-foreground/70">
                <div className="flex items-center gap-1.5 select-none">
                  <Checkbox
                    checked={allVisibleSelected}
                    indeterminate={
                      selectedVisibleCount > 0 && !allVisibleSelected
                    }
                    onCheckedChange={toggleReviewSelectAll}
                    disabled={reviewBatchBusy}
                    aria-label={t.brainPage.reviewPanel.batch.selectAll}
                  />
                  <button
                    type="button"
                    onClick={toggleReviewSelectAll}
                    disabled={reviewBatchBusy}
                    className="cursor-pointer disabled:cursor-not-allowed"
                  >
                    {format(t.brainPage.reviewPanel.batch.selected, {
                      count: selectedVisibleCount,
                    })}
                  </button>
                </div>
                {selectedVisibleCount > 0 && (
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      disabled={reviewBatchBusy}
                      onClick={() => void runReviewBulk("verify")}
                      className="rounded px-1.5 py-0.5 font-medium text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400 disabled:opacity-50"
                    >
                      {t.brainPage.reviewPanel.batch.confirmSelected}
                    </button>
                    <button
                      type="button"
                      disabled={reviewBatchBusy}
                      onClick={() => void runReviewBulk("delete")}
                      className="rounded px-1.5 py-0.5 font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400 disabled:opacity-50"
                    >
                      {t.brainPage.reviewPanel.batch.deleteSelected}
                    </button>
                  </div>
                )}
              </div>
              {reviewBatchError && (
                <p className="text-[11px] text-red-500" role="alert">
                  {reviewBatchError}
                </p>
              )}
            </div>
          )}

          {/* The master list — clicking a row selects the item the page's
              ReviewPanel shows; the checkbox joins/leaves the bulk
              selection without changing the shown item. The checkbox
              OVERLAYS the amber status dot in the same leading slot and is
              hidden at rest, so an idle row reads exactly like the
              checkbox-less Skills quick-list above (no bolted-on column).
              It fades in on row hover / keyboard focus — that first click is
              how you enter multi-select — and once ANY row is selected
              (`selectedVisibleCount > 0`, selection mode) every row shows
              its box so you can see and extend the selection. */}
          <ul className="flex flex-col gap-0.5">
            {visibleReviews.map((item) => {
              const key = reviewItemKey(item);
              const selectionMode = selectedVisibleCount > 0;
              return (
                <li key={key} className="group/rev relative flex items-center">
                  <button
                    type="button"
                    onClick={() => {
                      brain.setSelectedReviewKey(key);
                      ensureBrainRoot();
                    }}
                    className={rowCls(brain.selectedReviewKey === key)}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500 transition-opacity",
                        // The checkbox takes the dot's place once it shows.
                        selectionMode
                          ? "opacity-0"
                          : "opacity-100 group-hover/rev:opacity-0",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {item.row.name}
                    </span>
                  </button>
                  <Checkbox
                    checked={reviewSelected.has(key)}
                    onCheckedChange={() => toggleReviewSelect(key)}
                    disabled={reviewBatchBusy}
                    aria-label={item.row.name}
                    className={cn(
                      "absolute left-[5px] top-1/2 size-3.5 -translate-y-1/2",
                      selectionMode
                        ? "opacity-100"
                        : "opacity-0 pointer-events-none group-hover/rev:opacity-100 group-hover/rev:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto",
                    )}
                  />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * The tall FILTERS block — header, the shared search input, and a vertical
 * multi-select option list in the same nav-row recipe as the section rows.
 * A selected option gets the `.doc-nav-active` pill PLUS a trailing check —
 * the check is what marks these rows as multi-select next to the
 * single-select section rows above. Entries-only now: list-first sections
 * (Skills, Reviews) use the collapsed `CompactFilterBar` instead.
 */
function FilterOptionsBlock({
  search,
  onSearch,
  searchPlaceholder,
  allLabel,
  allActive,
  onAll,
  options,
  loading,
}: {
  search: string;
  onSearch: (v: string) => void;
  searchPlaceholder: string;
  allLabel: string;
  /** True when nothing in the group is selected. */
  allActive: boolean;
  /** Clears the group's selection. */
  onAll: () => void;
  options: {
    key: string;
    label: string;
    active: boolean;
    onToggle: () => void;
  }[];
  /** Render skeleton rows while presence data loads (entries only). */
  loading?: boolean;
}) {
  const t = useT();
  return (
    <div>
      <div className={sectionHeaderCls}>{t.docPage.sidebarBrainFilters}</div>
      <input
        type="search"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder={searchPlaceholder}
        className={cn(
          "w-full px-2.5 py-1.5 text-[12px] bg-background border border-border rounded-md",
          "outline-none focus:ring-2 focus:ring-ring/50 placeholder:text-muted-foreground/60",
        )}
      />
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {loading ? (
          [0, 1, 2].map((i) => (
            <li key={i} aria-hidden className="px-2 py-1.5">
              <div
                className="h-4 rounded bg-muted animate-pulse"
                style={{ width: `${3.5 + i}rem` }}
              />
            </li>
          ))
        ) : (
          <>
            <li>
              <button
                type="button"
                aria-pressed={allActive}
                onClick={onAll}
                className={rowCls(allActive)}
              >
                <span className="min-w-0 flex-1 truncate">{allLabel}</span>
                {allActive && <Check className="size-3.5 shrink-0" aria-hidden />}
              </button>
            </li>
            {options.map((opt) => (
              <li key={opt.key}>
                <button
                  type="button"
                  aria-pressed={opt.active}
                  onClick={opt.onToggle}
                  className={rowCls(opt.active)}
                >
                  <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                  {opt.active && (
                    <Check className="size-3.5 shrink-0" aria-hidden />
                  )}
                </button>
              </li>
            ))}
          </>
        )}
      </ul>
    </div>
  );
}

type CompactFilterOption = {
  key: string;
  label: string;
  active: boolean;
  onToggle: () => void;
};

/**
 * Compact filter for list-first sections (Skills + Reviews) — one row: the
 * shared search input plus a `Filter` popover holding the same multi-select
 * option rows as `FilterOptionsBlock`, in one or more labelled groups
 * (Reviews passes one unlabelled group; Skills passes Status / Source /
 * Sensitivity). These bodies' job is to LIST (the skill quick-list / the
 * pending queue), so the filter is collapsed to reclaim the vertical space
 * the tall option list would otherwise eat (the list is the point, not the
 * filter). On-palette throughout — the trigger uses the sidebar tokens,
 * never primary blue. A selected-option count (summed across groups) rides
 * the trigger so the active filter is glanceable without opening the
 * popover; zero selected ⇒ `All` (no badge), and the `All` row clears every
 * group at once.
 */
function CompactFilterBar({
  search,
  onSearch,
  searchPlaceholder,
  filterLabel,
  allLabel,
  selectedCount,
  onAll,
  groups,
}: {
  search: string;
  onSearch: (v: string) => void;
  searchPlaceholder: string;
  filterLabel: string;
  allLabel: string;
  /** Number of options currently selected across all groups (0 ⇒ All). */
  selectedCount: number;
  /** Clears every group's selection (back to All). */
  onAll: () => void;
  groups: { label?: string; options: CompactFilterOption[] }[];
}) {
  const allActive = selectedCount === 0;
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="search"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder={searchPlaceholder}
        className={cn(
          "min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px]",
          "outline-none focus:ring-2 focus:ring-ring/50 placeholder:text-muted-foreground/60",
        )}
      />
      <Popover>
        <PopoverTrigger
          aria-label={filterLabel}
          title={filterLabel}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[12px] transition-colors",
            allActive
              ? "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              : "bg-sidebar-accent text-sidebar-accent-foreground",
          )}
        >
          <ListFilter className="size-3.5" aria-hidden />
          {!allActive && (
            <span className="inline-flex h-[1.05rem] min-w-[1.05rem] items-center justify-center rounded-full bg-sidebar-foreground/15 px-1 text-[10px] font-semibold tabular-nums">
              {selectedCount}
            </span>
          )}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-52 p-1">
          <ul className="flex flex-col gap-0.5">
            <li>
              <button
                type="button"
                aria-pressed={allActive}
                onClick={onAll}
                className={rowCls(allActive)}
              >
                <span className="min-w-0 flex-1 truncate">{allLabel}</span>
                {allActive && (
                  <Check className="size-3.5 shrink-0" aria-hidden />
                )}
              </button>
            </li>
            {groups.map((group, gi) => (
              <li key={group.label ?? gi}>
                {group.label && (
                  <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                    {group.label}
                  </div>
                )}
                <ul className="flex flex-col gap-0.5">
                  {group.options.map((opt) => (
                    <li key={opt.key}>
                      <button
                        type="button"
                        aria-pressed={opt.active}
                        onClick={opt.onToggle}
                        className={rowCls(opt.active)}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {opt.label}
                        </span>
                        {opt.active && (
                          <Check className="size-3.5 shrink-0" aria-hidden />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
