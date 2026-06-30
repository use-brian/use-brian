"use client";

/**
 * BrainDetailDrawer — right-sliding preview + review surface for a brain
 * list row.
 *
 * Replaces the legacy `/brain-inbox/[primitive]/[rowId]` full-page detail
 * view. Hosts the entire data-review workflow inline:
 *
 *   • Confirm  — verify the row as-is (hidden once verified).
 *   • Adjust   — scope + sensitivity tweak (memory v1).
 *   • Edit     — summary + detail rewrite (memory v1).
 *   • Delete   — soft delete with inline confirm.
 *   • Ask      — opens InspectionDrawer for an ephemeral chat.
 *   • Why?     — collapsible source-session context (lazy /explain).
 *
 * Adjust / edit work post-confirm too: the underlying memory adjust
 * route supersedes the row, writes `memory_verifications`
 * audit rows for each changed field, and re-stamps verified. That audit
 * trail is the workspace's learning signal — same path as the original
 * unverified review flow, surfaced here so users can correct facts
 * after they've already approved them.
 *
 * Width: w-full sm:w-[420px] lg:w-[560px] — roughly 1/3 of a desktop
 * doc, matching the ProvenanceSheet pattern.
 *
 * Spec: docs/architecture/brain/corrections.md.
 *
 * Ported verbatim from apps/web (docs/plans/doc-web-app-consolidation.md
 * §5a — brain surface migration). All dependencies (brain / brain-inbox
 * SDKs, react-markdown, InspectionDrawer, EntityRow, Select, Popover)
 * resolve in app-web unchanged.
 *
 * [COMP:app-web/brain-detail-drawer]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import {
  type BrainRow,
  type EntityKind,
  type EntityRollup,
  type KnowledgeEntryDetail,
  getEntity,
  getKnowledgeEntry,
} from "@/lib/api/brain";
import { getActiveAssistantId } from "@/lib/sidebar-cache";
import { requestBrainRefresh } from "@/lib/brain-events";
import { authFetch } from "@/lib/auth-fetch";
import {
  type AdjustMemoryChanges,
  type BrainInboxRowDetail,
  type BrainPrimitive as InboxPrimitive,
  type ExplainContext,
  adjustBrainRow,
  brainFileContentUrl,
  deleteBrainRow,
  explainBrainRow,
  fetchBrainRow,
  verifyBrainRow,
  reclassifyEntityKind,
  promoteEntityToCrm,
  type PromoteToCrmParams,
  fetchCrmCompanion,
  addEntityAlias,
  removeEntityAlias,
} from "@/lib/api/brain-inbox";
import { goalForTask, confirmGoal, workGoal, type GoalRow } from "@/lib/api/goals";
import {
  type WorkspaceSkillSummary,
  confirmSkill,
  updateSkill,
  deleteSkill,
} from "@/lib/api/skills";
import { InspectionDrawer } from "@/components/memories/inspection-drawer";
import { EntityRow } from "@/components/brain/entity-row";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { MoreHorizontal } from "lucide-react";

// Chat-home (default ON, live 2026-06-03): the drawer reads as a clean View +
// Why surface, with the secondary / destructive actions (Change type, Delete)
// tucked behind a "More" overflow menu instead of crowding the primary action
// row. NEXT_PUBLIC_CHAT_HOME_ENABLED=false puts every action back inline
// (rollback). Build-time inlined env.
const CHAT_HOME_FLIP = process.env.NEXT_PUBLIC_CHAT_HOME_ENABLED !== "false";

type OverflowItem = {
  key: string;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

/** "More" overflow menu for the drawer's secondary row actions. Each action
 *  changes `mode`, which unmounts the view-mode row (and this trigger), so
 *  the popover closes on its own. */
function OverflowMenu({ items, ariaLabel }: { items: OverflowItem[]; ariaLabel: string }) {
  if (items.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={ariaLabel}
        className="text-xs px-2 py-1.5 rounded-md border border-border text-muted-foreground hover:bg-muted inline-flex items-center"
      >
        <MoreHorizontal className="w-4 h-4" />
      </PopoverTrigger>
      <PopoverContent align="end" className="min-w-40 p-1">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            disabled={it.disabled}
            onClick={it.onClick}
            className={cn(
              "w-full text-left text-xs px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50",
              it.destructive
                ? "text-red-500 hover:bg-red-500/10"
                : "text-foreground hover:bg-muted",
            )}
          >
            {it.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

type Props = {
  row: BrainRow | null;
  /** When set (and `row` is null), the drawer renders the skill detail panel —
   *  the procedural-brain primitive
   *  (docs/plans/skills-as-procedural-brain-primitive.md §7.1): body + governance
   *  block + trust actions (Confirm / Edit / Delete). Skills are a different data
   *  shape than `BrainRow`, so they arrive fully-formed rather than being
   *  re-fetched by id. */
  skill?: WorkspaceSkillSummary | null;
  workspaceId: string;
  onClose: () => void;
};

type Mode = "view" | "edit" | "delete" | "change-type";
type Scope = "personal" | "workspace_shared" | "workspace";
type Sensitivity = "public" | "internal" | "confidential";

const ENTITY_KINDS = new Set<EntityKind>([
  "person",
  "company",
  "project",
  "deal",
  "product",
  "repository",
  "other",
]);

/** Body fields that should never reach the user — provenance plumbing
 *  not entry content. */
const HIDDEN_BODY_KEYS = new Set([
  "source_episode_id",
  "source_session_id",
  "assistant_id",
  "user_id",
  "verified_by_user_id",
  "verified_at",
  "original_scope",
  "original_sensitivity",
  "original_summary",
]);

/** Map a brain-list row kind to the inbox primitive used by the
 *  primitive-detail fetch. Returns null for kinds that don't have a
 *  primitive-shape detail surface (knowledge, sessions). Entity kinds
 *  (person/company/project/deal/product/other) map to the 'entity'
 *  primitive — entities live in the `entities` table and share the
 *  brain-inbox verify/adjust/delete shell with other primitives. */
function brainKindToInboxPrimitive(
  kind: BrainRow["kind"],
): InboxPrimitive | null {
  switch (kind) {
    case "memories":
      return "memory";
    case "tasks":
      return "task";
    case "files":
      return "workspace_file";
    case "people":
      return "contact";
    case "companies":
      return "company";
    case "deals":
      return "deal";
    case "person":
    case "company":
    case "project":
    case "deal":
    case "product":
    case "other":
      return "entity";
    default:
      return null;
  }
}

/** Matches the `duration-300` on the animate-in/animate-out classes
 *  below. Used to delay unmount on close so the slide-out keyframe can
 *  finish before the DOM node disappears. */
const ANIMATION_MS = 300;

export function BrainDetailDrawer({ row, skill, workspaceId, onClose }: Props) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;
  // `displayRow` is what we *render*. It lingers after `row` clears so
  // the slide-out keyframe has a chance to play before unmount.
  const [displayRow, setDisplayRow] = useState<BrainRow | null>(null);
  // Mirror of `displayRow` for the skill primitive — same linger-on-close
  // behaviour so the slide-out keyframe plays before unmount.
  const [displaySkill, setDisplaySkill] = useState<WorkspaceSkillSummary | null>(
    null,
  );
  const [closing, setClosing] = useState(false);
  const displayRowRef = useRef<BrainRow | null>(null);
  displayRowRef.current = displayRow;
  const displaySkillRef = useRef<WorkspaceSkillSummary | null>(null);
  displaySkillRef.current = displaySkill;
  const [entity, setEntity] = useState<EntityRollup | null | undefined>(
    undefined,
  );
  const [primitive, setPrimitive] = useState<
    BrainInboxRowDetail | null | undefined
  >(undefined);
  // Knowledge entries have no `entity` row and no inbox primitive, so
  // they're fetched through a dedicated brain route. `undefined` means
  // "loading", `null` means "not a knowledge row or fetch failed".
  const [knowledge, setKnowledge] = useState<
    KnowledgeEntryDetail | null | undefined
  >(undefined);
  // CRM specialization rows (contact/company/deal) link back to a canonical
  // entity via `body.entity_id`. We fetch that entity's rollup so the drawer
  // can render the linked memories / files / edges / episodes — same surfaces
  // a non-CRM entity row gets via EntitySection. `null` means "not applicable
  // or no canonical entity"; `undefined` means "still loading".
  const [crmEntity, setCrmEntity] = useState<EntityRollup | null | undefined>(
    undefined,
  );
  // Bumped after an entity mutation (adjust / reclassify / promote /
  // alias add+remove) so the read-only `entity` rollup re-fetches — the
  // rollup backs EntityBody + the alias list, neither of which the
  // optimistic `onUpdated` payload covers (e.g. `kind` after reclassify).
  const [entityRefreshTick, setEntityRefreshTick] = useState(0);
  const requestEntityRefresh = useCallback(() => {
    setEntityRefreshTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (row || skill) {
      setDisplayRow(row);
      setDisplaySkill(skill ?? null);
      setClosing(false);
      return;
    }
    if (!displayRowRef.current && !displaySkillRef.current) return;
    setClosing(true);
    const id = window.setTimeout(() => {
      setDisplayRow(null);
      setDisplaySkill(null);
      setClosing(false);
    }, ANIMATION_MS);
    return () => window.clearTimeout(id);
  }, [row, skill]);

  // ESC closes — the row-driven effect above then handles the animation.
  useEffect(() => {
    if (!row && !skill) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [row, skill, onClose]);

  // Reset + refetch detail state when the displayed row changes.
  // Entity kinds fan out to two fetches: getEntity for the attribute
  // rollup (per-kind humanised labels) and fetchBrainRow for the
  // verification + adjust state shared with every other primitive.
  // Graph-view click on a CRM-kind entity (person/company/deal) arrives
  // with row.kind = the entity-table value and row.id = entities.id —
  // the lean projection. The rich detail surface (tags, domain,
  // relationships, etc) lives in the contacts/companies/deals
  // specialization row. Resolve the companion before fetching so the
  // drawer always renders the same payload the list view shows. When
  // there's no companion (non-CRM kind, or CRM-kind missing its row)
  // we fall back to the lean entity view.
  useEffect(() => {
    setEntity(undefined);
    setPrimitive(undefined);
    setCrmEntity(undefined);
    setKnowledge(undefined);
    if (!displayRow) return;

    let cancelled = false;
    const kind = displayRow.kind;
    const isCrmEntityKind =
      kind === "person" || kind === "company" || kind === "deal";

    // Knowledge rows resolve through a dedicated brain route — no entity
    // rollup, no inbox primitive. Short-circuit the rest of the loader.
    if (kind === "knowledge") {
      getKnowledgeEntry(
        displayRow.id,
        workspaceId,
        getActiveAssistantId(),
      ).then((result) => {
        if (!cancelled) setKnowledge(result);
      });
      return () => {
        cancelled = true;
      };
    }

    async function loadDetail() {
      if (!displayRow) return;
      let routedKind = displayRow.kind;
      let routedId = displayRow.id;

      // CRM-entity-kind redirect (graph click → list-equivalent fetch).
      if (isCrmEntityKind) {
        const companion = await fetchCrmCompanion(workspaceId, displayRow.id);
        if (cancelled) return;
        if (companion) {
          routedKind =
            companion.primitive === "company"
              ? "companies"
              : companion.primitive === "contact"
                ? "people"
                : "deals";
          routedId = companion.id;
          // Swap displayRow so downstream `isEntityKind`, edit handlers,
          // and the resync-on-detail-change effect all see the redirected
          // row. Same shape as the list view would have passed.
          setDisplayRow({
            id: routedId,
            kind: routedKind as BrainRow["kind"],
            name: displayRow.name,
            sensitivity: displayRow.sensitivity,
          });
          return; // The setDisplayRow above re-triggers this effect; let it run again.
        }
      }

      const inboxPrim = brainKindToInboxPrimitive(routedKind);
      const isEntity = ENTITY_KINDS.has(routedKind as EntityKind);
      if (isEntity) {
        getEntity(routedId, workspaceId, getActiveAssistantId()).then((result) => {
          if (!cancelled) setEntity(result);
        });
      }
      if (inboxPrim) {
        fetchBrainRow(workspaceId, inboxPrim, routedId).then((result) => {
          if (!cancelled) setPrimitive(result);
        });
      } else if (!isEntity) {
        setPrimitive(null);
      }
    }

    void loadDetail();

    return () => {
      cancelled = true;
    };
  }, [displayRow, workspaceId]);

  // Entity-rollup re-fetch on mutation. `entityRefreshTick` bumps after
  // an entity adjust / reclassify / promote / alias change — the
  // optimistic `onUpdated` payload patches the inbox primitive but not
  // the read-only rollup (EntityBody attributes, kind, alias list), so
  // re-pull it in place. Scoped to entity-kind rows and gated on
  // `tick > 0` so the initial mount stays on the loader above (no
  // double-fetch, no loading flash on the rollup we already have).
  useEffect(() => {
    if (entityRefreshTick === 0) return;
    if (!displayRow) return;
    if (!ENTITY_KINDS.has(displayRow.kind as EntityKind)) return;
    let cancelled = false;
    getEntity(displayRow.id, workspaceId, getActiveAssistantId()).then(
      (result) => {
        if (!cancelled) setEntity(result);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [entityRefreshTick, displayRow, workspaceId]);

  // After the CRM primitive arrives (contact/company/deal), follow its
  // `entity_id` to fetch the canonical entity's rollup so we can render
  // the linked memories / files / edges / episodes inline. Non-CRM
  // primitives (memory/task/file) short-circuit to `null`.
  useEffect(() => {
    setCrmEntity(undefined);
    if (!displayRow || primitive === undefined) return;
    const inboxPrim = brainKindToInboxPrimitive(displayRow.kind);
    const isCrm =
      inboxPrim === "contact" || inboxPrim === "company" || inboxPrim === "deal";
    if (!isCrm || primitive === null) {
      setCrmEntity(null);
      return;
    }
    const entityId =
      typeof primitive.body.entity_id === "string"
        ? primitive.body.entity_id
        : null;
    if (!entityId) {
      setCrmEntity(null);
      return;
    }
    let cancelled = false;
    getEntity(entityId, workspaceId, getActiveAssistantId()).then((result) => {
      if (!cancelled) setCrmEntity(result);
    });
    return () => {
      cancelled = true;
    };
  }, [displayRow, primitive, workspaceId]);

  // Skill primitive — its own drawer shell (governance block + body + trust
  // actions). Rendered ahead of the row branch so a skill open short-circuits
  // the entity/primitive/knowledge machinery (which keys on `displayRow`).
  if (displaySkill && !displayRow) {
    return (
      <SkillDrawer
        skill={displaySkill}
        workspaceId={workspaceId}
        closing={closing}
        onClose={onClose}
      />
    );
  }

  if (!displayRow) return null;

  const isEntityKind = ENTITY_KINDS.has(displayRow.kind as EntityKind);
  const isKnowledgeKind = displayRow.kind === "knowledge";
  const inboxPrim = brainKindToInboxPrimitive(displayRow.kind);
  // Each kind waits on the fetch that backs its render branch.
  const loading = isKnowledgeKind
    ? knowledge === undefined
    : isEntityKind
      ? entity === undefined || primitive === undefined
      : primitive === undefined;
  const notFound =
    !loading &&
    ((isKnowledgeKind && knowledge === null) ||
      (isEntityKind && entity === null) ||
      (!isKnowledgeKind && inboxPrim !== null && primitive === null));

  // Header title derives from the live primitive body so a rename
  // reflects immediately — `onUpdated` patches `primitive`, but never
  // `displayRow`. Entities carry the name in `display_name`; CRM rows in
  // `name` (falling back to `display_name`). Both fall back to the
  // list-supplied `displayRow.name` while loading or for kinds without a
  // primitive body (knowledge).
  const liveName =
    primitive && typeof primitive.body.display_name === "string"
      ? primitive.body.display_name
      : primitive && typeof primitive.body.name === "string"
        ? primitive.body.name
        : null;
  const headerName =
    liveName && liveName.trim().length > 0 ? liveName : displayRow.name;

  // The kind / sensitivity / summary badges share the title's staleness:
  // `onUpdated` patches `primitive.body` but never `displayRow`, so editing
  // sensitivity to "public" (or reclassifying the kind, or rewriting a memory
  // summary) left these reading the frozen list snapshot. Derive each from the
  // live body, falling back to the list value while the primitive loads or for
  // kinds with no primitive body (knowledge). For non-entity primitives the
  // kind lives in `displayRow.kind` (memories / tasks / …), not the body.
  const headerSensitivity =
    primitive && typeof primitive.body.sensitivity === "string"
      ? primitive.body.sensitivity
      : displayRow.sensitivity;
  const headerKind =
    primitive && typeof primitive.body.kind === "string"
      ? primitive.body.kind
      : displayRow.kind;
  const headerSummary =
    primitive && typeof primitive.body.summary === "string"
      ? primitive.body.summary
      : displayRow.summary;

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-background/40 backdrop-blur-[2px]",
          "duration-300 ease-out",
          closing ? "animate-out fade-out-0" : "animate-in fade-in-0",
        )}
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label={headerName}
        className={cn(
          "fixed top-0 right-0 bottom-0 z-50",
          "w-full sm:w-[420px] lg:w-[560px] bg-popover border-l border-border shadow-2xl",
          "flex flex-col overflow-hidden",
          "duration-300 ease-out will-change-transform",
          closing
            ? "animate-out slide-out-to-right"
            : "animate-in slide-in-from-right",
        )}
      >
        <header className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border">
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary uppercase tracking-wide">
                {headerKind}
              </span>
              {headerSensitivity && (
                <span
                  className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide border",
                    headerSensitivity === "confidential" &&
                      "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
                    headerSensitivity === "restricted" &&
                      "bg-red-700/10 text-red-800 dark:text-red-300 border-red-700/30",
                    headerSensitivity === "internal" &&
                      "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
                    headerSensitivity === "public" &&
                      "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
                  )}
                >
                  {headerSensitivity}
                </span>
              )}
            </div>
            <h2 className="text-base font-semibold break-words leading-snug">
              {headerName}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={labels.close}
            className="h-7 w-7 rounded hover:bg-muted inline-flex items-center justify-center text-muted-foreground shrink-0"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          {headerSummary && (
            <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
              {headerSummary}
            </p>
          )}

          {loading && (
            <div className="text-sm text-muted-foreground">{labels.loading}</div>
          )}

          {notFound && (
            <div className="flex flex-col gap-2 p-3 rounded-md border border-border bg-card/50">
              <div className="text-sm font-medium">{labels.notFoundTitle}</div>
              <p className="text-xs text-muted-foreground">
                {labels.notFoundBody}
              </p>
            </div>
          )}

          {!loading && !notFound && isEntityKind && entity && primitive && (
            <EntitySection
              workspaceId={workspaceId}
              entity={entity}
              detail={primitive}
              onClose={onClose}
              onUpdated={(next) => {
                setPrimitive(next);
                // Re-pull the read-only rollup (kind / attributes /
                // aliases can change on adjust / reclassify / promote)
                // and tell the brain page to refetch its list + facets +
                // graph + unconfirmed count so the row behind the drawer
                // stops being stale.
                requestEntityRefresh();
                requestBrainRefresh(workspaceId);
              }}
            />
          )}

          {!loading && !notFound && isKnowledgeKind && knowledge && (
            <KnowledgeSection entry={knowledge} />
          )}

          {!loading && !notFound && !isEntityKind && !isKnowledgeKind && primitive && inboxPrim && (
            <PrimitiveSection
              workspaceId={workspaceId}
              primitive={inboxPrim}
              detail={primitive}
              crmEntity={crmEntity}
              onClose={onClose}
              onUpdated={(next) => {
                setPrimitive(next);
                // Keep the brain page (list row, facets, graph,
                // unconfirmed count) in sync with this verify / adjust.
                requestBrainRefresh(workspaceId);
              }}
            />
          )}
        </div>
      </aside>
    </>
  );
}

// ── Knowledge body (read-only — synced from external sources) ─────

/**
 * Read-only preview for a `knowledge` brain row.
 *
 * Knowledge entries come from the `knowledge_entries` table, written by
 * `github_sync` from a connected repo. They have no entity row, no
 * inbox primitive, and no Verify/Edit/Delete affordances — the source
 * of truth lives in the repo. The drawer just surfaces the document
 * body so the user doesn't have to bounce out to GitHub to see what
 * the brain has indexed.
 */
function KnowledgeSection({ entry }: { entry: KnowledgeEntryDetail }) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;

  return (
    <>
      {entry.summary && (
        <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
          {entry.summary}
        </p>
      )}

      {entry.content.trim().length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            {labels.knowledgeContentHeading}
          </h3>
          <div className="chat-markdown text-sm leading-relaxed break-words">
            <Markdown>{entry.content}</Markdown>
          </div>
        </section>
      ) : (
        <p className="text-xs text-muted-foreground">{labels.noBody}</p>
      )}

      <section className="flex flex-col gap-2 border-t border-border pt-3">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
          {labels.detailsHeading}
        </h3>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-sm">
          <div className="contents">
            <dt className="text-xs text-muted-foreground">
              {labels.knowledgePathLabel}
            </dt>
            <dd className="break-all font-mono text-[12px]">{entry.path}</dd>
          </div>
          {entry.tags.length > 0 && (
            <div className="contents">
              <dt className="text-xs text-muted-foreground">
                {labels.knowledgeTagsLabel}
              </dt>
              <dd className="flex flex-wrap gap-1">
                {entry.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border"
                  >
                    {tag}
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>
        <p className="text-[11px] text-muted-foreground mt-1">
          {format(labels.knowledgeUpdatedAt, {
            date: new Date(entry.updatedAt).toLocaleString(),
          })}
        </p>
      </section>
    </>
  );
}

// ── Entity body (read-only in v1) ─────────────────────────────────

/**
 * Change-type panel for the entity detail drawer.
 *
 * Two flavours behind one dropdown:
 *
 *   - Non-CRM kinds (product / project / tenant.* etc) →
 *     `POST /reclassify` — a direct UPDATE on entities.kind.
 *
 *   - CRM kinds (company / person / deal) →
 *     `POST /promote-to-crm` — atomic UPDATE + INSERT on the companion
 *     contacts/companies/deals row. Sub-form captures the minimum CRM
 *     fields (domain / email / stage). Required-stage validation for
 *     'deal' is enforced both server- and client-side.
 *
 * Sibling components (`PromoteCompanyFields` etc) are not extracted —
 * each is ~10 lines and inlining keeps the conditional flow readable.
 */
type ChangeTypePanelProps = {
  workspaceId: string;
  entityId: string;
  currentKind: string;
  currentName: string;
  onCancel: () => void;
  onChanged: (nextKind: string) => void;
};

type DealStage = "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost";

function ChangeTypePanel({
  workspaceId,
  entityId,
  currentKind,
  currentName,
  onCancel,
  onChanged,
}: ChangeTypePanelProps) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;

  const [targetKind, setTargetKind] = useState<string>(
    currentKind === "product" ? "company" : "product",
  );
  const [reason, setReason] = useState("");

  // Promotion sub-fields. Independent state so switching kinds doesn't
  // clobber a half-typed value.
  const [domain, setDomain] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [stage, setStage] = useState<DealStage>("lead");
  const [amount, setAmount] = useState<string>("");
  const [closeDate, setCloseDate] = useState<string>("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCrmKind = targetKind === "company" || targetKind === "person" || targetKind === "deal";
  const isDeal = targetKind === "deal";

  async function submit() {
    setBusy(true);
    setError(null);

    if (!isCrmKind) {
      const result = await reclassifyEntityKind(
        workspaceId,
        entityId,
        targetKind,
        reason.trim() || undefined,
      );
      setBusy(false);
      if (!result.ok) { setError(result.error); return; }
      onChanged(result.kind);
      return;
    }

    // CRM promotion path.
    const params: PromoteToCrmParams = {
      kind: targetKind as "company" | "person" | "deal",
      ...(reason.trim() ? { reason: reason.trim() } : {}),
      ...(currentName.trim() ? { name: currentName.trim() } : {}),
    };
    if (targetKind === "company" && domain.trim()) {
      params.domain = domain.trim();
    }
    if (targetKind === "person") {
      if (email.trim()) params.email = email.trim();
      if (phone.trim()) params.phone = phone.trim();
    }
    if (isDeal) {
      params.stage = stage;
      if (amount.trim()) {
        const n = Number(amount);
        if (!Number.isFinite(n)) {
          setError(labels.kindLabel + ": amount must be a number");
          setBusy(false);
          return;
        }
        params.amount = n;
      }
      if (closeDate.trim()) params.closeDate = closeDate;
    }

    const result = await promoteEntityToCrm(workspaceId, entityId, params);
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    onChanged(result.kind);
  }

  return (
    <section className="flex flex-col gap-3 border border-amber-500/30 bg-amber-50/30 dark:bg-amber-950/10 rounded-md p-3">
      <div className="flex flex-col gap-1">
        <h4 className="text-xs uppercase tracking-wide text-amber-700 dark:text-amber-300">
          {labels.changeTypeHeading}
        </h4>
        <p className="text-xs text-muted-foreground">
          {labels.changeTypeHint}
        </p>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-sm items-start">
        <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
          {labels.kindLabel}
        </dt>
        <dd>
          <Select
            value={targetKind}
            onValueChange={(v) => { if (v) setTargetKind(v); }}
            disabled={busy}
            items={{
              product: labels.kindOptions.product,
              project: labels.kindOptions.project,
              repository: labels.kindOptions.repository,
              company: labels.kindOptions.company,
              person: labels.kindOptions.person,
              deal: labels.kindOptions.deal,
            }}
          >
            <SelectTrigger className="text-xs w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectItem value="product">{labels.kindOptions.product}</SelectItem>
              <SelectItem value="project">{labels.kindOptions.project}</SelectItem>
              <SelectItem value="repository">{labels.kindOptions.repository}</SelectItem>
              <SelectItem value="company">{labels.kindOptions.company}</SelectItem>
              <SelectItem value="person">{labels.kindOptions.person}</SelectItem>
              <SelectItem value="deal">{labels.kindOptions.deal}</SelectItem>
            </SelectContent>
          </Select>
        </dd>

        {targetKind === "company" && (
          <>
            <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
              {labels.promoteCompanyDomain}
            </dt>
            <dd>
              <input
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="example.com"
                disabled={busy}
                className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
              />
            </dd>
          </>
        )}

        {targetKind === "person" && (
          <>
            <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
              {labels.promotePersonEmail}
            </dt>
            <dd>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
              />
            </dd>
            <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
              {labels.promotePersonPhone}
            </dt>
            <dd>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={busy}
                className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
              />
            </dd>
          </>
        )}

        {isDeal && (
          <>
            <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
              {labels.promoteDealStage}
            </dt>
            <dd>
              <Select
                value={stage}
                onValueChange={(v) => { if (v) setStage(v as DealStage); }}
                disabled={busy}
                items={{
                  lead: labels.dealStages.lead,
                  qualified: labels.dealStages.qualified,
                  proposal: labels.dealStages.proposal,
                  negotiation: labels.dealStages.negotiation,
                  won: labels.dealStages.won,
                  lost: labels.dealStages.lost,
                }}
              >
                <SelectTrigger className="text-xs w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectItem value="lead">{labels.dealStages.lead}</SelectItem>
                  <SelectItem value="qualified">{labels.dealStages.qualified}</SelectItem>
                  <SelectItem value="proposal">{labels.dealStages.proposal}</SelectItem>
                  <SelectItem value="negotiation">{labels.dealStages.negotiation}</SelectItem>
                  <SelectItem value="won">{labels.dealStages.won}</SelectItem>
                  <SelectItem value="lost">{labels.dealStages.lost}</SelectItem>
                </SelectContent>
              </Select>
            </dd>
            <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
              {labels.promoteDealAmount}
            </dt>
            <dd>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={busy}
                className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
              />
            </dd>
            <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
              {labels.promoteDealCloseDate}
            </dt>
            <dd>
              <input
                type="date"
                value={closeDate}
                onChange={(e) => setCloseDate(e.target.value)}
                disabled={busy}
                className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
              />
            </dd>
          </>
        )}

        <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
          {t.memoriesReview.why}
        </dt>
        <dd>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={labels.changeTypeReasonPlaceholder}
            disabled={busy}
            className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
          />
        </dd>
      </dl>

      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy
            ? isCrmKind
              ? labels.promoteSubmitting
              : labels.reclassifySubmitting
            : isCrmKind
              ? labels.promoteSubmit
              : labels.reclassifySubmit}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
        >
          {t.memoriesReview.cancel}
        </button>
      </div>
    </section>
  );
}

/**
 * Read+write surface for the alias-as-data store. Shows existing
 * aliases as chips with a remove affordance and an inline add form.
 * Conflicts (alias already bound to another entity) surface a
 * targeted error message — the user can resolve by picking a
 * different alias or running `dedupeEntities`.
 */
function AliasesSection({
  workspaceId,
  entityId,
  initialAliases,
}: {
  workspaceId: string;
  entityId: string;
  initialAliases: string[];
}) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;

  const [aliases, setAliases] = useState<string[]>(initialAliases);
  const [draftAlias, setDraftAlias] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAliases(initialAliases);
    setDraftAlias("");
    setError(null);
  }, [entityId, initialAliases]);

  async function submitAdd() {
    const value = draftAlias.trim();
    if (value.length === 0) return;
    setBusy(true);
    setError(null);
    const result = await addEntityAlias(workspaceId, entityId, value);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAliases(result.aliases);
    setDraftAlias("");
    // Aliases feed search + the entity rollup — refresh the brain page so
    // the row behind the drawer reflects the new alias.
    requestBrainRefresh(workspaceId);
  }

  async function submitRemove(alias: string) {
    setBusy(true);
    setError(null);
    const result = await removeEntityAlias(workspaceId, entityId, alias);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAliases(result.aliases);
    // Aliases feed search + the entity rollup — refresh the brain page so
    // the row behind the drawer reflects the removal.
    requestBrainRefresh(workspaceId);
  }

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-3">
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
        {labels.aliasesHeading}
      </h3>
      {aliases.length === 0 && (
        <p className="text-xs text-muted-foreground">{labels.aliasesEmpty}</p>
      )}
      {aliases.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {aliases.map((alias) => (
            <li
              key={alias}
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border"
            >
              <span className="font-mono">{alias}</span>
              <button
                type="button"
                aria-label={labels.aliasRemove}
                disabled={busy}
                onClick={() => submitRemove(alias)}
                className="text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  aria-hidden
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={draftAlias}
          onChange={(e) => setDraftAlias(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) {
              e.preventDefault();
              void submitAdd();
            }
          }}
          placeholder={labels.aliasPlaceholder}
          disabled={busy}
          maxLength={200}
          className="flex-1 text-xs px-2 py-1.5 rounded border border-border bg-background"
        />
        <button
          type="button"
          disabled={busy || draftAlias.trim().length === 0}
          onClick={submitAdd}
          className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
        >
          {labels.aliasAdd}
        </button>
      </div>
      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">{labels.aliasesHint}</p>
    </section>
  );
}

function EntityBody({ entity }: { entity: EntityRollup }) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;
  const attrLabels = t.brainPage.entityPanel.attributeLabels as Record<
    string,
    string
  >;

  const rows = Object.entries(entity.attributes ?? {})
    .filter(
      ([key, value]) =>
        key !== "self" && value !== null && value !== undefined && value !== "",
    )
    .map(([key, value]) => ({
      key,
      label: attrLabels[key] ?? humaniseKey(key),
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{labels.noBody}</p>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
        {labels.detailsHeading}
      </h3>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-sm">
        {rows.map((row) => (
          <div key={row.key} className="contents">
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className="break-words">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ── Entity section — review workflow + attribute body ────────────

type EntitySectionProps = {
  workspaceId: string;
  entity: EntityRollup;
  detail: BrainInboxRowDetail;
  onClose: () => void;
  onUpdated: (next: BrainInboxRowDetail) => void;
};

/** Mirror of `PrimitiveSection` for the `entity` brain primitive.
 *  Surfaces the same Confirm / Edit / Delete / Ask shell that memories
 *  get, with a slimmer edit form (display_name + sensitivity in v1 —
 *  attribute editing is a follow-up that needs per-kind schema work).
 *  The entity attributes from `getEntity` render read-only beneath the
 *  form for context. */
function EntitySection({
  workspaceId,
  entity,
  detail,
  onClose,
  onUpdated,
}: EntitySectionProps) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;
  const review = t.memoriesReview;

  const isVerified = Boolean(detail.verifiedAt);
  const initialName = String(
    detail.body.display_name ?? entity.name ?? "",
  );
  const rawSensitivity = String(detail.body.sensitivity ?? "internal");
  const inferredSensitivity: Sensitivity =
    rawSensitivity === "public" || rawSensitivity === "confidential"
      ? rawSensitivity
      : "internal";

  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [draftName, setDraftName] = useState(initialName);
  const [draftSensitivity, setDraftSensitivity] =
    useState<Sensitivity>(inferredSensitivity);
  const [draftReason, setDraftReason] = useState("");

  const [whyDetailsOpen, setWhyDetailsOpen] = useState(false);
  const [whyLoading, setWhyLoading] = useState(true);
  const [whyContext, setWhyContext] = useState<ExplainContext | null>(null);
  const [askOpen, setAskOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setWhyDetailsOpen(false);
    setWhyLoading(true);
    setWhyContext(null);
    explainBrainRow(workspaceId, "entity", detail.id).then((ctx) => {
      if (cancelled) return;
      setWhyContext(ctx);
      setWhyLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, detail.id]);

  // Resync drafts when the underlying row swaps.
  useEffect(() => {
    setDraftName(initialName);
    setDraftSensitivity(inferredSensitivity);
    setDraftReason("");
    setMode("view");
    setError(null);
  }, [detail.id, initialName, inferredSensitivity]);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    const result = await verifyBrainRow(workspaceId, "entity", detail.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onUpdated({
      ...detail,
      verifiedAt: new Date().toISOString(),
      verifiedByUserId: detail.verifiedByUserId ?? "self",
    });
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    const result = await deleteBrainRow(workspaceId, "entity", detail.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Drop the row from the brain page (list / facets / graph / count)
    // before the drawer closes, so it doesn't linger stale behind it.
    requestBrainRefresh(workspaceId);
    onClose();
  }

  function cancelEdit() {
    setMode("view");
    setDraftName(initialName);
    setDraftSensitivity(inferredSensitivity);
    setDraftReason("");
    setError(null);
  }

  async function submitEdit() {
    const changes: AdjustMemoryChanges = {};
    const trimmedName = draftName.trim();
    if (trimmedName.length === 0) {
      setError(labels.nameRequired);
      return;
    }
    if (trimmedName !== initialName) changes.display_name = trimmedName;
    if (draftSensitivity !== inferredSensitivity) {
      changes.sensitivity = draftSensitivity;
    }
    if (draftReason.trim().length > 0) changes.reason = draftReason.trim();

    if (
      changes.display_name === undefined &&
      changes.sensitivity === undefined
    ) {
      // No-op edit — treat as confirm so the user's "this is right"
      // intent isn't lost.
      if (!isVerified) {
        await handleConfirm();
      }
      setMode("view");
      return;
    }

    setBusy(true);
    setError(null);
    const result = await adjustBrainRow(workspaceId, "entity", detail.id, changes);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Adjust mutates in place + stamps verified — refresh locally and
    // exit edit mode.
    onUpdated({
      ...detail,
      body: {
        ...detail.body,
        display_name: changes.display_name ?? detail.body.display_name,
        sensitivity: changes.sensitivity ?? detail.body.sensitivity,
      },
      verifiedAt: new Date().toISOString(),
      verifiedByUserId: detail.verifiedByUserId ?? "self",
    });
    setMode("view");
  }

  return (
    <>
      {isVerified && (
        <div className="flex items-start gap-2 p-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 text-xs text-emerald-700 dark:text-emerald-300">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
            className="shrink-0 mt-0.5"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
          <p className="flex-1">{t.brainInbox.detailVerifiedNote}</p>
        </div>
      )}

      {mode === "view" && (
        <div className="flex flex-wrap items-center gap-2">
          {!isVerified && (
            <button
              type="button"
              disabled={busy}
              onClick={handleConfirm}
              className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {review.confirm}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              setMode("edit");
            }}
            className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
          >
            {review.edit}
          </button>
          {!CHAT_HOME_FLIP && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                setMode("change-type");
              }}
              className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
            >
              {labels.changeType}
            </button>
          )}
          {!CHAT_HOME_FLIP && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                setMode("delete");
              }}
              className="text-xs px-3 py-1.5 rounded-md border border-border text-red-500 hover:bg-red-500/10 disabled:opacity-50"
            >
              {review.delete}
            </button>
          )}
          <button
            type="button"
            onClick={() => setAskOpen(true)}
            className="text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:bg-muted"
          >
            {review.askAboutThis}
          </button>
          {CHAT_HOME_FLIP && (
            <OverflowMenu
              ariaLabel={labels.moreActions}
              items={[
                {
                  key: "change-type",
                  label: labels.changeType,
                  disabled: busy,
                  onClick: () => {
                    setError(null);
                    setMode("change-type");
                  },
                },
                {
                  key: "delete",
                  label: review.delete,
                  destructive: true,
                  disabled: busy,
                  onClick: () => {
                    setError(null);
                    setMode("delete");
                  },
                },
              ]}
            />
          )}
        </div>
      )}

      {mode === "change-type" && (
        <ChangeTypePanel
          workspaceId={workspaceId}
          entityId={detail.id}
          currentKind={String(detail.body.kind ?? entity.kind ?? "product")}
          currentName={initialName}
          onCancel={() => {
            setMode("view");
            setError(null);
          }}
          onChanged={(nextKind) => {
            // Mutate the local row's kind so the chip + body re-render
            // without a round-trip. `onUpdated` also fires
            // requestBrainRefresh + the entity-rollup re-fetch so the
            // list / facets / graph / EntityBody all reflect the new kind.
            onUpdated({
              ...detail,
              body: { ...detail.body, kind: nextKind },
              verifiedAt: new Date().toISOString(),
              verifiedByUserId: detail.verifiedByUserId ?? "self",
            });
            setMode("view");
          }}
        />
      )}

      {mode === "edit" && (
        <FormActions
          t={t}
          busy={busy}
          submitLabel={review.editSubmit}
          onSubmit={submitEdit}
          onCancel={cancelEdit}
        />
      )}

      {mode === "delete" && (
        <div className="flex flex-col gap-2 border border-red-500/40 rounded-md p-3 bg-red-500/5">
          <p className="text-xs text-red-600 dark:text-red-400">
            {review.deleteConfirmBody}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleDelete}
              className="text-xs px-3 py-1.5 rounded-md bg-red-500 text-white hover:opacity-90 disabled:opacity-50"
            >
              {review.deleteConfirmAction}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setMode("view");
                setError(null);
              }}
              className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
            >
              {review.cancel}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}

      {mode === "edit" ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            {labels.detailsHeading}
          </h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-sm items-start">
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {labels.nameLabel}
              </dt>
              <dd>
                <input
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  disabled={busy}
                  maxLength={200}
                  className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
                />
              </dd>
            </div>
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {humaniseKey("sensitivity")}
              </dt>
              <dd>
                <Select
                  value={draftSensitivity}
                  onValueChange={(v) => {
                    if (v) setDraftSensitivity(v as Sensitivity);
                  }}
                  disabled={busy}
                  items={{
                    public: review.sensitivityPublic,
                    internal: review.sensitivityInternal,
                    confidential: review.sensitivityConfidential,
                  }}
                >
                  <SelectTrigger className="text-xs w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectItem value="public">
                      {review.sensitivityPublic}
                    </SelectItem>
                    <SelectItem value="internal">
                      {review.sensitivityInternal}
                    </SelectItem>
                    <SelectItem value="confidential">
                      {review.sensitivityConfidential}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </dd>
            </div>
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {review.why}
              </dt>
              <dd>
                <input
                  type="text"
                  value={draftReason}
                  onChange={(e) => setDraftReason(e.target.value)}
                  placeholder={review.reasonPlaceholder}
                  disabled={busy}
                  className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
                />
              </dd>
            </div>
          </dl>
        </section>
      ) : (
        <EntityBody entity={entity} />
      )}

      <AliasesSection
        workspaceId={workspaceId}
        entityId={detail.id}
        initialAliases={entity.aliases ?? []}
      />

      <section className="flex flex-col gap-2 border-t border-border pt-3">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
          {review.why}
        </h3>
        <WhyBody
          loading={whyLoading}
          context={whyContext}
          primitiveSummary={initialName}
          detailsOpen={whyDetailsOpen}
          onToggleDetails={() => setWhyDetailsOpen((v) => !v)}
        />
      </section>

      {askOpen && (
        <InspectionDrawer
          workspaceId={workspaceId}
          primitive="entity"
          rowId={detail.id}
          memorySummary={initialName || review.unknownAuthor}
          memoryDetail={null}
          savingAssistantName={review.unknownAuthor}
          onClose={() => setAskOpen(false)}
        />
      )}
    </>
  );
}

// ── Primitive section — review workflow + body ────────────────────

type PrimitiveSectionProps = {
  workspaceId: string;
  primitive: InboxPrimitive;
  detail: BrainInboxRowDetail;
  /** For CRM primitives (contact/company/deal), the rollup of the
   *  canonical entity this row specialises. Undefined while loading,
   *  null when not applicable (memory/task/file) or no linked entity. */
  crmEntity?: EntityRollup | null | undefined;
  onClose: () => void;
  onUpdated: (next: BrainInboxRowDetail) => void;
};

// ── File content preview (workspace_file) ────────────────────────
//
// Streams the file's bytes from the auth-gated brain-inbox content
// endpoint (`brainFileContentUrl`) via `authFetch` — a plain <img src>
// could not carry the bearer token. Images render inline, text/markdown
// as text, everything else as a download link. Object URLs are revoked
// on unmount / row change.
function FileContentPreview({
  workspaceId,
  fileId,
  mime,
  name,
}: {
  workspaceId: string;
  fileId: string;
  mime: string;
  name: string;
}) {
  const t = useT();
  const fp = t.brainPage.detailDrawer.filePreview;
  type PreviewState =
    | { kind: "loading" }
    | { kind: "image"; url: string }
    | { kind: "text"; text: string }
    | { kind: "download"; url: string }
    | { kind: "error" };
  const [state, setState] = useState<PreviewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ kind: "loading" });
    const isText =
      mime.startsWith("text/") ||
      mime === "application/json" ||
      mime === "application/xml" ||
      name.toLowerCase().endsWith(".md");
    authFetch(brainFileContentUrl(workspaceId, fileId))
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        if (mime.startsWith("image/")) {
          const blob = await res.blob();
          objectUrl = URL.createObjectURL(blob);
          if (!cancelled) setState({ kind: "image", url: objectUrl });
        } else if (isText) {
          const text = await res.text();
          if (!cancelled) setState({ kind: "text", text });
        } else {
          const blob = await res.blob();
          objectUrl = URL.createObjectURL(blob);
          if (!cancelled) setState({ kind: "download", url: objectUrl });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [workspaceId, fileId, mime, name]);

  if (state.kind === "loading") {
    return <p className="text-xs text-muted-foreground">{fp.loading}</p>;
  }
  if (state.kind === "error") {
    return <p className="text-xs text-muted-foreground">{fp.error}</p>;
  }
  if (state.kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- object URL, not an optimizable asset
      <img
        src={state.url}
        alt={name}
        className="max-h-80 w-auto rounded-md border border-border object-contain"
      />
    );
  }
  if (state.kind === "text") {
    return (
      <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-[12px] leading-relaxed whitespace-pre-wrap break-words font-mono">
        {state.text}
      </pre>
    );
  }
  return (
    <a
      href={state.url}
      download={name}
      className="inline-block w-max text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted"
    >
      {fp.download}
    </a>
  );
}

function PrimitiveSection({
  workspaceId,
  primitive,
  detail,
  crmEntity,
  onClose,
  onUpdated,
}: PrimitiveSectionProps) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;
  const review = t.memoriesReview;

  const isMemory = primitive === "memory";
  const isCrm = primitive === "company" || primitive === "contact" || primitive === "deal";
  const isFile = primitive === "workspace_file";
  const isTask = primitive === "task";
  const isVerified = Boolean(detail.verifiedAt);
  // Task autopilot: the goal auto-drafted for this task (Confirm / Work this).
  const [taskGoal, setTaskGoal] = useState<GoalRow | null>(null);
  const [goalBusy, setGoalBusy] = useState(false);
  const [goalError, setGoalError] = useState<string | null>(null);
  // Load this task's auto-drafted goal. Best-effort — the affordance stays
  // hidden if there's none (a sub-task, or a task edited so the host link moved).
  useEffect(() => {
    if (!isTask) return;
    let cancelled = false;
    setTaskGoal(null);
    setGoalError(null);
    void goalForTask(workspaceId, detail.id).then((g) => {
      if (!cancelled) setTaskGoal(g);
    });
    return () => {
      cancelled = true;
    };
  }, [isTask, workspaceId, detail.id]);
  async function handleConfirmGoal() {
    if (!taskGoal) return;
    setGoalBusy(true);
    setGoalError(null);
    const r = await confirmGoal(taskGoal.id);
    setGoalBusy(false);
    if (!r.ok) {
      // The §12 clarity gate may decline to arm a goal that's too vague to work
      // autonomously and ask for detail; surface its question (model-generated).
      setGoalError(r.needsClarification && r.question ? r.question : r.error ?? "Could not confirm the goal.");
      return;
    }
    if (r.goal) setTaskGoal(r.goal);
  }
  async function handleWorkGoal() {
    if (!taskGoal) return;
    setGoalBusy(true);
    setGoalError(null);
    const r = await workGoal(taskGoal.id);
    setGoalBusy(false);
    if (!r.ok) {
      setGoalError(r.error ?? "Could not start working the task.");
      return;
    }
    if (r.goal) setTaskGoal(r.goal);
  }
  const summary = String(detail.body.summary ?? "");
  const memoryDetail = (detail.body.detail as string | null) ?? null;
  // CRM rows store the user-facing label in `name`; everything else uses `display_name`.
  const crmName = String(detail.body.name ?? detail.body.display_name ?? "");
  const inferredScope = inferScope(detail);
  const rawSensitivity = String(detail.body.sensitivity ?? "internal");
  const inferredSensitivity: Sensitivity =
    rawSensitivity === "public" || rawSensitivity === "confidential"
      ? rawSensitivity
      : "internal";

  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [draftScope, setDraftScope] = useState<Scope>(inferredScope);
  const [draftSensitivity, setDraftSensitivity] =
    useState<Sensitivity>(inferredSensitivity);
  const [draftReason, setDraftReason] = useState("");
  const [draftSummary, setDraftSummary] = useState(summary);
  const [draftDetail, setDraftDetail] = useState(memoryDetail ?? "");
  // CRM name draft — shared field for company/contact/deal edits.
  const [draftCrmName, setDraftCrmName] = useState(crmName);
  // workspace_file tags draft — comma-separated for editing; the original
  // set drives the change detection in `submitEdit`.
  const fileTags: string[] = Array.isArray(detail.body.tags)
    ? (detail.body.tags as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const fileTagsJoined = fileTags.join(", ");
  const [draftFileTags, setDraftFileTags] = useState(fileTagsJoined);

  // Task draft fields — the doc-like editable surface (title/status/due/tags).
  // Tags reuse `fileTags`/`fileTagsJoined` (the generic `detail.body.tags`
  // parse above), so a task and a file share the comma-separated tag editor.
  const taskStatusLabels = t.brainPage.taskStatus;
  const taskTitle = isTask ? String(detail.body.title ?? "") : "";
  const taskStatus = isTask ? String(detail.body.status ?? "todo") : "todo";
  // due_at is an ISO string in the projection; <input type="date"> wants
  // YYYY-MM-DD, so slice when seeding and re-expand to ISO on submit.
  const taskDueDate = isTask
    ? String(detail.body.due_at ?? "").slice(0, 10)
    : "";
  const [draftTaskTitle, setDraftTaskTitle] = useState(taskTitle);
  const [draftTaskStatus, setDraftTaskStatus] = useState(taskStatus);
  const [draftTaskDue, setDraftTaskDue] = useState(taskDueDate);
  const [draftTaskTags, setDraftTaskTags] = useState(fileTagsJoined);

  const [whyDetailsOpen, setWhyDetailsOpen] = useState(false);
  const [whyLoading, setWhyLoading] = useState(true);
  const [whyContext, setWhyContext] = useState<ExplainContext | null>(null);
  const [askOpen, setAskOpen] = useState(false);

  // Provenance loads as soon as the row is shown — the summary is
  // always visible at the bottom of the drawer body, so we need its
  // payload immediately rather than gating on a user click.
  useEffect(() => {
    let cancelled = false;
    setWhyDetailsOpen(false);
    setWhyLoading(true);
    setWhyContext(null);
    explainBrainRow(workspaceId, primitive, detail.id).then((ctx) => {
      if (cancelled) return;
      setWhyContext(ctx);
      setWhyLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, primitive, detail.id]);

  // When the detail prop changes (e.g. parent swapped rows), resync the
  // draft state so the form reflects the new row.
  useEffect(() => {
    setDraftScope(inferredScope);
    setDraftSensitivity(inferredSensitivity);
    setDraftSummary(summary);
    setDraftDetail(memoryDetail ?? "");
    setDraftCrmName(crmName);
    setDraftFileTags(fileTagsJoined);
    setDraftTaskTitle(taskTitle);
    setDraftTaskStatus(taskStatus);
    setDraftTaskDue(taskDueDate);
    setDraftTaskTags(fileTagsJoined);
    setDraftReason("");
    setMode("view");
    setError(null);
  }, [detail.id, inferredScope, inferredSensitivity, summary, memoryDetail, crmName, fileTagsJoined, taskTitle, taskStatus, taskDueDate]);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    const result = await verifyBrainRow(workspaceId, primitive, detail.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Optimistic — flip verified state locally.
    onUpdated({
      ...detail,
      verifiedAt: new Date().toISOString(),
      verifiedByUserId: detail.verifiedByUserId ?? "self",
    });
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    const result = await deleteBrainRow(workspaceId, primitive, detail.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Drop the row from the brain page (list / facets / graph / count)
    // before the drawer closes, so it doesn't linger stale behind it.
    requestBrainRefresh(workspaceId);
    onClose();
  }

  function cancelEdit() {
    setMode("view");
    setDraftScope(inferredScope);
    setDraftSensitivity(inferredSensitivity);
    setDraftSummary(summary);
    setDraftDetail(memoryDetail ?? "");
    setDraftFileTags(fileTagsJoined);
    setDraftTaskTitle(taskTitle);
    setDraftTaskStatus(taskStatus);
    setDraftTaskDue(taskDueDate);
    setDraftTaskTags(fileTagsJoined);
    setDraftReason("");
    setError(null);
  }

  async function submitEdit() {
    const changes: AdjustMemoryChanges = {};
    if (isTask) {
      // Task edit shape — title/status/due_at/tags. Each field is sent only
      // when it actually changed; the server supersedes the row (a new
      // bi-temporal id) and the panel closes + refetches afterwards.
      const trimmedTitle = draftTaskTitle.trim();
      if (trimmedTitle.length === 0) {
        setError(labels.titleRequired);
        return;
      }
      if (trimmedTitle !== taskTitle) changes.title = trimmedTitle;
      if (draftTaskStatus !== taskStatus) {
        changes.status = draftTaskStatus as NonNullable<
          AdjustMemoryChanges["status"]
        >;
      }
      if (draftTaskDue !== taskDueDate) {
        // Empty clears the due date; otherwise pin to day-start UTC.
        changes.due_at = draftTaskDue
          ? new Date(`${draftTaskDue}T00:00:00.000Z`).toISOString()
          : null;
      }
      const parsedTags = draftTaskTags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const tagsChanged =
        parsedTags.length !== fileTags.length ||
        parsedTags.some((tag, i) => tag !== fileTags[i]);
      if (tagsChanged) changes.tags = parsedTags;
    } else if (isCrm) {
      // CRM rows expose name + sensitivity. Name maps to `display_name`
      // on the wire — the server's adjust handler for company/contact
      // /deal translates that to the CRM table's `name` column AND
      // updates the linked entity so both surfaces stay in sync.
      const trimmedName = draftCrmName.trim();
      if (trimmedName.length === 0) {
        setError(labels.nameRequired);
        return;
      }
      if (trimmedName !== crmName) changes.display_name = trimmedName;
      if (draftSensitivity !== inferredSensitivity) {
        changes.sensitivity = draftSensitivity;
      }
    } else if (isFile) {
      // File edit shape — sensitivity + tags (rename is path-coupled and
      // out of scope; the server's workspace_file adjust handler patches
      // the metadata and stamps the row verified).
      if (draftSensitivity !== inferredSensitivity) {
        changes.sensitivity = draftSensitivity;
      }
      const parsedTags = draftFileTags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const tagsChanged =
        parsedTags.length !== fileTags.length ||
        parsedTags.some((tag, i) => tag !== fileTags[i]);
      if (tagsChanged) changes.tags = parsedTags;
    } else {
      // Memory edit shape — scope/sensitivity/summary/detail.
      if (draftScope !== inferredScope) changes.scope = draftScope;
      if (draftSensitivity !== inferredSensitivity) {
        changes.sensitivity = draftSensitivity;
      }
      if (draftSummary !== summary) {
        if (draftSummary.trim().length === 0) {
          setError(review.summaryRequired);
          return;
        }
        changes.summary = draftSummary.trim();
      }
      if (draftDetail !== (memoryDetail ?? "")) {
        changes.detail = draftDetail;
      }
    }
    if (draftReason.trim().length > 0) changes.reason = draftReason.trim();
    if (Object.keys(changes).length === 0 || (
      isCrm
        ? changes.display_name === undefined && changes.sensitivity === undefined
        : isFile
          ? changes.sensitivity === undefined && changes.tags === undefined
          : false
    )) {
      // Nothing to change — collapse the form. If the row was unverified,
      // also stamp it verified so the user's "no, this is right" intent
      // doesn't get silently lost.
      if (!isVerified) {
        await handleConfirm();
      }
      setMode("view");
      return;
    }
    await runAdjust(changes);
  }

  async function runAdjust(changes: AdjustMemoryChanges) {
    setBusy(true);
    setError(null);
    const result = await adjustBrainRow(
      workspaceId,
      primitive,
      detail.id,
      changes,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Supersession mints a new memory id — close the drawer rather
    // than holding a stale `detail.id` that no longer resolves. Tell the
    // brain page to refetch (list / facets / graph / count) so the row
    // behind the drawer reflects the edit before it closes.
    requestBrainRefresh(workspaceId);
    onClose();
  }

  const fields = listDetailFields(detail.body);
  const tagsRaw = detail.body.tags;
  const tagsDisplay =
    Array.isArray(tagsRaw) && tagsRaw.length > 0
      ? tagsRaw
          .map((t) => (typeof t === "string" ? t : JSON.stringify(t)))
          .join(", ")
      : "—";

  return (
    <>
      {isVerified && (
        <div className="flex items-start gap-2 p-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 text-xs text-emerald-700 dark:text-emerald-300">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
            className="shrink-0 mt-0.5"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
          <p className="flex-1">{t.brainInbox.detailVerifiedNote}</p>
        </div>
      )}

      {mode === "view" && (
        <div className="flex flex-wrap items-center gap-2">
          {!isVerified && (
            <button
              type="button"
              disabled={busy}
              onClick={handleConfirm}
              className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {review.confirm}
            </button>
          )}
          {(isMemory || isCrm || isFile || isTask) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                setMode("edit");
              }}
              className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
            >
              {review.edit}
            </button>
          )}
          {!CHAT_HOME_FLIP && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                setMode("delete");
              }}
              className="text-xs px-3 py-1.5 rounded-md border border-border text-red-500 hover:bg-red-500/10 disabled:opacity-50"
            >
              {review.delete}
            </button>
          )}
          <button
            type="button"
            onClick={() => setAskOpen(true)}
            className="text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:bg-muted"
          >
            {review.askAboutThis}
          </button>
          {CHAT_HOME_FLIP && (
            <OverflowMenu
              ariaLabel={labels.moreActions}
              items={[
                {
                  key: "delete",
                  label: review.delete,
                  destructive: true,
                  disabled: busy,
                  onClick: () => {
                    setError(null);
                    setMode("delete");
                  },
                },
              ]}
            />
          )}
        </div>
      )}

      {isTask && taskGoal && mode === "view" && (
        <section className="mt-1 flex flex-col gap-2 rounded-md border border-border bg-card/50 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {labels.goalHeading}
          </div>
          <p className="text-sm text-foreground">{taskGoal.outcome}</p>
          {!taskGoal.confirmedAt ? (
            <button
              type="button"
              disabled={goalBusy}
              onClick={handleConfirmGoal}
              className="self-start text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {labels.goalConfirm}
            </button>
          ) : taskGoal.status === "done" ? (
            <span className="text-xs text-emerald-600 dark:text-emerald-400">{labels.goalDone}</span>
          ) : taskGoal.hasWorkflow ? (
            <span className="text-xs text-muted-foreground">{labels.goalWorking}</span>
          ) : (
            <button
              type="button"
              disabled={goalBusy}
              onClick={handleWorkGoal}
              className="self-start text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {labels.goalWork}
            </button>
          )}
          {goalError && <p className="text-xs text-red-500">{goalError}</p>}
        </section>
      )}

      {mode === "edit" && (
        <FormActions
          t={t}
          busy={busy}
          submitLabel={review.editSubmit}
          onSubmit={submitEdit}
          onCancel={cancelEdit}
        />
      )}

      {mode === "delete" && (
        <div className="flex flex-col gap-2 border border-red-500/40 rounded-md p-3 bg-red-500/5">
          <p className="text-xs text-red-600 dark:text-red-400">
            {review.deleteConfirmBody}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleDelete}
              className="text-xs px-3 py-1.5 rounded-md bg-red-500 text-white hover:opacity-90 disabled:opacity-50"
            >
              {review.deleteConfirmAction}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setMode("view");
                setError(null);
              }}
              className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
            >
              {review.cancel}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}

      {isTask && mode === "edit" ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            {labels.detailsHeading}
          </h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-sm items-start">
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {humaniseKey("title")}
              </dt>
              <dd>
                <input
                  type="text"
                  value={draftTaskTitle}
                  onChange={(e) => setDraftTaskTitle(e.target.value)}
                  disabled={busy}
                  maxLength={500}
                  className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
                />
              </dd>
            </div>
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {humaniseKey("status")}
              </dt>
              <dd>
                <Select
                  value={draftTaskStatus}
                  onValueChange={(v) => {
                    if (v) setDraftTaskStatus(v);
                  }}
                  disabled={busy}
                  items={{
                    todo: taskStatusLabels.todo,
                    in_progress: taskStatusLabels.in_progress,
                    blocked: taskStatusLabels.blocked,
                    done: taskStatusLabels.done,
                    archived: taskStatusLabels.archived,
                  }}
                >
                  <SelectTrigger className="text-xs w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectItem value="todo">{taskStatusLabels.todo}</SelectItem>
                    <SelectItem value="in_progress">
                      {taskStatusLabels.in_progress}
                    </SelectItem>
                    <SelectItem value="blocked">{taskStatusLabels.blocked}</SelectItem>
                    <SelectItem value="done">{taskStatusLabels.done}</SelectItem>
                    <SelectItem value="archived">{taskStatusLabels.archived}</SelectItem>
                  </SelectContent>
                </Select>
              </dd>
            </div>
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {humaniseKey("due_at")}
              </dt>
              <dd>
                <input
                  type="date"
                  value={draftTaskDue}
                  onChange={(e) => setDraftTaskDue(e.target.value)}
                  disabled={busy}
                  className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
                />
              </dd>
            </div>
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {humaniseKey("tags")}
              </dt>
              <dd>
                <input
                  type="text"
                  value={draftTaskTags}
                  onChange={(e) => setDraftTaskTags(e.target.value)}
                  placeholder={labels.filePreview.tagsPlaceholder}
                  disabled={busy}
                  className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
                />
              </dd>
            </div>
          </dl>
          <p className="text-[11px] text-muted-foreground mt-1">
            {format(labels.savedAt, {
              date: new Date(detail.createdAt).toLocaleString(),
            })}
          </p>
        </section>
      ) : isCrm && mode === "edit" ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            {labels.detailsHeading}
          </h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-sm items-start">
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {labels.nameLabel}
              </dt>
              <dd>
                <input
                  type="text"
                  value={draftCrmName}
                  onChange={(e) => setDraftCrmName(e.target.value)}
                  disabled={busy}
                  maxLength={200}
                  className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
                />
              </dd>
            </div>
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {humaniseKey("sensitivity")}
              </dt>
              <dd>
                <Select
                  value={draftSensitivity}
                  onValueChange={(v) => {
                    if (v) setDraftSensitivity(v as Sensitivity);
                  }}
                  disabled={busy}
                  items={{
                    public: review.sensitivityPublic,
                    internal: review.sensitivityInternal,
                    confidential: review.sensitivityConfidential,
                  }}
                >
                  <SelectTrigger className="text-xs w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectItem value="public">{review.sensitivityPublic}</SelectItem>
                    <SelectItem value="internal">{review.sensitivityInternal}</SelectItem>
                    <SelectItem value="confidential">{review.sensitivityConfidential}</SelectItem>
                  </SelectContent>
                </Select>
              </dd>
            </div>
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {review.why}
              </dt>
              <dd>
                <input
                  type="text"
                  value={draftReason}
                  onChange={(e) => setDraftReason(e.target.value)}
                  placeholder={review.reasonPlaceholder}
                  disabled={busy}
                  className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
                />
              </dd>
            </div>
          </dl>
          <p className="text-[11px] text-muted-foreground mt-1">
            {format(labels.savedAt, {
              date: new Date(detail.createdAt).toLocaleString(),
            })}
          </p>
        </section>
      ) : isMemory && mode === "edit" ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            {labels.detailsHeading}
          </h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-sm items-start">
            {tagsDisplay && (
              <div className="contents">
                <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                  {humaniseKey("tags")}
                </dt>
                <dd className="break-words font-mono text-[12px] leading-relaxed pt-1.5">
                  {tagsDisplay}
                </dd>
              </div>
            )}
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {humaniseKey("scope")}
              </dt>
              <dd>
                <Select
                  value={draftScope}
                  onValueChange={(v) => {
                    if (v) setDraftScope(v as Scope);
                  }}
                  disabled={busy}
                  items={{
                    personal: review.scopePersonal,
                    workspace_shared: review.scopeWorkspaceShared,
                    workspace: review.scopeWorkspace,
                  }}
                >
                  <SelectTrigger className="text-xs w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectItem value="personal">
                      {review.scopePersonal}
                    </SelectItem>
                    <SelectItem value="workspace_shared">
                      {review.scopeWorkspaceShared}
                    </SelectItem>
                    <SelectItem value="workspace">
                      {review.scopeWorkspace}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </dd>
            </div>
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {humaniseKey("detail")}
              </dt>
              <dd>
                <textarea
                  value={draftDetail}
                  onChange={(e) => setDraftDetail(e.target.value)}
                  disabled={busy}
                  rows={4}
                  className="text-xs px-2 py-1.5 rounded border border-border bg-background resize-y w-full font-mono"
                />
              </dd>
            </div>
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {humaniseKey("summary")}
              </dt>
              <dd>
                <textarea
                  value={draftSummary}
                  onChange={(e) => setDraftSummary(e.target.value)}
                  disabled={busy}
                  rows={2}
                  maxLength={500}
                  className="text-xs px-2 py-1.5 rounded border border-border bg-background resize-y w-full font-mono"
                />
              </dd>
            </div>
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {humaniseKey("sensitivity")}
              </dt>
              <dd>
                <Select
                  value={draftSensitivity}
                  onValueChange={(v) => {
                    if (v) setDraftSensitivity(v as Sensitivity);
                  }}
                  disabled={busy}
                  items={{
                    public: review.sensitivityPublic,
                    internal: review.sensitivityInternal,
                    confidential: review.sensitivityConfidential,
                  }}
                >
                  <SelectTrigger className="text-xs w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectItem value="public">
                      {review.sensitivityPublic}
                    </SelectItem>
                    <SelectItem value="internal">
                      {review.sensitivityInternal}
                    </SelectItem>
                    <SelectItem value="confidential">
                      {review.sensitivityConfidential}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </dd>
            </div>
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {review.why}
              </dt>
              <dd>
                <input
                  type="text"
                  value={draftReason}
                  onChange={(e) => setDraftReason(e.target.value)}
                  placeholder={review.reasonPlaceholder}
                  disabled={busy}
                  className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
                />
              </dd>
            </div>
          </dl>
          <p className="text-[11px] text-muted-foreground mt-1">
            {format(labels.savedAt, {
              date: new Date(detail.createdAt).toLocaleString(),
            })}
          </p>
        </section>
      ) : isFile && mode === "edit" ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            {labels.detailsHeading}
          </h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-sm items-start">
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {humaniseKey("sensitivity")}
              </dt>
              <dd>
                <Select
                  value={draftSensitivity}
                  onValueChange={(v) => {
                    if (v) setDraftSensitivity(v as Sensitivity);
                  }}
                  disabled={busy}
                  items={{
                    public: review.sensitivityPublic,
                    internal: review.sensitivityInternal,
                    confidential: review.sensitivityConfidential,
                  }}
                >
                  <SelectTrigger className="text-xs w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectItem value="public">{review.sensitivityPublic}</SelectItem>
                    <SelectItem value="internal">{review.sensitivityInternal}</SelectItem>
                    <SelectItem value="confidential">{review.sensitivityConfidential}</SelectItem>
                  </SelectContent>
                </Select>
              </dd>
            </div>
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {humaniseKey("tags")}
              </dt>
              <dd>
                <input
                  type="text"
                  value={draftFileTags}
                  onChange={(e) => setDraftFileTags(e.target.value)}
                  placeholder={labels.filePreview.tagsPlaceholder}
                  disabled={busy}
                  className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
                />
              </dd>
            </div>
            <div className="contents">
              <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-1.5">
                {review.why}
              </dt>
              <dd>
                <input
                  type="text"
                  value={draftReason}
                  onChange={(e) => setDraftReason(e.target.value)}
                  placeholder={review.reasonPlaceholder}
                  disabled={busy}
                  className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full"
                />
              </dd>
            </div>
          </dl>
          <p className="text-[11px] text-muted-foreground mt-1">
            {format(labels.savedAt, {
              date: new Date(detail.createdAt).toLocaleString(),
            })}
          </p>
        </section>
      ) : (
        <>
          {isFile && (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
                {labels.filePreview.heading}
              </h3>
              <FileContentPreview
                workspaceId={workspaceId}
                fileId={detail.id}
                mime={String(detail.body.mime_type ?? "")}
                name={String(detail.body.name ?? "file")}
              />
            </section>
          )}
          {fields.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
                {labels.detailsHeading}
              </h3>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-sm">
                {fields.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-0.5">
                      {humaniseKey(k)}
                    </dt>
                    <dd className="break-words font-mono text-[12px] leading-relaxed">
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-[11px] text-muted-foreground mt-2">
                {format(labels.savedAt, {
                  date: new Date(detail.createdAt).toLocaleString(),
                })}
              </p>
            </section>
          )}
        </>
      )}

      {crmEntity && <EmbeddedRollupSections rollup={crmEntity} />}

      <section className="flex flex-col gap-2 border-t border-border pt-3">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
          {review.why}
        </h3>
        <WhyBody
          loading={whyLoading}
          context={whyContext}
          primitiveSummary={summary}
          detailsOpen={whyDetailsOpen}
          onToggleDetails={() => setWhyDetailsOpen((v) => !v)}
        />
      </section>

      {askOpen && (
        <InspectionDrawer
          workspaceId={workspaceId}
          primitive={primitive}
          rowId={detail.id}
          memorySummary={summary || review.unknownAuthor}
          memoryDetail={memoryDetail}
          savingAssistantName={review.unknownAuthor}
          onClose={() => setAskOpen(false)}
        />
      )}
    </>
  );
}

// ── Embedded rollup sections (CRM primitives) ────────────────────
//
// CRM specialization rows (contact/company/deal) share a canonical
// `entities` row that owns the knowledge graph anchor. Once the row
// detail has loaded we follow `body.entity_id` and fetch the rollup so
// the drawer can render the same Memories / Knowledge / Files / Edges /
// Recent activity surfaces the full entity page exposes — without
// navigating away. Re-uses `EntityRow` + the i18n keys from
// `entityPanel.sections` so visual parity stays free.

function EmbeddedRollupSections({ rollup }: { rollup: EntityRollup }) {
  const t = useT();
  const labels = t.brainPage.entityPanel;
  const sections = labels.sections;

  const blocks: Array<{
    title: string;
    rows: BrainRow[];
    total: number;
  }> = [
    {
      title: sections.memories,
      rows: rollup.embedded.recentMemories,
      total: rollup.summary.memoriesCount,
    },
    {
      title: sections.knowledge,
      rows: rollup.embedded.knowledge,
      total: rollup.summary.knowledgeCount,
    },
    {
      title: sections.files,
      rows: rollup.embedded.files,
      total: rollup.summary.filesCount,
    },
    {
      title: sections.episodes,
      rows: rollup.embedded.recentEpisodes,
      total: rollup.summary.episodesCount,
    },
  ];

  const visibleBlocks = blocks.filter((b) => b.rows.length > 0);
  const edges = rollup.embedded.edges;
  if (visibleBlocks.length === 0 && edges.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      {visibleBlocks.map((b) => (
        <section key={b.title} className="flex flex-col gap-1.5">
          <h3 className="flex items-baseline justify-between text-xs uppercase tracking-wide text-muted-foreground">
            <span>{b.title}</span>
            {b.total > b.rows.length && (
              <span className="text-[10px] normal-case tracking-normal">
                {format(labels.seeAll, { count: b.total })}
              </span>
            )}
          </h3>
          <div className="border border-border rounded-md overflow-hidden">
            {b.rows.slice(0, 3).map((row) => (
              <EntityRow key={`${row.kind}:${row.id}`} row={row} showNudge={false} />
            ))}
          </div>
        </section>
      ))}
      {edges.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            {sections.edges}
          </h3>
          <ul className="flex flex-col gap-1 text-xs">
            {edges.slice(0, 5).map((edge) => (
              <li key={`${edge.kind}:${edge.targetEntityId}`}>
                <span className="text-muted-foreground mr-2">{edge.kind}</span>
                <span>{edge.targetName}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function inferScope(detail: BrainInboxRowDetail): Scope {
  const scope = String(detail.body.scope ?? "");
  if (scope === "workspace") return "workspace";
  if (detail.workspaceId) return "workspace_shared";
  return "personal";
}

function listDetailFields(body: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(body)
    .filter(([k, v]) => !HIDDEN_BODY_KEYS.has(k) && v != null && v !== "")
    .map(([k, v]) => [k, formatValue(v)] as [string, string]);
}

function formatValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toLocaleString();
    }
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "—";
    return v
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join(", ");
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "—";
    return JSON.stringify(v, null, 2);
  }
  return String(v);
}

function humaniseKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Why-expander: typed content parsing + summary ────────────────

type ContentItem =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; toolName: string; input: unknown }
  | { kind: "tool_result"; toolName: string; result: unknown }
  | { kind: "other"; raw: string };

/** Split a session_message.content payload into renderable items. The
 *  shapes we see in practice:
 *    - plain string (legacy text)
 *    - array of { type: 'text', text }
 *    - array of { id, name, type: 'tool_use', input }
 *    - array of { name, type: 'tool_result', content, toolUseId } */
function parseContent(content: unknown): ContentItem[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    if (content && typeof content === "object") {
      return [{ kind: "other", raw: JSON.stringify(content) }];
    }
    return [];
  }
  return content.flatMap((c): ContentItem[] => {
    if (typeof c === "string") {
      return c.length > 0 ? [{ kind: "text", text: c }] : [];
    }
    if (!c || typeof c !== "object") return [];
    const obj = c as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") {
      return obj.text.length > 0
        ? [{ kind: "text", text: obj.text }]
        : [];
    }
    if (obj.type === "tool_use" && typeof obj.name === "string") {
      return [
        { kind: "tool_use", toolName: obj.name, input: obj.input ?? null },
      ];
    }
    if (obj.type === "tool_result" && typeof obj.name === "string") {
      return [
        { kind: "tool_result", toolName: obj.name, result: obj.content ?? "" },
      ];
    }
    return [{ kind: "other", raw: JSON.stringify(obj) }];
  });
}

/** Compose a one-line tool-input summary. For known tools (saveMemory,
 *  spawnWorker) pull the salient field; for everything else dump the
 *  full input as pretty JSON so nothing gets lost. */
function summariseToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (toolName === "saveMemory") {
    const summary =
      typeof obj.summary === "string" ? obj.summary : "";
    const detail = typeof obj.detail === "string" ? obj.detail : "";
    if (summary && detail) return `${summary}\n\n${detail}`;
    return summary || detail || JSON.stringify(obj, null, 2);
  }
  if (toolName === "spawnWorker" && typeof obj.prompt === "string") {
    return obj.prompt;
  }
  return JSON.stringify(obj, null, 2);
}

/** Stringify a tool_result payload. The backend hands us strings most
 *  of the time but workers sometimes attach structured envelopes. */
function summariseToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null) return "";
  return JSON.stringify(result, null, 2);
}

type ExplainMessage = ExplainContext["messages"][number];

/** Find the saveMemory tool_use that minted this row (matched by the
 *  `summary` field), plus the latest user message before it. Used for
 *  the human TL;DR. Falls back to the most-recent saveMemory call if
 *  no exact summary match is found. */
function deriveWhySummary(
  messages: ExplainMessage[],
  primitiveSummary: string,
): { capture: string | null; userTrigger: string | null } {
  let saveInput: Record<string, unknown> | null = null;
  let saveIndex = -1;
  // Prefer an exact summary match; fall back to the last saveMemory.
  let fallback: { input: Record<string, unknown>; index: number } | null = null;
  for (let i = 0; i < messages.length; i++) {
    const items = parseContent(messages[i].content);
    for (const item of items) {
      if (item.kind === "tool_use" && item.toolName === "saveMemory") {
        const input = (item.input ?? {}) as Record<string, unknown>;
        fallback = { input, index: i };
        if (
          typeof input.summary === "string" &&
          primitiveSummary &&
          input.summary === primitiveSummary
        ) {
          saveInput = input;
          saveIndex = i;
        }
      }
    }
  }
  if (!saveInput && fallback) {
    saveInput = fallback.input;
    saveIndex = fallback.index;
  }
  const capture = saveInput
    ? summariseToolInput("saveMemory", saveInput)
    : null;

  let userTrigger: string | null = null;
  if (saveIndex >= 0) {
    for (let j = saveIndex - 1; j >= 0; j--) {
      if (messages[j].role !== "user") continue;
      const text = parseContent(messages[j].content)
        .filter((it): it is { kind: "text"; text: string } => it.kind === "text")
        .map((it) => it.text)
        .join("\n")
        .trim();
      if (text.length > 0) {
        userTrigger = text;
        break;
      }
    }
  }
  return { capture, userTrigger };
}

function WhyBody({
  loading,
  context,
  primitiveSummary,
  detailsOpen,
  onToggleDetails,
}: {
  loading: boolean;
  context: ExplainContext | null;
  primitiveSummary: string;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  const t = useT();
  const review = t.memoriesReview;

  if (loading) {
    return (
      <div className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
        {review.loading}
      </div>
    );
  }
  if (!context) {
    return (
      <div className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
        {review.whyUnavailable}
      </div>
    );
  }
  if (context.messages.length === 0) {
    return (
      <div className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
        {review.whyNoMessages}
      </div>
    );
  }

  const assistant = context.savedByAssistantName ?? review.unknownAuthor;
  const { capture, userTrigger } = deriveWhySummary(
    context.messages,
    primitiveSummary,
  );

  return (
    <div className="flex flex-col gap-3 border-l-2 border-border pl-3 text-xs">
      <p className="text-muted-foreground italic">
        {format(review.whyLeadIn, { assistant })}
      </p>

      {(userTrigger || capture) && (
        <div className="flex flex-col gap-2">
          {userTrigger && (
            <div className="flex flex-col gap-0.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {review.whyTriggerLabel}
              </div>
              <p className="text-foreground whitespace-pre-wrap break-words">
                {userTrigger}
              </p>
            </div>
          )}
          {capture && (
            <div className="flex flex-col gap-0.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {review.whyCaptureLabel}
              </div>
              <p className="text-foreground whitespace-pre-wrap break-words">
                {capture}
              </p>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onToggleDetails}
        aria-expanded={detailsOpen}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 w-fit"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
          className={cn("transition-transform", detailsOpen && "rotate-90")}
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        {detailsOpen ? review.whyHideDetails : review.whyShowDetails}
      </button>

      {detailsOpen && (
        <div className="flex flex-col gap-2.5">
          {context.messages.map((m) => (
            <MessageBlock key={m.id} role={m.role} content={m.content} />
          ))}
        </div>
      )}
    </div>
  );
}

function MessageBlock({ role, content }: { role: string; content: unknown }) {
  const t = useT();
  const review = t.memoriesReview;
  const items = parseContent(content);
  if (items.length === 0) return null;
  const roleLabel = humaniseRole(role, review);
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {roleLabel}
      </div>
      <div className="flex flex-col gap-1.5">
        {items.map((item, i) => (
          <ContentItemView key={i} item={item} />
        ))}
      </div>
    </div>
  );
}

function ContentItemView({ item }: { item: ContentItem }) {
  const t = useT();
  const review = t.memoriesReview;
  if (item.kind === "text") {
    return (
      <p className="text-foreground whitespace-pre-wrap break-words">
        {item.text}
      </p>
    );
  }
  if (item.kind === "tool_use") {
    const body = summariseToolInput(item.toolName, item.input);
    return (
      <div className="flex flex-col gap-0.5">
        <div className="text-[10px] text-muted-foreground">
          {format(review.whyToolCalled, { tool: item.toolName })}
        </div>
        {body && (
          <pre className="text-[12px] text-foreground whitespace-pre-wrap break-words bg-muted/40 rounded px-2 py-1 leading-relaxed font-mono">
            {body}
          </pre>
        )}
      </div>
    );
  }
  if (item.kind === "tool_result") {
    const body = summariseToolResult(item.result);
    return (
      <div className="flex flex-col gap-0.5">
        <div className="text-[10px] text-muted-foreground">
          {format(review.whyToolReturned, { tool: item.toolName })}
        </div>
        {body && (
          <pre className="text-[12px] text-foreground whitespace-pre-wrap break-words bg-muted/40 rounded px-2 py-1 leading-relaxed font-mono">
            {body}
          </pre>
        )}
      </div>
    );
  }
  return (
    <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words bg-muted/30 rounded px-2 py-1 font-mono">
      {item.raw}
    </pre>
  );
}

function humaniseRole(
  role: string,
  review: ReturnType<typeof useT>["memoriesReview"],
): string {
  if (role === "user") return review.whyMessageRoleUser;
  if (role === "assistant") return review.whyMessageRoleAssistant;
  if (role === "system") return review.whyMessageRoleSystem;
  if (role === "tool") return review.whyMessageRoleTool;
  return role.toUpperCase();
}

function FormActions({
  t,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  t: ReturnType<typeof useT>;
  busy: boolean;
  submitLabel: string;
  onSubmit: () => void | Promise<void>;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={onSubmit}
        className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {busy ? t.memoriesReview.saving : submitLabel}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onCancel}
        className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
      >
        {t.memoriesReview.cancel}
      </button>
    </div>
  );
}

// ── Skill primitive — the procedural-brain detail panel ───────────

/**
 * Drawer shell for a skill node/row (the procedural-brain primitive,
 * docs/plans/skills-as-procedural-brain-primitive.md §7.1). Mirrors the
 * entity/primitive drawer chrome (slide-in aside + backdrop + header) but
 * renders the skill body + governance block + trust actions instead of the
 * brain-inbox review flow.
 */
function SkillDrawer({
  skill,
  workspaceId,
  closing,
  onClose,
}: {
  skill: WorkspaceSkillSummary;
  workspaceId: string;
  closing: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;
  const skillsCopy = t.brainPage.skills;

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-background/40 backdrop-blur-[2px]",
          "duration-300 ease-out",
          closing ? "animate-out fade-out-0" : "animate-in fade-in-0",
        )}
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label={skill.name}
        className={cn(
          "fixed top-0 right-0 bottom-0 z-50",
          "w-full sm:w-[420px] lg:w-[560px] bg-popover border-l border-border shadow-2xl",
          "flex flex-col overflow-hidden",
          "duration-300 ease-out will-change-transform",
          closing
            ? "animate-out slide-out-to-right"
            : "animate-in slide-in-from-right",
        )}
      >
        <header className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border">
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary uppercase tracking-wide">
                {skillsCopy.kindLabel}
              </span>
            </div>
            <h2 className="text-base font-semibold break-words leading-snug">
              {skill.name}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={labels.close}
            className="h-7 w-7 rounded hover:bg-muted inline-flex items-center justify-center text-muted-foreground shrink-0"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          <SkillSection skill={skill} workspaceId={workspaceId} onClose={onClose} />
        </div>
      </aside>
    </>
  );
}

/**
 * Skill body (markdown) + governance block + trust actions.
 *
 *   • Confirm — only when Suggested (activatedAt == null); optimistically
 *     flips the panel to Active, calls `POST /api/skills/:id/confirm`.
 *   • Edit    — rewrite the body, `PATCH /api/skills/:id`.
 *   • Delete  — confirmDialog → `DELETE /api/skills/:id`, then close.
 */
function SkillSection({
  skill,
  workspaceId,
  onClose,
}: {
  skill: WorkspaceSkillSummary;
  workspaceId: string;
  onClose: () => void;
}) {
  const t = useT();
  const skillsCopy = t.brainPage.skills;
  const review = t.memoriesReview;

  // Local optimistic copy so Confirm / Edit reflect immediately without a
  // parent round-trip. The parent refetches the skill list on `requestBrainRefresh`.
  const [localSkill, setLocalSkill] = useState<WorkspaceSkillSummary>(skill);
  useEffect(() => {
    setLocalSkill(skill);
  }, [skill]);

  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draftContent, setDraftContent] = useState(skill.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraftContent(skill.content);
    setMode("view");
    setError(null);
  }, [skill.rowId, skill.content]);

  const isActive = localSkill.activatedAt != null;

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    const result = await confirmSkill(workspaceId, localSkill.rowId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Optimistic → Active.
    setLocalSkill((s) => ({ ...s, activatedAt: new Date().toISOString() }));
    requestBrainRefresh(workspaceId);
  }

  async function handleSaveEdit() {
    const trimmed = draftContent.trim();
    if (trimmed.length === 0) {
      setError(skillsCopy.contentRequired);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await updateSkill(localSkill.rowId, { content: trimmed });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setLocalSkill((s) => ({ ...s, content: trimmed }));
    setMode("view");
    requestBrainRefresh(workspaceId);
  }

  async function handleDelete() {
    const ok = await confirmDialog({
      title: skillsCopy.deleteTitle,
      description: skillsCopy.deleteBody,
      confirmLabel: skillsCopy.deleteConfirm,
      cancelLabel: review.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const result = await deleteSkill(localSkill.rowId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    requestBrainRefresh(workspaceId);
    onClose();
  }

  return (
    <>
      {/* Governance block — Active/Suggested + confidence + induction source +
          sensitivity. */}
      <section className="flex flex-col gap-2">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
          {skillsCopy.governanceHeading}
        </h3>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-sm">
          <div className="contents">
            <dt className="text-xs text-muted-foreground">{skillsCopy.statusLabel}</dt>
            <dd>
              <span
                className={cn(
                  "inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium border",
                  isActive
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20"
                    : "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
                )}
              >
                {isActive ? skillsCopy.statusActive : skillsCopy.statusSuggested}
              </span>
            </dd>
          </div>
          <div className="contents">
            <dt className="text-xs text-muted-foreground">{skillsCopy.confidenceLabel}</dt>
            <dd className="tabular-nums">{Math.round(localSkill.confidence * 100)}%</dd>
          </div>
          <div className="contents">
            <dt className="text-xs text-muted-foreground">{skillsCopy.inductionSourceLabel}</dt>
            <dd>{skillsCopy.inductionSource[localSkill.inductionSource]}</dd>
          </div>
          <div className="contents">
            <dt className="text-xs text-muted-foreground">{skillsCopy.sensitivityLabel}</dt>
            <dd>{skillsCopy.sensitivity[localSkill.sensitivity]}</dd>
          </div>
        </dl>
      </section>

      {/* Trust actions. */}
      {mode === "view" && (
        <div className="flex flex-wrap items-center gap-2">
          {!isActive && (
            <button
              type="button"
              disabled={busy}
              onClick={handleConfirm}
              className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {skillsCopy.confirm}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              setMode("edit");
            }}
            className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
          >
            {review.edit}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleDelete}
            className="text-xs px-3 py-1.5 rounded-md border border-border text-red-500 hover:bg-red-500/10 disabled:opacity-50"
          >
            {review.delete}
          </button>
        </div>
      )}

      {mode === "edit" && (
        <div className="flex flex-col gap-2">
          <textarea
            value={draftContent}
            onChange={(e) => setDraftContent(e.target.value)}
            disabled={busy}
            rows={12}
            className="text-sm px-2.5 py-2 rounded border border-border bg-background w-full font-mono leading-relaxed"
          />
          <FormActions
            t={t}
            busy={busy}
            submitLabel={review.editSubmit}
            onSubmit={handleSaveEdit}
            onCancel={() => {
              setMode("view");
              setDraftContent(localSkill.content);
              setError(null);
            }}
          />
        </div>
      )}

      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}

      {/* Skill body (markdown). */}
      {mode === "view" && (
        <section className="flex flex-col gap-2 border-t border-border pt-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            {skillsCopy.bodyHeading}
          </h3>
          {localSkill.content.trim().length > 0 ? (
            <div className="chat-markdown text-sm leading-relaxed break-words">
              <Markdown>{localSkill.content}</Markdown>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{skillsCopy.noBody}</p>
          )}
        </section>
      )}
    </>
  );
}
