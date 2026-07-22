"use client";

/**
 * BrainDetailDrawer — right-sliding entry page for a brain list row, in
 * the Notion sub-page shape: kind/sensitivity chips in a slim header, a
 * big inline-editable page title, then one property row per field
 * (icon + label + click-to-edit value), content sections, and the
 * source context.
 *
 * Replaces the legacy `/brain-inbox/[primitive]/[rowId]` full-page detail
 * view. Hosts the entire data-review workflow inline:
 *
 *   • Confirm  — verify the row as-is (hidden once verified).
 *   • Inline edit — each property commits on its own through /adjust
 *     (no drawer-wide edit mode). Task + memory adjusts supersede the
 *     row; the drawer re-anchors on the returned new id and stays open.
 *   • Delete   — soft delete behind `confirmDialog`.
 *   • Ask      — an inline EntryThread at the page bottom (the Notion
 *     "Comments" analog): ephemeral read-only Q&A with the workspace's
 *     primary assistant. No stacked overlay.
 *   • Why?     — collapsible source-session context (lazy /explain).
 *
 * Inline edits work post-confirm too: the underlying adjust routes write
 * `memory_verifications` / `brain_verifications` audit rows per changed
 * field (tasks audit via the preserved superseded row) and re-stamp
 * verified. That audit trail is the workspace's learning signal.
 *
 * Property primitives: property-field.tsx; pure logic: property-edit.ts
 * (`[COMP:app-web/brain-property-fields]`).
 *
 * Width: w-full sm:w-[480px] lg:w-[640px] xl:w-[760px] — the Notion
 * side-peek proportion (wider than the old ProvenanceSheet third).
 *
 * Spec: docs/architecture/brain/corrections.md → "Entry page view".
 *
 * [COMP:app-web/brain-detail-drawer]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { reingestStoredFile } from "@/lib/api/ingest";
import { originClue } from "./source-origin";
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
  addEntityAlias,
  removeEntityAlias,
} from "@/lib/api/brain-inbox";
import {
  goalForTask,
  confirmGoal,
  workGoal,
  updateGoalOutcome,
  type GoalRow,
} from "@/lib/api/goals";
import {
  type WorkspaceSkillSummary,
  confirmSkill,
  updateSkill,
  deleteSkill,
} from "@/lib/api/skills";
import { EntryThread } from "@/components/brain/entry-thread";
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
import {
  AlignLeft,
  BookOpen,
  Box,
  Braces,
  Building2,
  Calendar,
  CircleDashed,
  Clock,
  FileText,
  Flag,
  Folder,
  FolderGit2,
  Handshake,
  History,
  MessageSquare,
  MoreHorizontal,
  Package,
  Shield,
  Sparkles,
  SquareCheckBig,
  Tags,
  UserRound,
  Users,
} from "lucide-react";
import {
  DateProperty,
  MoreProperties,
  PageTitle,
  PersonProperty,
  SelectProperty,
  StaticProperty,
  TagsProperty,
  type CommitResult,
  type PersonPropertyOption,
  type SelectPropertyOption,
} from "@/components/brain/property-field";
import {
  applyChangesToBody,
  attributePriority,
  bodyTags,
  dateInputToIso,
  extraBodyFields,
  flattenAttributes,
  humaniseKey,
  isoToDateInput,
  memberDisplayName,
  resolveAssignee,
  type AssignableMember,
  TASK_PRIORITY_DOT_CLASS,
  TASK_STATUS_DOT_CLASS,
} from "@/components/brain/property-edit";
import { loadWorkspaceRoster } from "@/lib/api/workspace-roster";

// (The NEXT_PUBLIC_CHAT_HOME_ENABLED inline-actions rollback flag retired
// with the Notion-style entry page: all page actions live in the drawer's
// top toolbar now — there is no inline action row to fall back to.)

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
        className="text-xs px-2 py-1 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground inline-flex items-center"
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
   *  (docs/architecture/engine/skill-system.md §7.1): body + governance
   *  block + trust actions (Confirm / Edit / Delete). Skills are a different data
   *  shape than `BrainRow`, so they arrive fully-formed rather than being
   *  re-fetched by id. */
  skill?: WorkspaceSkillSummary | null;
  workspaceId: string;
  onClose: () => void;
};

// "edit" / "delete" modes are gone — properties edit in place and delete
// confirms through `confirmDialog`. Only the entity change-type panel
// still swaps the section body.
type Mode = "view" | "change-type";
type Scope = "personal" | "workspace_shared" | "workspace";

const ENTITY_KINDS = new Set<EntityKind>([
  "person",
  "company",
  "project",
  "deal",
  "product",
  "repository",
  "other",
]);

// Body-field visibility (hidden plumbing + per-primitive dedicated keys)
// lives in property-edit.ts alongside the rest of the property-page logic.

// TASK_STATUS_DOT_CLASS / TASK_PRIORITY_DOT_CLASS moved to
// property-edit.ts — shared with the operator peek panels so a task reads
// identically on both surfaces.

/** Attribute keys that render as dedicated rows, kept out of the generic
 *  attributes fold so they never show twice. */
const TASK_DEDICATED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(["priority"]);

const SENSITIVITY_DOT_CLASS: Record<string, string> = {
  public: "bg-emerald-500",
  internal: "bg-amber-500",
  confidential: "bg-red-500",
};

/** Big page icon per row kind — the Notion page-icon slot. */
function pageKindIcon(kind: string): React.ReactNode {
  switch (kind) {
    case "tasks":
      return <SquareCheckBig />;
    case "memories":
      return <Sparkles />;
    case "files":
      return <FileText />;
    case "knowledge":
      return <BookOpen />;
    case "people":
    case "person":
      return <UserRound />;
    case "companies":
    case "company":
      return <Building2 />;
    case "deals":
    case "deal":
      return <Handshake />;
    case "project":
      return <Folder />;
    case "product":
      return <Package />;
    case "repository":
      return <FolderGit2 />;
    case "sessions":
      return <MessageSquare />;
    default:
      return <Box />;
  }
}

/** Icon per known property key; generic fields fall back to AlignLeft. */
function propertyIcon(key: string): React.ReactNode {
  switch (key) {
    case "status":
      return <CircleDashed />;
    case "priority":
      return <Flag />;
    case "due_at":
    case "close_date":
      return <Calendar />;
    case "tags":
      return <Tags />;
    case "sensitivity":
      return <Shield />;
    case "scope":
      return <Users />;
    case "assignee_id":
      return <UserRound />;
    case "created_at":
      return <Clock />;
    case "updated_at":
      return <History />;
    case "path":
    case "mime_type":
    case "name":
      return <FileText />;
    case "attributes":
      return <Braces />;
    default:
      return <AlignLeft />;
  }
}

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
  // Lifted page actions — Confirm / Ask / Delete / Change type live in the
  // top toolbar (the Notion chrome position), so the shell owns them rather
  // than each section rendering its own button row.
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Bumped by the toolbar's "Change type" item; EntitySection listens and
  // opens its change-type panel.
  const [changeTypeTick, setChangeTypeTick] = useState(0);
  // Bumped by the toolbar's "Ask about this" item; EntryThread scrolls its
  // composer into view and focuses it.
  const [askFocusTick, setAskFocusTick] = useState(0);

  const displayRowId = displayRow?.id ?? null;
  useEffect(() => {
    setActionBusy(false);
    setActionError(null);
    setChangeTypeTick(0);
    setAskFocusTick(0);
  }, [displayRowId]);

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
      const routedKind = displayRow.kind;
      const routedId = displayRow.id;

      // Post CRM→entity unification the entity IS the record — there is no
      // separate specialization row to resolve. A graph click on a
      // person/company/deal node maps its kind to the plural primitive,
      // keeping the SAME id (the id is the entity id), so it renders
      // identically to the list view. This removal of the companion
      // redirect is what fixes the self-entity "PERSON vs PEOPLE"
      // inconsistency (every entity now renders one consistent label).
      if (isCrmEntityKind) {
        const routedKind =
          displayRow.kind === "company"
            ? "companies"
            : displayRow.kind === "person"
              ? "people"
              : "deals";
        setDisplayRow({
          id: displayRow.id,
          kind: routedKind as BrainRow["kind"],
          name: displayRow.name,
          sensitivity: displayRow.sensitivity,
        });
        return; // re-triggers this effect with the plural primitive kind.
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

  // The live kind (reclassify patches `primitive.body`, never `displayRow`)
  // drives the big page icon. For non-entity primitives the kind lives in
  // `displayRow.kind` (memories / tasks / …), not the body.
  const headerKind =
    primitive && typeof primitive.body.kind === "string"
      ? primitive.body.kind
      : displayRow.kind;
  // The page title renders inside the scroll body (the Notion sub-page
  // shape). Interactive sections own it (inline rename); the static
  // branches below (loading / not-found / knowledge) render it here.
  const sectionOwnsTitle =
    !loading && !notFound && !isKnowledgeKind && (isEntityKind || inboxPrim !== null);
  // Verified state renders as a small toolbar chip, not a body banner —
  // the page body stays title → properties → content.
  const rowVerified = Boolean(primitive?.verifiedAt);

  // Toolbar actions target the same primitive the sections adjust. Knowledge
  // is read-only (no inbox primitive) → no actions, no composer.
  const actionPrim = isEntityKind ? ("entity" as InboxPrimitive) : inboxPrim;
  const canAct = !loading && !notFound && Boolean(primitive) && actionPrim !== null;

  async function handleConfirm() {
    if (!primitive || !actionPrim) return;
    setActionBusy(true);
    setActionError(null);
    const result = await verifyBrainRow(workspaceId, actionPrim, primitive.id);
    setActionBusy(false);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    setPrimitive({
      ...primitive,
      verifiedAt: new Date().toISOString(),
      verifiedByUserId: primitive.verifiedByUserId ?? "self",
    });
    requestBrainRefresh(workspaceId);
  }

  async function requestDelete() {
    if (!primitive || !actionPrim) return;
    const ok = await confirmDialog({
      title: t.memoriesReview.delete,
      description: t.memoriesReview.deleteConfirmBody,
      confirmLabel: t.memoriesReview.deleteConfirmAction,
      cancelLabel: t.memoriesReview.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setActionBusy(true);
    setActionError(null);
    const result = await deleteBrainRow(workspaceId, actionPrim, primitive.id);
    setActionBusy(false);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    // Drop the row from the brain page (list / facets / graph / count)
    // before the drawer closes, so it doesn't linger stale behind it.
    requestBrainRefresh(workspaceId);
    onClose();
  }

  const overflowItems: OverflowItem[] = canAct
    ? [
        {
          key: "ask",
          label: t.memoriesReview.askAboutThis,
          disabled: actionBusy,
          onClick: () => setAskFocusTick((n) => n + 1),
        },
        ...(isEntityKind
          ? [
              {
                key: "change-type",
                label: labels.changeType,
                disabled: actionBusy,
                onClick: () => setChangeTypeTick((n) => n + 1),
              },
            ]
          : []),
        {
          key: "delete",
          label: t.memoriesReview.delete,
          destructive: true,
          disabled: actionBusy,
          onClick: () => void requestDelete(),
        },
      ]
    : [];

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
          "w-full sm:w-[480px] lg:w-[640px] xl:w-[760px] bg-popover border-l border-border shadow-2xl",
          "flex flex-col overflow-hidden",
          "duration-300 ease-out will-change-transform",
          closing
            ? "animate-out slide-out-to-right"
            : "animate-in slide-in-from-right",
        )}
      >
        {/* Top toolbar — the Notion chrome position: quiet state on the
            left, page actions on the right. */}
        <header className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border">
          <div className="flex items-center gap-1.5 min-w-0 flex-1 pl-1">
            {rowVerified && (
              <span
                title={t.brainInbox.detailVerifiedNote}
                className="text-[11px] px-1.5 py-0.5 rounded text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 inline-flex items-center gap-1"
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
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                {labels.confirmedChip}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {canAct && !rowVerified && (
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => void handleConfirm()}
                className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {t.memoriesReview.confirm}
              </button>
            )}
            <OverflowMenu ariaLabel={labels.moreActions} items={overflowItems} />
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
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-4">
          {actionError && (
            <p className="text-xs text-red-500" role="alert">
              {actionError}
            </p>
          )}

          {/* Page icon + title share one row (the icon leads the title);
              interactive sections receive the icon via `pageIcon` and
              render it inside their PageTitle. The title still renders
              while loading / not-found (seeded from the list row); the
              icon waits for the loaded kind. */}
          {!sectionOwnsTitle && (
            <div className="flex items-start gap-3">
              {!loading && !notFound && (
                <span
                  className="mt-0.5 shrink-0 text-muted-foreground/40 [&_svg]:size-8 [&_svg]:stroke-[1.5]"
                  aria-hidden
                >
                  {pageKindIcon(headerKind)}
                </span>
              )}
              <h2 className="min-w-0 text-3xl font-bold leading-tight break-words">
                {headerName}
              </h2>
            </div>
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
              changeTypeTick={changeTypeTick}
              pageIcon={pageKindIcon(headerKind)}
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
              pageIcon={pageKindIcon(headerKind)}
              onUpdated={(next) => {
                setPrimitive(next);
                // Keep the brain page (list row, facets, graph,
                // unconfirmed count) in sync with this verify / adjust.
                requestBrainRefresh(workspaceId);
              }}
            />
          )}

          {/* The "Comments" analog — an inline ephemeral Q&A thread with
              the workspace's primary assistant, right on the page. */}
          {canAct && primitive && actionPrim && (
            <EntryThread
              key={displayRowId ?? "none"}
              workspaceId={workspaceId}
              primitive={actionPrim}
              rowId={primitive.id}
              entrySummary={headerName || t.memoriesReview.unknownAuthor}
              entryDetail={
                typeof primitive.body.detail === "string"
                  ? primitive.body.detail
                  : null
              }
              entryCreatedAt={primitive.createdAt}
              entryUpdatedAt={primitive.updatedAt}
              focusTick={askFocusTick}
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
  const review = t.memoriesReview;
  const propLabels = labels.propertyLabels as Record<string, string>;

  const sensitivityOptions: SelectPropertyOption[] = [
    {
      value: "public",
      label: review.sensitivityPublic,
      dotClassName: SENSITIVITY_DOT_CLASS.public,
    },
    {
      value: "internal",
      label: review.sensitivityInternal,
      dotClassName: SENSITIVITY_DOT_CLASS.internal,
    },
    {
      value: "confidential",
      label: review.sensitivityConfidential,
      dotClassName: SENSITIVITY_DOT_CLASS.confidential,
    },
  ];

  return (
    <>
      {entry.summary && (
        <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
          {entry.summary}
        </p>
      )}

      {/* Properties first, page body after — the Notion page order. All
          read-only: the source of truth is the synced repo. */}
      <div className="flex flex-col">
        <SelectProperty
          icon={propertyIcon("sensitivity")}
          label={propLabels.sensitivity}
          value={String(entry.sensitivity ?? "")}
          options={sensitivityOptions}
          readOnly
        />
        <StaticProperty
          icon={propertyIcon("path")}
          label={labels.knowledgePathLabel}
          value={entry.path}
          mono
        />
        {entry.tags.length > 0 && (
          <TagsProperty
            icon={propertyIcon("tags")}
            label={labels.knowledgeTagsLabel}
            tags={entry.tags}
            readOnly
          />
        )}
        <StaticProperty
          icon={propertyIcon("updated_at")}
          label={propLabels.updated_at}
          value={new Date(entry.updatedAt).toLocaleString()}
        />
      </div>

      {entry.content.trim().length > 0 ? (
        <section className="flex flex-col gap-2 border-t border-border pt-4 mt-1">
          <h3 className="text-sm font-medium text-foreground/80">
            {labels.knowledgeContentHeading}
          </h3>
          <div className="chat-markdown text-sm leading-relaxed break-words">
            <Markdown>{entry.content}</Markdown>
          </div>
        </section>
      ) : (
        <p className="text-xs text-muted-foreground">{labels.noBody}</p>
      )}
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

/** Read-only attribute rows for an entity rollup, in the shared
 *  property-row face. Renders nothing when the entity carries no display
 *  attributes (the sensitivity row above keeps the list non-empty). */
function EntityBody({ entity }: { entity: EntityRollup }) {
  const t = useT();
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

  if (rows.length === 0) return null;

  return (
    <>
      {rows.map((row) => (
        <StaticProperty
          key={row.key}
          icon={propertyIcon(row.key)}
          label={row.label}
          value={row.value}
        />
      ))}
    </>
  );
}

// ── Entity section — review workflow + attribute body ────────────

type EntitySectionProps = {
  workspaceId: string;
  entity: EntityRollup;
  detail: BrainInboxRowDetail;
  /** Bumped by the drawer toolbar's "Change type" item — opens the panel. */
  changeTypeTick: number;
  /** The kind icon rendered inline with the page title (same row). */
  pageIcon?: React.ReactNode;
  onUpdated: (next: BrainInboxRowDetail) => void;
};

/** Mirror of `PrimitiveSection` for the `entity` brain primitive: page
 *  title (inline rename), sensitivity + attribute property rows, aliases,
 *  change-type panel (toolbar-triggered), and the source context. Page
 *  actions (Confirm / Ask / Delete / Change type) live in the drawer
 *  toolbar, not here. */
function EntitySection({
  workspaceId,
  entity,
  detail,
  changeTypeTick,
  pageIcon,
  onUpdated,
}: EntitySectionProps) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;
  const review = t.memoriesReview;

  const initialName = String(
    detail.body.display_name ?? entity.name ?? "",
  );
  const rawSensitivity = String(detail.body.sensitivity ?? "internal");

  const [mode, setMode] = useState<Mode>("view");

  const [whyDetailsOpen, setWhyDetailsOpen] = useState(false);
  const [whyLoading, setWhyLoading] = useState(true);
  const [whyContext, setWhyContext] = useState<ExplainContext | null>(null);

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

  // Reset transient panel state when the underlying row swaps.
  useEffect(() => {
    setMode("view");
  }, [detail.id]);

  // Toolbar "Change type" → open the panel.
  useEffect(() => {
    if (changeTypeTick > 0) setMode("change-type");
  }, [changeTypeTick]);

  /**
   * Inline property commit — entity adjust mutates in place + stamps
   * verified server-side, so mirror both locally. The parent's `onUpdated`
   * re-pulls the read-only rollup and refreshes the brain page.
   */
  async function commitChanges(
    changes: AdjustMemoryChanges,
  ): Promise<CommitResult> {
    const result = await adjustBrainRow(workspaceId, "entity", detail.id, changes);
    if (!result.ok) return { ok: false, error: result.error };
    onUpdated({
      ...detail,
      body: applyChangesToBody(detail.body, changes, "entity"),
      verifiedAt: new Date().toISOString(),
      verifiedByUserId: detail.verifiedByUserId ?? "self",
    });
    return { ok: true };
  }

  const propLabels = labels.propertyLabels as Record<string, string>;
  const sensitivityOptions: SelectPropertyOption[] = [
    {
      value: "public",
      label: review.sensitivityPublic,
      dotClassName: SENSITIVITY_DOT_CLASS.public,
    },
    {
      value: "internal",
      label: review.sensitivityInternal,
      dotClassName: SENSITIVITY_DOT_CLASS.internal,
    },
    {
      value: "confidential",
      label: review.sensitivityConfidential,
      dotClassName: SENSITIVITY_DOT_CLASS.confidential,
    },
  ];

  return (
    <>
      <PageTitle
        value={initialName}
        editable
        icon={pageIcon}
        onCommit={(next) => commitChanges({ display_name: next })}
      />

      {mode === "change-type" && (
        <ChangeTypePanel
          workspaceId={workspaceId}
          entityId={detail.id}
          currentKind={String(detail.body.kind ?? entity.kind ?? "product")}
          currentName={initialName}
          onCancel={() => setMode("view")}
          onChanged={(nextKind) => {
            // Mutate the local row's kind so the page icon + body re-render
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

      {/* Property list — sensitivity edits in place; the attribute rollup
          renders read-only beneath it, audit rows behind the fold. */}
      <div className="flex flex-col">
        <SelectProperty
          icon={propertyIcon("sensitivity")}
          label={propLabels.sensitivity}
          value={rawSensitivity}
          options={sensitivityOptions}
          onCommit={(v) =>
            commitChanges({
              sensitivity: v as NonNullable<AdjustMemoryChanges["sensitivity"]>,
            })
          }
        />
        <EntityBody entity={entity} />
        <MoreProperties
          count={(whyContext?.savedByAssistantName ? 1 : 0) + 2}
        >
          {whyContext?.savedByAssistantName && (
            <StaticProperty
              icon={<UserRound />}
              label={propLabels.created_by}
              value={whyContext.savedByAssistantName}
            />
          )}
          <StaticProperty
            icon={propertyIcon("created_at")}
            label={propLabels.created_at}
            value={new Date(detail.createdAt).toLocaleString()}
          />
          <StaticProperty
            icon={propertyIcon("updated_at")}
            label={propLabels.updated_at}
            value={new Date(detail.updatedAt ?? detail.createdAt).toLocaleString()}
          />
        </MoreProperties>
      </div>

      <AliasesSection
        workspaceId={workspaceId}
        entityId={detail.id}
        initialAliases={entity.aliases ?? []}
      />

      <section className="flex flex-col gap-2 border-t border-border pt-4 mt-1">
        <h3 className="text-sm font-medium text-foreground/80">
          {labels.provenanceHeading}
        </h3>
        <WhyBody
          loading={whyLoading}
          context={whyContext}
          primitiveSummary={initialName}
          detailsOpen={whyDetailsOpen}
          onToggleDetails={() => setWhyDetailsOpen((v) => !v)}
        />
      </section>
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
  /** The kind icon rendered inline with the page title (same row). */
  pageIcon?: React.ReactNode;
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

/**
 * Click-to-edit page body for a memory's `detail` field — the Notion
 * "page content" analog beneath the property list. View mode renders
 * markdown; clicking it (or the pencil next to the heading) swaps in a
 * textarea. Blur or Cmd/Ctrl+Enter commits; Escape cancels.
 */
/**
 * "Re-ingest to brain" on a stored file's drawer — the user-reachable recovery
 * for "this file never made it into the brain" (file-artifacts.md
 * §"Re-ingest"). The SERVER owns the double-ingestion guard: an
 * already-ingested file answers requires_confirmation, which this section
 * relays through `confirmDialog` (re-ingesting spends credits and can
 * duplicate extracted memories) before re-sending with confirm: true. Inline
 * status text, matching the drawer's local idiom (no toast system here).
 */
function FileReingestSection({
  workspaceId,
  fileId,
  fileName,
  labels,
  cancelLabel,
}: {
  workspaceId: string;
  fileId: string;
  fileName: string;
  labels: {
    action: string;
    confirmTitle: string;
    confirmBody: string;
    confirmAction: string;
    queued: string;
    inFlight: string;
    failed: string;
  };
  cancelLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"queued" | "in_flight" | "failed" | null>(null);

  async function handleReingest() {
    setBusy(true);
    setStatus(null);
    try {
      let outcome = await reingestStoredFile(workspaceId, fileId);
      if (outcome.status === "requires_confirmation") {
        const ok = await confirmDialog({
          title: labels.confirmTitle,
          description: format(labels.confirmBody, {
            name: outcome.fileName || fileName,
          }),
          confirmLabel: labels.confirmAction,
          cancelLabel,
        });
        if (!ok) return;
        outcome = await reingestStoredFile(workspaceId, fileId, { confirm: true });
      }
      setStatus(outcome.status === "queued" ? "queued" : "in_flight");
    } catch {
      setStatus("failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={handleReingest}
        className="self-start text-xs px-3 py-1.5 rounded-md border border-border text-foreground hover:bg-accent disabled:opacity-50"
      >
        {labels.action}
      </button>
      {status === "queued" && <p className="text-xs text-emerald-600 dark:text-emerald-400">{labels.queued}</p>}
      {status === "in_flight" && <p className="text-xs text-muted-foreground">{labels.inFlight}</p>}
      {status === "failed" && <p className="text-xs text-red-500">{labels.failed}</p>}
    </div>
  );
}

function MemoryDetailBody({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit: (next: string) => Promise<CommitResult>;
}) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;
  const committed = value ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(committed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commit() {
    setEditing(false);
    if (draft === committed) return;
    setBusy(true);
    setError(null);
    const result = await onCommit(draft);
    setBusy(false);
    if (!result.ok) {
      setDraft(committed);
      setError(result.error ?? labels.saveFailed);
    }
  }

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4 mt-1">
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-medium text-foreground/80">
          {labels.propertyLabels.detail}
        </h3>
        {!editing && (
          <button
            type="button"
            disabled={busy}
            aria-label={format(labels.editValue, {
              label: labels.propertyLabels.detail,
            })}
            onClick={() => {
              setDraft(committed);
              setError(null);
              setEditing(true);
            }}
            className="h-5 w-5 rounded text-muted-foreground/50 hover:bg-muted hover:text-foreground inline-flex items-center justify-center"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            </svg>
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          rows={6}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(committed);
              setEditing(false);
            }
          }}
          className="w-full resize-y rounded-md bg-muted/50 px-2.5 py-2 text-sm leading-relaxed outline-none ring-1 ring-ring/40"
        />
      ) : (
        <div
          onClick={() => {
            if (busy) return;
            setDraft(committed);
            setError(null);
            setEditing(true);
          }}
          className={cn(
            "rounded-md -mx-1.5 px-1.5 py-1 cursor-text transition-colors hover:bg-muted/40",
            busy && "opacity-60",
          )}
        >
          {committed.trim().length > 0 ? (
            <div className="chat-markdown text-sm leading-relaxed break-words">
              <Markdown>{committed}</Markdown>
            </div>
          ) : (
            <span className="text-sm text-muted-foreground/60">
              {labels.detailPlaceholder}
            </span>
          )}
        </div>
      )}
      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function PrimitiveSection({
  workspaceId,
  primitive,
  detail,
  crmEntity,
  pageIcon,
  onUpdated,
}: PrimitiveSectionProps) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;
  const review = t.memoriesReview;

  const isMemory = primitive === "memory";
  const isCrm = primitive === "company" || primitive === "contact" || primitive === "deal";
  const isFile = primitive === "workspace_file";
  const isTask = primitive === "task";
  // Task autopilot: the goal auto-drafted for this task (Confirm / Work this).
  const [taskGoal, setTaskGoal] = useState<GoalRow | null>(null);
  const [goalBusy, setGoalBusy] = useState(false);
  const [goalError, setGoalError] = useState<string | null>(null);
  // Inline goal-outcome edit (click the outcome text). Editing never
  // confirms a draft; a completed goal renders read-only (the server
  // refuses the edit anyway).
  const [goalEditing, setGoalEditing] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  // Load this task's auto-drafted goal. Best-effort — the affordance stays
  // hidden if there's none (a sub-task, or a task edited so the host link moved).
  useEffect(() => {
    if (!isTask) return;
    let cancelled = false;
    setTaskGoal(null);
    setGoalError(null);
    setGoalEditing(false);
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
  async function handleCommitGoalOutcome() {
    if (!taskGoal) return;
    setGoalEditing(false);
    const next = goalDraft.trim();
    if (next.length === 0 || next === taskGoal.outcome) return;
    setGoalBusy(true);
    setGoalError(null);
    const r = await updateGoalOutcome(taskGoal.id, next);
    setGoalBusy(false);
    if (!r.ok) {
      setGoalError(r.error ?? t.brainPage.detailDrawer.saveFailed);
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

  // Property-row inputs (each row edits in place and commits on its own —
  // there is no drawer-wide edit mode anymore).
  const rowTags = bodyTags(detail.body.tags);
  const taskStatusLabels = t.brainPage.taskStatus as Record<string, string>;
  const taskTitle = isTask ? String(detail.body.title ?? "") : "";
  const taskStatus = isTask ? String(detail.body.status ?? "todo") : "todo";
  const taskDueDate = isTask ? isoToDateInput(detail.body.due_at) : "";

  // Task assignee — `assignee_id` is a `workspace_members` row id, resolved
  // to the member's name/avatar/role against the workspace roster (cached
  // per workspace). Editable: the row is the roster picker and commits
  // `assignee_id` through the adjust wire (null unassigns), so the roster
  // loads for every task (the picker needs it even when unassigned).
  const taskAssigneeId =
    isTask && typeof detail.body.assignee_id === "string"
      ? detail.body.assignee_id
      : "";
  const [roster, setRoster] = useState<AssignableMember[] | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);
  useEffect(() => {
    if (!isTask) return;
    let cancelled = false;
    setRosterLoading(true);
    loadWorkspaceRoster(workspaceId)
      .then((rows) => {
        if (!cancelled) setRoster(rows);
      })
      .catch(() => {
        if (!cancelled) setRoster([]);
      })
      .finally(() => {
        if (!cancelled) setRosterLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isTask, workspaceId]);
  const assigneeMember =
    taskAssigneeId.length > 0 && roster
      ? resolveAssignee(roster, taskAssigneeId)
      : null;
  const memberRoleLabels = labels.memberRole as Record<string, string>;
  const assigneeOptions: PersonPropertyOption[] = (roster ?? []).map((m) => ({
    id: m.id,
    name: memberDisplayName(m) ?? labels.memberUnknown,
    email: m.email,
    avatarUrl: m.avatarUrl,
    roleLabel: memberRoleLabels[m.role] ?? null,
  }));

  // Task priority — the conventional `attributes.priority` key (the frozen-v1
  // schema has no typed column). Rendered as its own select row; the generic
  // attributes fold omits the key so it never shows twice.
  const taskPriority = isTask ? attributePriority(detail.body.attributes) : "";
  const taskPriorityLabels = t.brainPage.taskPriority as Record<string, string>;

  const [whyDetailsOpen, setWhyDetailsOpen] = useState(false);
  const [whyLoading, setWhyLoading] = useState(true);
  const [whyContext, setWhyContext] = useState<ExplainContext | null>(null);

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

  /**
   * Inline property commit — one adjust per field, straight from the row.
   * Task + memory adjusts supersede the row (a new bi-temporal id): the
   * response carries it, so re-anchor `detail.id` and keep the panel open.
   * Entity-family adjusts (CRM / file) mutate in place and stamp verified
   * server-side — mirror the stamp locally. Task supersession carries its
   * audit in the preserved old row and leaves the verify flag alone.
   */
  async function commitChanges(
    changes: AdjustMemoryChanges,
  ): Promise<CommitResult> {
    const result = await adjustBrainRow(
      workspaceId,
      primitive,
      detail.id,
      changes,
    );
    if (!result.ok) return { ok: false, error: result.error };
    // `onUpdated` also asks the brain page to refetch (list / facets /
    // graph / count) so the row behind the drawer reflects the edit.
    onUpdated({
      ...detail,
      id: result.newId ?? detail.id,
      body: applyChangesToBody(detail.body, changes, primitive),
      ...(isTask
        ? {}
        : {
            verifiedAt: new Date().toISOString(),
            verifiedByUserId: detail.verifiedByUserId ?? "self",
          }),
    });
    return { ok: true };
  }

  // Page title per primitive: tasks edit `title`, memories edit `summary`,
  // CRM rows edit `display_name` (mirrored to `name` server-side). Files
  // keep a static name (rename is path-coupled, out of scope).
  const pageTitleValue = isTask
    ? taskTitle
    : isMemory
      ? summary
      : isCrm
        ? crmName
        : String(detail.body.name ?? detail.body.title ?? "");
  const canRenameInline = isTask || isMemory || isCrm;
  async function commitTitle(next: string): Promise<CommitResult> {
    if (isTask) return commitChanges({ title: next });
    if (isMemory) return commitChanges({ summary: next });
    if (isCrm) return commitChanges({ display_name: next });
    return { ok: true };
  }

  const propLabels = labels.propertyLabels as Record<string, string>;
  const statusOptions: SelectPropertyOption[] = (
    ["todo", "in_progress", "blocked", "done", "archived"] as const
  ).map((s) => ({
    value: s,
    label: taskStatusLabels[s] ?? s,
    dotClassName: TASK_STATUS_DOT_CLASS[s],
  }));
  // "none" is a select-only sentinel — the wire clears with null (the
  // attributes key is removed, never stored as "none").
  const priorityOptions: SelectPropertyOption[] = (
    ["none", "low", "medium", "high", "urgent"] as const
  ).map((p) => ({
    value: p,
    label: taskPriorityLabels[p] ?? p,
    dotClassName: TASK_PRIORITY_DOT_CLASS[p],
  }));
  const sensitivityOptions: SelectPropertyOption[] = [
    {
      value: "public",
      label: review.sensitivityPublic,
      dotClassName: SENSITIVITY_DOT_CLASS.public,
    },
    {
      value: "internal",
      label: review.sensitivityInternal,
      dotClassName: SENSITIVITY_DOT_CLASS.internal,
    },
    {
      value: "confidential",
      label: review.sensitivityConfidential,
      dotClassName: SENSITIVITY_DOT_CLASS.confidential,
    },
  ];
  const scopeOptions: SelectPropertyOption[] = [
    { value: "personal", label: review.scopePersonal },
    { value: "workspace_shared", label: review.scopeWorkspaceShared },
    { value: "workspace", label: review.scopeWorkspace },
  ];

  // Priority renders as its own dedicated row above, so keep it out of the
  // generic attributes fold.
  const attributeRows = isTask
    ? flattenAttributes(detail.body.attributes, TASK_DEDICATED_ATTRIBUTE_KEYS)
    : [];
  const extraFields = extraBodyFields(primitive, detail.body);
  // CRM rows keep their substance (email / domain / stage …) visible; for
  // the other kinds the generic remainder is secondary and folds behind
  // "N more properties" together with the audit rows.
  const visibleExtras = isCrm ? extraFields : [];
  const foldedExtras = isCrm ? [] : extraFields;
  const createdByName = whyContext?.savedByAssistantName ?? null;
  const foldedCount =
    attributeRows.length + foldedExtras.length + (createdByName ? 1 : 0) + 2;

  return (
    <>
      <PageTitle
        value={pageTitleValue}
        editable={canRenameInline}
        icon={pageIcon}
        onCommit={commitTitle}
      />

      {/* Property list — one inline-editable row per field. */}
      <div className="flex flex-col">
        {isTask && (
          <>
            <SelectProperty
              icon={propertyIcon("status")}
              label={propLabels.status}
              value={taskStatus}
              options={statusOptions}
              onCommit={(v) =>
                commitChanges({
                  status: v as NonNullable<AdjustMemoryChanges["status"]>,
                })
              }
            />
            <SelectProperty
              icon={propertyIcon("priority")}
              label={propLabels.priority}
              value={taskPriority || "none"}
              options={priorityOptions}
              onCommit={(v) =>
                commitChanges({
                  priority:
                    v === "none"
                      ? null
                      : (v as NonNullable<AdjustMemoryChanges["priority"]>),
                })
              }
            />
            <DateProperty
              icon={propertyIcon("due_at")}
              label={propLabels.due_at}
              value={taskDueDate}
              onCommit={(v) => commitChanges({ due_at: dateInputToIso(v) })}
            />
            <PersonProperty
              icon={propertyIcon("assignee_id")}
              label={propLabels.assignee_id}
              loading={rosterLoading}
              unknownLabel={
                taskAssigneeId.length > 0 ? labels.memberUnknown : null
              }
              options={assigneeOptions}
              currentId={taskAssigneeId || null}
              clearLabel={labels.assigneeUnassigned}
              onCommit={(id) => commitChanges({ assignee_id: id })}
              value={
                assigneeMember
                  ? {
                      name:
                        memberDisplayName(assigneeMember) ??
                        labels.memberUnknown,
                      email: assigneeMember.email,
                      avatarUrl: assigneeMember.avatarUrl,
                      roleLabel:
                        memberRoleLabels[assigneeMember.role] ?? null,
                    }
                  : null
              }
            />
            <TagsProperty
              icon={propertyIcon("tags")}
              label={propLabels.tags}
              tags={rowTags}
              placeholder={labels.filePreview.tagsPlaceholder}
              onCommit={(next) => commitChanges({ tags: next })}
            />
            {/* Task sensitivity carries forward untouched on edit (not in
                TaskUpdateFields) — read-only row. */}
            <SelectProperty
              icon={propertyIcon("sensitivity")}
              label={propLabels.sensitivity}
              value={rawSensitivity}
              options={sensitivityOptions}
              readOnly
            />
          </>
        )}

        {isMemory && (
          <>
            <SelectProperty
              icon={propertyIcon("scope")}
              label={propLabels.scope}
              value={inferredScope}
              options={scopeOptions}
              onCommit={(v) =>
                commitChanges({
                  scope: v as NonNullable<AdjustMemoryChanges["scope"]>,
                })
              }
            />
            <SelectProperty
              icon={propertyIcon("sensitivity")}
              label={propLabels.sensitivity}
              value={rawSensitivity}
              options={sensitivityOptions}
              onCommit={(v) =>
                commitChanges({
                  sensitivity: v as NonNullable<
                    AdjustMemoryChanges["sensitivity"]
                  >,
                })
              }
            />
            {rowTags.length > 0 && (
              <TagsProperty
                icon={propertyIcon("tags")}
                label={propLabels.tags}
                tags={rowTags}
                readOnly
              />
            )}
          </>
        )}

        {(isFile || isCrm) && (
          <SelectProperty
            icon={propertyIcon("sensitivity")}
            label={propLabels.sensitivity}
            value={rawSensitivity}
            options={sensitivityOptions}
            onCommit={(v) =>
              commitChanges({
                sensitivity: v as NonNullable<
                  AdjustMemoryChanges["sensitivity"]
                >,
              })
            }
          />
        )}

        {isFile && (
          <TagsProperty
            icon={propertyIcon("tags")}
            label={propLabels.tags}
            tags={rowTags}
            placeholder={labels.filePreview.tagsPlaceholder}
            onCommit={(next) => commitChanges({ tags: next })}
          />
        )}

        {visibleExtras.map(([k, v]) => (
          <StaticProperty
            key={k}
            icon={propertyIcon(k)}
            label={propLabels[k] ?? humaniseKey(k)}
            value={v}
          />
        ))}

        <MoreProperties count={foldedCount}>
          {attributeRows.map(([k, v]) => (
            <StaticProperty
              key={`attr:${k}`}
              icon={propertyIcon("attributes")}
              label={humaniseKey(k)}
              value={v}
            />
          ))}
          {foldedExtras.map(([k, v]) => (
            <StaticProperty
              key={k}
              icon={propertyIcon(k)}
              label={propLabels[k] ?? humaniseKey(k)}
              value={v}
            />
          ))}
          {createdByName && (
            <StaticProperty
              icon={<UserRound />}
              label={propLabels.created_by}
              value={createdByName}
            />
          )}
          <StaticProperty
            icon={propertyIcon("created_at")}
            label={propLabels.created_at}
            value={new Date(detail.createdAt).toLocaleString()}
          />
          <StaticProperty
            icon={propertyIcon("updated_at")}
            label={propLabels.updated_at}
            value={new Date(detail.updatedAt ?? detail.createdAt).toLocaleString()}
          />
        </MoreProperties>
      </div>

      {isTask && taskGoal && (
        <section className="flex flex-col gap-2 rounded-lg border border-border bg-card/50 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {labels.goalHeading}
          </div>
          {goalEditing ? (
            <textarea
              autoFocus
              value={goalDraft}
              rows={2}
              disabled={goalBusy}
              aria-label={format(labels.editValue, { label: labels.goalHeading })}
              onChange={(e) => setGoalDraft(e.target.value)}
              onBlur={() => void handleCommitGoalOutcome()}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleCommitGoalOutcome();
                }
                if (e.key === "Escape") {
                  // Cancel without letting the drawer's global Escape-close fire.
                  e.stopPropagation();
                  setGoalEditing(false);
                }
              }}
              className="w-full resize-none field-sizing-content rounded-md bg-muted/50 px-1.5 py-1 -ml-1.5 text-sm outline-none ring-1 ring-ring/40"
            />
          ) : taskGoal.status === "done" ? (
            <p className="text-sm text-foreground">{taskGoal.outcome}</p>
          ) : (
            <button
              type="button"
              disabled={goalBusy}
              aria-label={format(labels.editValue, { label: labels.goalHeading })}
              onClick={() => {
                setGoalDraft(taskGoal.outcome);
                setGoalError(null);
                setGoalEditing(true);
              }}
              className="-ml-1.5 rounded-md px-1.5 py-1 text-left text-sm text-foreground transition-colors hover:bg-muted/70 disabled:opacity-60"
            >
              {taskGoal.outcome}
            </button>
          )}
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

      {isMemory && (
        <MemoryDetailBody
          value={memoryDetail}
          onCommit={(next) => commitChanges({ detail: next })}
        />
      )}

      {isFile && (
        <section className="flex flex-col gap-2 border-t border-border pt-4 mt-1">
          <h3 className="text-sm font-medium text-foreground/80">
            {labels.filePreview.heading}
          </h3>
          <FileContentPreview
            workspaceId={workspaceId}
            fileId={detail.id}
            mime={String(detail.body.mime_type ?? "")}
            name={String(detail.body.name ?? "file")}
          />
          <FileReingestSection
            workspaceId={workspaceId}
            fileId={detail.id}
            fileName={String(detail.body.name ?? "file")}
            labels={labels.fileReingest}
            cancelLabel={review.cancel}
          />
        </section>
      )}

      {crmEntity && <EmbeddedRollupSections rollup={crmEntity} />}

      <section className="flex flex-col gap-2 border-t border-border pt-4 mt-1">
        <h3 className="text-sm font-medium text-foreground/80">
          {labels.provenanceHeading}
        </h3>
        <WhyBody
          loading={whyLoading}
          context={whyContext}
          primitiveSummary={summary}
          detailsOpen={whyDetailsOpen}
          onToggleDetails={() => setWhyDetailsOpen((v) => !v)}
        />
      </section>
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

// (listDetailFields / formatValue / humaniseKey moved to property-edit.ts —
// the property page's pure logic module.)

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

  const clue = originClue(
    context.origin,
    review,
    context.savedAt,
    context.savedByAssistantName,
  );

  if (context.messages.length === 0) {
    // No chat to show — the origin clue is the whole Source story
    // ("Extracted from a meeting on …", "Added manually by …"). The bare
    // "No source chat captured" line survives only when even the
    // descriptor can't name an origin.
    return (
      <div className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
        {clue ?? review.whyNoMessages}
      </div>
    );
  }

  const assistant = context.savedByAssistantName ?? review.unknownAuthor;
  const { capture, userTrigger } = deriveWhySummary(
    context.messages,
    primitiveSummary,
  );
  // Chat keeps the classic lead-in; workflow / scheduled sessions get the
  // origin clue instead (the lead-in's "during a chat" would misattribute).
  const leadIn =
    context.origin && context.origin.kind !== "chat" && clue
      ? clue
      : format(review.whyLeadIn, { assistant });

  return (
    <div className="flex flex-col gap-3 border-l-2 border-border pl-3 text-xs">
      <p className="text-muted-foreground italic">{leadIn}</p>

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
 * docs/architecture/engine/skill-system.md §7.1). Mirrors the
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
          "w-full sm:w-[480px] lg:w-[640px] xl:w-[760px] bg-popover border-l border-border shadow-2xl",
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
