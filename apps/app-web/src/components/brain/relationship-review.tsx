"use client";

/**
 * RelationshipReview — the DETAIL body for an `entity_link` review item.
 *
 * A raw edge row ("Edge Type: mentioned / Source Id: <uuid> / Target Id:
 * <uuid>") is unreviewable — a human can't tell what they're confirming. This
 * renders the edge as a labelled **source → edge → target** diagram instead:
 * each endpoint is a card (icon by kind + the backend-resolved name) connected
 * by the humanised edge verb, and each card EXPANDS to lazily fetch + show that
 * endpoint's own details (the memory's text, the file's metadata, the entity's
 * attributes) so the user can meaningfully decide "looks correct" vs delete.
 *
 * Endpoint names come from `body.source_label` / `body.target_label` (resolved
 * server-side in `brain-inbox-store.ts`); the expand fetch reuses the generic
 * `fetchBrainRow` single-row surface, which covers memory / file / task /
 * entity. Endpoints with no single-row surface (episode / kb_chunk) render
 * without an expander. A DANGLING endpoint — a resolvable kind whose label is
 * null (the label columns are NOT NULL, so null ⇒ the row was hard-deleted) —
 * renders as a flat dashed "No longer exists" card up front, so a stale edge
 * left behind by a deleted memory/file is obvious and the user can just delete
 * it (the edges aren't cascade-cleaned when an endpoint is purged).
 *
 * [COMP:app-web/relationship-review]
 */

import { useState } from "react";
import Link from "next/link";
import Markdown from "react-markdown";
import {
  BookText,
  Bot,
  Box,
  ChevronDown,
  ExternalLink,
  File as FileIcon,
  ListChecks,
  MessageSquare,
  Sparkles,
  StickyNote,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import {
  fetchBrainRow,
  type BrainInboxRowDetail,
  type BrainPrimitive as InboxPrimitive,
} from "@/lib/api/brain-inbox";
import {
  getWorkspaceSkill,
  type WorkspaceSkillSummary,
} from "@/lib/api/skills";

type EdgeEndpoint = { kind: string; id: string; label: string | null };

/** Endpoint kind → its inbox single-row primitive (for the expandable detail
 *  fetch). Endpoints with no single-row surface (episode / event / kb_chunk)
 *  return null and render without an expander. Exported for unit tests. */
export function endpointPrimitive(kind: string): InboxPrimitive | null {
  switch (kind) {
    case "memory":
      return "memory";
    case "file":
      return "workspace_file";
    case "task":
      return "task";
    case "entity":
      return "entity";
    default:
      return null; // episode / event / kb_chunk
  }
}

const KIND_ICON: Record<string, LucideIcon> = {
  memory: StickyNote,
  file: FileIcon,
  entity: Box,
  task: ListChecks,
  episode: MessageSquare,
  event: MessageSquare,
  kb_chunk: BookText,
  skill: Sparkles,
  assistant: Bot,
};

/** Humanise a snake/underscore data token for display ("documented_by" →
 *  "Documented by") — same treatment the edge name + body keys get. */
function humanise(token: string): string {
  const s = token.replace(/_/g, " ").trim();
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** Endpoint body keys that are provenance plumbing / opaque ids, not content
 *  a reviewer should see. Mirrors the review panel's hidden set. */
const HIDDEN_DETAIL_KEYS = new Set([
  "source_episode_id",
  "source_session_id",
  "assistant_id",
  "user_id",
  "verified_by_user_id",
  "verified_at",
  "original_scope",
  "original_sensitivity",
  "original_summary",
  "entity_id",
  "canonical_id",
  "detail", // rendered as markdown above the field list
]);

export function RelationshipReview({
  workspaceId,
  body,
}: {
  workspaceId: string;
  body: Record<string, unknown>;
}) {
  const t = useT();
  const rel = t.brainPage.reviewPanel.relationship;
  const edge = humanise(String(body.edge_type ?? "links"));
  const source: EdgeEndpoint = {
    kind: String(body.source_kind ?? ""),
    id: String(body.source_id ?? ""),
    label: strOrNull(body.source_label),
  };
  const target: EdgeEndpoint = {
    kind: String(body.target_kind ?? ""),
    id: String(body.target_id ?? ""),
    label: strOrNull(body.target_label),
  };

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
        {rel.heading}
      </h3>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {rel.explainer}
      </p>
      <div className="mt-1 flex flex-col">
        <EndpointCard
          workspaceId={workspaceId}
          endpoint={source}
          role={rel.source}
        />
        {/* Connector — the edge verb sits on a vertical line with a downward
            arrowhead, so the relationship reads source → target. */}
        <div className="flex flex-col items-center py-1.5">
          <span aria-hidden className="h-2.5 w-px bg-border" />
          <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {edge}
          </span>
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground/50" />
        </div>
        <EndpointCard
          workspaceId={workspaceId}
          endpoint={target}
          role={rel.target}
        />
      </div>
    </section>
  );
}

function EndpointCard({
  workspaceId,
  endpoint,
  role,
}: {
  workspaceId: string;
  endpoint: EdgeEndpoint;
  /** Localised "Source" / "Target". */
  role: string;
}) {
  const t = useT();
  const rel = t.brainPage.reviewPanel.relationship;
  const Icon = KIND_ICON[endpoint.kind] ?? Box;
  const primitive = endpointPrimitive(endpoint.kind);
  const kinds = rel.kinds as Record<string, string>;
  const kindLabel = kinds[endpoint.kind] ?? humanise(endpoint.kind);
  // A skill endpoint isn't a brain-inbox primitive (skills live in
  // `workspace_skills`, not the review union), so `endpointPrimitive` returns
  // null — but it IS previewable: the expander fetches the skill and shows its
  // description + a link into the full skill editor, so a "skill → learned_from
  // → assistant" review says which skill it is, not just "Skill".
  const isSkill = endpoint.kind === "skill";
  // The label columns are NOT NULL, so a RESOLVABLE endpoint kind with no
  // resolved label means its row was hard-deleted — this edge is dangling.
  // Flag it up front (no fetch needed) so a stale relationship is obvious and
  // the user can just delete it. (Non-resolvable kinds — episode / kb_chunk —
  // have a null label only because we don't resolve them, so never "missing".)
  const missing = primitive !== null && endpoint.label === null;
  const name = endpoint.label ?? kindLabel;
  const canExpand =
    (primitive !== null || isSkill) && endpoint.id.length > 0 && !missing;

  const [open, setOpen] = useState(false);
  // undefined = not fetched yet, null = fetch failed / gone.
  const [detail, setDetail] = useState<BrainInboxRowDetail | null | undefined>(
    undefined,
  );
  const [skill, setSkill] = useState<
    WorkspaceSkillSummary | null | undefined
  >(undefined);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    if (isSkill && skill === undefined) {
      void getWorkspaceSkill(workspaceId, endpoint.id).then((s) => setSkill(s));
    } else if (detail === undefined && primitive) {
      void fetchBrainRow(workspaceId, primitive, endpoint.id).then((d) =>
        setDetail(d),
      );
    }
  }

  const head = (
    <>
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-md bg-muted",
          missing ? "text-muted-foreground/40" : "text-muted-foreground",
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {role} · {kindLabel}
        </span>
        {missing ? (
          <span className="block text-sm italic text-muted-foreground">
            {rel.endpointMissing}
          </span>
        ) : (
          <span className="block truncate text-sm font-medium">{name}</span>
        )}
      </span>
    </>
  );

  // Dangling endpoint — a flat, dashed, non-interactive card (nothing to fetch).
  if (missing) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2.5">
        {head}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        disabled={!canExpand}
        aria-expanded={canExpand ? open : undefined}
        onClick={toggle}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left",
          canExpand && "hover:bg-muted/40 transition-colors",
        )}
      >
        {head}
        {canExpand && (
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        )}
      </button>
      {open && canExpand && (
        <div className="border-t border-border px-3 py-2.5">
          {isSkill ? (
            <SkillEndpointDetail
              workspaceId={workspaceId}
              skillRowId={endpoint.id}
              skill={skill}
              missing={rel.endpointMissing}
              unavailable={rel.detailsUnavailable}
            />
          ) : (
            <EndpointDetail
              detail={detail}
              missing={rel.endpointMissing}
              unavailable={rel.detailsUnavailable}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Expanded detail for a `skill` endpoint — the skill's description +
 *  when-to-use routing copy + Suggested/Active status, and the UX path to
 *  preview the exact skill: a link into the full skill editor
 *  (`/w/:ws/brain/skills/:rowId`). This is what makes a "learned_from" review
 *  reviewable — the user can see and open the skill they're confirming. */
function SkillEndpointDetail({
  workspaceId,
  skillRowId,
  skill,
  missing,
  unavailable,
}: {
  workspaceId: string;
  skillRowId: string;
  skill: WorkspaceSkillSummary | null | undefined;
  missing: string;
  unavailable: string;
}) {
  const t = useT();
  const rel = t.brainPage.reviewPanel.relationship;
  const href = `/w/${workspaceId}/brain/skills/${skillRowId}`;

  if (skill === undefined) {
    return <p className="text-xs text-muted-foreground">…</p>;
  }
  if (skill === null) {
    // Resolved a name at list time but the skill is gone now (deleted between).
    return <p className="text-xs italic text-muted-foreground">{missing}</p>;
  }

  const description = skill.description.trim();
  const whenToUse = skill.whenToUse?.trim() ?? "";
  const statusLabel = skill.activatedAt ? rel.skillActive : rel.skillSuggested;

  return (
    <div className="flex flex-col gap-2 text-xs">
      <span
        className={cn(
          "self-start rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
          skill.activatedAt
            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        )}
      >
        {statusLabel}
      </span>
      {description.length > 0 ? (
        <p className="leading-relaxed text-foreground">{description}</p>
      ) : (
        <p className="text-muted-foreground">{unavailable}</p>
      )}
      {whenToUse.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
            {rel.skillWhenToUse}
          </span>
          <p className="leading-relaxed text-muted-foreground">{whenToUse}</p>
        </div>
      )}
      <Link
        href={href}
        className="inline-flex items-center gap-1 self-start font-medium text-foreground underline-offset-2 hover:underline"
      >
        {rel.openSkill}
        <ExternalLink className="size-3" aria-hidden />
      </Link>
    </div>
  );
}

function EndpointDetail({
  detail,
  missing,
  unavailable,
}: {
  detail: BrainInboxRowDetail | null | undefined;
  missing: string;
  unavailable: string;
}) {
  if (detail === undefined) {
    return <p className="text-xs text-muted-foreground">…</p>;
  }
  if (detail === null) {
    // Resolved a label at list time but the row is gone now (deleted between).
    return <p className="text-xs italic text-muted-foreground">{missing}</p>;
  }

  const body = detail.body as Record<string, unknown>;
  const detailText = typeof body.detail === "string" ? body.detail : null;
  const fields = Object.entries(body).filter(
    ([k, v]) =>
      !HIDDEN_DETAIL_KEYS.has(k) &&
      v != null &&
      v !== "" &&
      (typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"),
  );

  if (!detailText && fields.length === 0) {
    return <p className="text-xs text-muted-foreground">{unavailable}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {detailText && detailText.trim().length > 0 && (
        <div className="chat-markdown text-sm leading-relaxed break-words">
          <Markdown>{detailText}</Markdown>
        </div>
      )}
      {fields.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          {fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{humanise(k)}</dt>
              <dd className="break-words">{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
