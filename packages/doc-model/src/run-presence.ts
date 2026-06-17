/**
 * Assistant-run presence — the wire contract for "an assistant is working on
 * this page right now", shared by the three surfaces that touch it:
 *
 *   - `apps/api` (`routes/chat.ts` → `DocGateway`) writes the run at the
 *     turn boundary (start / per-patch progress / end), from ANY channel — a
 *     turn carrying a `docViewId` can originate in Telegram/Slack/web with
 *     no browser open, so the run state is authored server-side, never in a tab.
 *   - `apps/doc-sync` holds the authoritative per-page run registry in
 *     memory (it is single-instance) and broadcasts it to every connected tab
 *     over the page's Yjs awareness (late-joiners get the full state for free).
 *   - `apps/app-web` reads it through `useAssistantRun(provider)` and renders
 *     the page-body status banner, the composer double-text guard, and the
 *     ambient "working" claw.
 *
 * Only the `running` shape is ever published; the *absence* of a run entry in
 * awareness means idle. `expiresAt` is a TTL safety-net: if a turn crashes
 * without sending `end`, the sync service's sweeper drops the stale run so the
 * page doesn't show "working" forever.
 *
 * This package is intentionally `@sidanclaw/core`-runtime-free (types only), so
 * the contract + the pure `deriveRunStep` helper bundle into the browser
 * without dragging server deps. The helper is unit-tested in isolation.
 *
 * [COMP:doc-model/run-presence]
 */

import type { DocOp } from './apply-ops.js'

/** Where the instruction that started the run came from. */
export type AssistantRunChannel =
  | 'doc'
  | 'web'
  | 'telegram'
  | 'slack'
  | 'mcp'
  | 'cron'
  | 'unknown'

/**
 * A coarse, client-renderable descriptor of the latest patch — enough for a
 * non-instructor watching the page to read "Writing a heading…" without the
 * instructor's full tool timeline. Kept structured (not a prose string) so the
 * label is localized in the browser via the i18n dictionary, not on the server.
 */
export type AssistantRunStep = {
  /** The dominant op kind in the latest patch. */
  op?: DocOp['op']
  /** The target block's `kind` when known (e.g. `heading`, `data`, `text`). */
  blockType?: string
  /** How many ops landed in the latest patch. */
  count?: number
}

/** The published "assistant is working on page X" state. */
export type AssistantRunState = {
  pageId: string
  /** Only ever `running`; absence of the entry = idle. */
  status: 'running'
  /** The human who instructed the assistant (drives the banner + avatar). */
  actor: { id: string; name: string; color?: string }
  channel: AssistantRunChannel
  /** Epoch ms (server clock) the run started — drives the "for Ns" caption. */
  startedAt: number
  /**
   * Epoch ms (server clock) after which the sync service treats the run as
   * dead and clears it. Refreshed on every start/progress heartbeat.
   */
  expiresAt: number
  /** The tool currently running, when known. */
  toolName?: string
  /** The latest patch's coarse step, for the page-body status line. */
  step?: AssistantRunStep
  /**
   * The block the latest op targeted, when resolvable — reserved for a future
   * block-level highlight. Not required by v1's page-level visualization.
   */
  blockId?: string
}

/** How long a run lives without a heartbeat before the sweeper clears it. */
export const ASSISTANT_RUN_TTL_MS = 90_000

/**
 * Pure: collapse a patch's `Op[]` into a coarse {@link AssistantRunStep} for
 * the page-body status line. Picks the *last* op as the "current" action (it
 * is what most recently landed in the doc) and reports its kind, the target
 * block kind when the op carries a block, and the patch size. Returns
 * `undefined` for an empty patch so callers can omit the field.
 *
 * `setTitle`/`setIcon` carry no block kind; `delete`/`move` reference a block
 * by id but not its kind, so `blockType` is omitted there.
 */
export function deriveRunStep(ops: DocOp[]): AssistantRunStep | undefined {
  if (!ops || ops.length === 0) return undefined
  const last = ops[ops.length - 1]
  const step: AssistantRunStep = { op: last.op, count: ops.length }
  if (last.op === 'add') step.blockType = last.block.kind
  else if (last.op === 'edit' && last.patch.kind) step.blockType = last.patch.kind
  return step
}

/**
 * Pure: extract the block id the latest op targets, when the op references one
 * by id (`edit`/`delete`/`move`). An `add` op's id is server-assigned, so it is
 * not known here; `setTitle`/`setIcon` target no block. Returns `undefined`
 * when no concrete block id is available.
 */
export function deriveRunBlockId(ops: DocOp[]): string | undefined {
  if (!ops || ops.length === 0) return undefined
  const last = ops[ops.length - 1]
  if (last.op === 'edit' || last.op === 'delete' || last.op === 'move') {
    return last.blockId
  }
  return undefined
}
