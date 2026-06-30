"use client";

/**
 * Brain surface controls — the shared state behind the Brain sidebar panel and
 * the Brain page.
 *
 * WHY A LAYOUT-LEVEL CONTEXT. The Brain controls (the Entries / Skills /
 * Reviews section rows, the list/graph toggle, primitive filters, search) now
 * live in the LEFT SIDEBAR (`BrainSidebarPanel`, rendered by `DocSidebar`
 * inside `WorkspaceChrome`), while the rows + drawer + graph + library they
 * drive live in the Brain PAGE (`app/w/[id]/brain/page.tsx`, a child of the
 * workspace layout). The sidebar and the page are in separate subtrees, so the
 * controls' state must live at or above the layout that contains both — the
 * same placement `DocSidebarDataProvider` already uses. Mounted in
 * `app/w/[workspaceId]/layout.tsx`.
 *
 * SECTION MODEL (brain-skill-management-ux follow-up IA). The Brain has three
 * top-level sections: `entries` (the declarative brain — grouped/graph
 * browse), `skills` (the procedural library + creator + editor), and
 * `reviews` (the pending-changes queue). `pendingOnly` is DERIVED from the
 * section — Reviews IS the pending queue, there is no separate toggle.
 * `viewMode` (grouped/graph) scopes the entries section only.
 *
 * PURE STATE, NO `useSearchParams` HERE. Reading `useSearchParams()` in a
 * layout-level client component forces every child route into a client-render
 * bailout (and the "wrap in Suspense" requirement). So this provider keeps all
 * controls as plain state. The Brain PAGE — which legitimately uses the
 * router and only mounts on `/brain` — seeds section + view from the URL ONCE
 * on mount (positive-only: a present `?view=graph` / `?view=skills` /
 * `?pending=true` seeds the matching state, an absent param never resets the
 * user's current choice). That preserves the `memories/review` →
 * `/brain?pending=true` and `/studio/skills` → `/brain?view=skills` deep
 * links without de-opting the whole `/w/[id]` route tree. State persists
 * across a surface switch (the provider never remounts) and resets on a hard
 * reload.
 *
 * [COMP:app-web/brain-surface-context]
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { BrainPrimitive } from "@/lib/api/brain";
import type {
  SkillInductionSource,
  SkillSensitivity,
} from "@/lib/api/skills";
import type { ReviewFilter } from "@/lib/review-queue";
import type { SkillStatus } from "@/lib/skills-view";

/** Top-level Brain section — the sidebar's stacked rows. `blueprints` is the
 *  fillable-template library (structural-synthesis.md): page templates carrying
 *  an `extraction` spec, a sibling of the procedural `skills` library. */
export type BrainSection = "entries" | "skills" | "reviews" | "blueprints";

/** `graph` (force-directed doc — the DEFAULT entries surface) or
 *  `grouped` (the list overview behind the List toggle). Scopes the
 *  `entries` section only. */
export type BrainViewMode = "grouped" | "graph";

export type BrainSurface = {
  section: BrainSection;
  setSection: (next: BrainSection) => void;
  viewMode: BrainViewMode;
  setViewMode: (next: BrainViewMode) => void;
  /** Derived: the Reviews section IS the pending-changes queue. */
  pendingOnly: boolean;
  /** Jump into the pending-changes review (the Reviews section). */
  reviewUnconfirmed: () => void;
  /** Skill creator (full-pane takeover the PAGE renders inside the skills
   *  section) — state lives here so the SIDEBAR's "+ New skill" can open it. */
  skillCreatorOpen: boolean;
  openSkillCreator: () => void;
  closeSkillCreator: () => void;
  /** Reviews master-detail selection — `reviewItemKey` of the pending item
   *  the main pane shows (`lib/review-queue.ts`). The SIDEBAR's flat pending
   *  list sets it; the PAGE resolves it against the visible queue (null or a
   *  vanished key falls back to the first item) and auto-advances it after a
   *  verify/delete. */
  selectedReviewKey: string | null;
  setSelectedReviewKey: (key: string | null) => void;
  /** Selected primitive-type filters; empty = all. Scopes the ENTRIES list
   *  (`/api/brain/list` kinds). Reviews has its own `reviewFilters` (it can
   *  filter `relationships`, which isn't a brain-list primitive). */
  primitives: BrainPrimitive[];
  togglePrimitive: (p: BrainPrimitive) => void;
  /** Reviews-only type filters; empty = all. Separate from `primitives`
   *  because the Reviews queue can filter `relationships` (the `entity_link`
   *  inbox primitive — graph edges), which has no `BrainPrimitive`. Mapped to
   *  inbox primitives by `reviewFilterToInboxPrimitive` in `review-queue.ts`. */
  reviewFilters: ReviewFilter[];
  toggleReviewFilter: (f: ReviewFilter) => void;
  /** Skill status filter (All / Active / Suggested / Stale); empty = all.
   *  Shared by the sidebar's filter popover and the SkillsLibrary pane so
   *  the two surfaces always agree. The setter exists for jump affordances
   *  (the topbar's "N suggested" → exactly ['suggested']). */
  skillStatusFilter: SkillStatus[];
  toggleSkillStatus: (s: SkillStatus) => void;
  setSkillStatusFilter: (next: SkillStatus[]) => void;
  /** Skill governance filters (source / sensitivity); empty = all. Shared
   *  for the same reason as `skillStatusFilter` — the sidebar popover is the
   *  ONE filter surface, the pane just renders the filtered list. */
  skillSourceFilter: SkillInductionSource[];
  toggleSkillSource: (s: SkillInductionSource) => void;
  skillSensitivityFilter: SkillSensitivity[];
  toggleSkillSensitivity: (s: SkillSensitivity) => void;
  /** Free-text search. One box, section-scoped consumption: entries send it
   *  as the list `q`, skills filter name/description client-side, reviews
   *  needle-filter the pending queue. */
  search: string;
  setSearch: (v: string) => void;
};

const BrainSurfaceContext = createContext<BrainSurface | null>(null);

export function useBrainSurface(): BrainSurface {
  const ctx = useContext(BrainSurfaceContext);
  if (!ctx) {
    throw new Error(
      "useBrainSurface must be used within a <BrainSurfaceProvider>",
    );
  }
  return ctx;
}

export function BrainSurfaceProvider({
  children,
}: {
  /** Accepted for symmetry with the other workspace providers; unused. */
  workspaceId?: string;
  children: React.ReactNode;
}) {
  const [section, setSection] = useState<BrainSection>("entries");
  // Graph is the entries default — the brain opens on the Obsidian-style
  // canvas (group colors); the grouped list lives behind the List toggle.
  const [viewMode, setViewMode] = useState<BrainViewMode>("graph");
  const [skillCreatorOpen, setSkillCreatorOpen] = useState(false);
  const [selectedReviewKey, setSelectedReviewKey] = useState<string | null>(
    null,
  );
  const [primitives, setPrimitives] = useState<BrainPrimitive[]>([]);
  const [reviewFilters, setReviewFilters] = useState<ReviewFilter[]>([]);
  const [skillStatusFilter, setSkillStatusFilter] = useState<SkillStatus[]>([]);
  const [skillSourceFilter, setSkillSourceFilter] = useState<
    SkillInductionSource[]
  >([]);
  const [skillSensitivityFilter, setSkillSensitivityFilter] = useState<
    SkillSensitivity[]
  >([]);
  const [search, setSearch] = useState("");

  const reviewUnconfirmed = useCallback(() => setSection("reviews"), []);
  // Opening the creator also lands on the skills section — the creator only
  // renders there, so a caller outside it would otherwise no-op silently.
  const openSkillCreator = useCallback(() => {
    setSection("skills");
    setSkillCreatorOpen(true);
  }, []);
  const closeSkillCreator = useCallback(() => setSkillCreatorOpen(false), []);
  const togglePrimitive = useCallback((p: BrainPrimitive) => {
    setPrimitives((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  }, []);
  const toggleReviewFilter = useCallback((f: ReviewFilter) => {
    setReviewFilters((prev) =>
      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f],
    );
  }, []);
  const toggleSkillStatus = useCallback((s: SkillStatus) => {
    setSkillStatusFilter((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }, []);
  const toggleSkillSource = useCallback((s: SkillInductionSource) => {
    setSkillSourceFilter((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }, []);
  const toggleSkillSensitivity = useCallback((s: SkillSensitivity) => {
    setSkillSensitivityFilter((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }, []);

  const value = useMemo<BrainSurface>(
    () => ({
      section,
      setSection,
      viewMode,
      setViewMode,
      pendingOnly: section === "reviews",
      reviewUnconfirmed,
      skillCreatorOpen,
      openSkillCreator,
      closeSkillCreator,
      selectedReviewKey,
      setSelectedReviewKey,
      primitives,
      togglePrimitive,
      reviewFilters,
      toggleReviewFilter,
      skillStatusFilter,
      toggleSkillStatus,
      setSkillStatusFilter,
      skillSourceFilter,
      toggleSkillSource,
      skillSensitivityFilter,
      toggleSkillSensitivity,
      search,
      setSearch,
    }),
    [
      section,
      viewMode,
      reviewUnconfirmed,
      skillCreatorOpen,
      openSkillCreator,
      closeSkillCreator,
      selectedReviewKey,
      primitives,
      togglePrimitive,
      reviewFilters,
      toggleReviewFilter,
      skillStatusFilter,
      toggleSkillStatus,
      skillSourceFilter,
      toggleSkillSource,
      skillSensitivityFilter,
      toggleSkillSensitivity,
      search,
    ],
  );

  return (
    <BrainSurfaceContext.Provider value={value}>
      {children}
    </BrainSurfaceContext.Provider>
  );
}
