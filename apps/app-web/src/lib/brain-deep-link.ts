/**
 * Brain row deep links — `/w/<workspaceId>/brain?row=<rowId>&kind=<primitive>`.
 *
 * A brain row (a task, a contact, a company, a deal) opens in the
 * `BrainDetailDrawer` from page state only, so until now there was no URL that
 * pointed AT one. That made a row unshareable: a Slack digest, a workflow
 * message, or a teammate could link to the brain LIST and nothing finer. This
 * module is the URL contract for that link — one place that builds it and one
 * place that parses it, so the two can't drift.
 *
 * `kind` is optional and defaults to `task`, because a task is the row an
 * outside surface (digest, reminder, workflow) almost always wants to point
 * at, and a bare `?row=<uuid>` is the link a human is willing to paste.
 *
 * Knowledge rows are deliberately NOT reachable here — they own a full reader
 * route (`/brain/entry/knowledge/<id>`, `[COMP:app-web/entry-reader]`) and
 * `openRow` routes them there instead of to the drawer. Sending a knowledge id
 * through `?row=` would open a worse surface than the one that exists.
 *
 * Spec: docs/architecture/features/doc.md → "Brain deep links".
 * [COMP:app-web/brain-deep-link]
 */

import type { BrainPrimitive } from "@/lib/api/brain-inbox";

/** Query param carrying the row id. */
const BRAIN_ROW_PARAM = "row";
/** Query param carrying the row's primitive. Optional; defaults to `task`. */
const BRAIN_KIND_PARAM = "kind";

/**
 * Primitives a `?row=` link may address — every drawer-backed primitive the
 * single-row read (`GET /api/brain-inbox/:workspaceId/:primitive/:rowId`)
 * serves. `memory` and `entity` are included: both render in the drawer, and a
 * memory has no reader route of its own.
 */
const LINKABLE: readonly BrainPrimitive[] = [
  "task",
  "memory",
  "entity",
  "contact",
  "company",
  "deal",
  "workspace_file",
] as const;

/** The primitive a link with no explicit `kind` addresses. */
export const DEFAULT_LINKED_PRIMITIVE: BrainPrimitive = "task";

export type BrainDeepLink = {
  rowId: string;
  primitive: BrainPrimitive;
};

/**
 * Read a deep link off the page's query params. Returns null when the link is
 * absent or malformed — a bad `kind` is dropped rather than coerced to `task`,
 * so a typo'd link lands on the plain brain list instead of silently opening
 * the wrong row.
 */
export function parseBrainDeepLink(
  params: URLSearchParams,
): BrainDeepLink | null {
  const rowId = params.get(BRAIN_ROW_PARAM)?.trim();
  if (!rowId) return null;

  const rawKind = params.get(BRAIN_KIND_PARAM)?.trim();
  if (!rawKind) return { rowId, primitive: DEFAULT_LINKED_PRIMITIVE };

  const primitive = LINKABLE.find((p) => p === rawKind);
  return primitive ? { rowId, primitive } : null;
}

/**
 * Build the canonical link to a brain row. `origin` is the app origin (e.g.
 * `https://app.usebrian.ai`); pass "" for a relative in-app href.
 *
 * The `kind` param is omitted for a task so the common case stays short and
 * pasteable — `parseBrainDeepLink` defaults it back.
 */
export function brainRowUrl(
  origin: string,
  workspaceId: string,
  rowId: string,
  primitive: BrainPrimitive = DEFAULT_LINKED_PRIMITIVE,
): string {
  const q = new URLSearchParams({ [BRAIN_ROW_PARAM]: rowId });
  if (primitive !== DEFAULT_LINKED_PRIMITIVE) {
    q.set(BRAIN_KIND_PARAM, primitive);
  }
  return `${origin}/w/${workspaceId}/brain?${q.toString()}`;
}
