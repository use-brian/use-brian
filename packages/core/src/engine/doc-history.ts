/**
 * Doc tool-result elision — an across-turn context-window control for the
 * doc authoring surface.
 *
 * Doc page-state tools (`patchPage`, `getCurrentPage`, `renderPage`,
 * `getBlock`, `queryDataBlock`) return page snapshots in their `tool_result`.
 * Since the 2026-06-05 delta-return change a `patchPage` SUCCESS carries only
 * the blocks it touched (small), but two large bodies remain: a `getCurrentPage`
 * full-page dump (`fields:'full'`) and the FULL-outline body an `invalid_ops`
 * rejection returns so the model can re-anchor. Because the chat route reloads
 * the whole session history on every turn (`getSessionMessages` → `queryLoop`),
 * those bodies pile up and re-send on every subsequent turn — the dominant
 * residual token ballast (see `docs/architecture/features/doc.md` →
 * "Token cost", `docs/plans/doc-turn-context-optimization.md`).
 *
 * The key observation that makes elision lossless: the **current** page state is
 * re-delivered fresh every turn (the "Active doc page" block, attached to the
 * newest user message via the turn-context envelope in
 * `packages/api/src/routes/chat.ts`). So a *stale* snapshot sitting in
 * history carries no signal the model can't get from the live injection — it is
 * pure exhaust. We keep the most-recent `keepRecent` page-state results verbatim
 * (so the model can still re-anchor off the last one — including the most-recent
 * `invalid_ops` outline) and collapse every older one to a short stub.
 *
 * **Error results are elided too** (changed 2026-06-05). They used to be exempt
 * on the theory that they're small and carry retry signal — but the
 * `invalid_ops` body is in fact a FULL outline, so exempting it let the biggest
 * single body leak into history permanently. Keeping the most-recent `keepRecent`
 * verbatim preserves the re-anchor signal for the immediate retry while stubbing
 * every superseded one.
 *
 * **Signature-safety.** This transform only rewrites `tool_result` blocks, which
 * live in *user*-role messages and are never signed. It never touches a
 * `tool_use` block, so Gemini's `thoughtSignature` requirement (the reason
 * `stripUnsignedToolUses` exists) is unaffected. Pairing is preserved because
 * the `toolUseId` / `name` / `isError` fields are kept intact — only `content`
 * shrinks.
 *
 * Idempotent and a no-op on non-doc histories (no doc page-state results →
 * early return), so it is safe to run on every request as defence-in-depth,
 * exactly like `ensureToolResultPairing` / `stripUnsignedToolUses`.
 *
 * See `docs/architecture/engine/query-loop.md` → "Doc tool-result elision".
 */

import type { ContentBlock, Message } from '../providers/types.js'

/**
 * Doc page-state tools whose results carry page snapshots — a `patchPage`
 * success delta, a `getCurrentPage` page/outline, a `renderPage` / `getBlock` /
 * `queryDataBlock` payload, or an `invalid_ops` re-anchor outline. ALL of them
 * (error results included — the `invalid_ops` body is a full outline) are
 * subject to keep-recent elision.
 */
export const DOC_PAGE_STATE_TOOLS: ReadonlySet<string> = new Set([
  'patchPage',
  'getCurrentPage',
  'renderPage',
  'getBlock',
  'queryDataBlock',
  'getSection',
  'getBlockRange',
])

/**
 * How many of the most-recent doc page-state results to keep verbatim.
 * One is enough: the current page outline is re-injected fresh into the system
 * prompt every turn, so a single surviving result (the last patch delta, or the
 * last `invalid_ops` outline for an immediate re-anchor) is all the model needs
 * from history. Lowered 2 → 1 on 2026-06-05 alongside the delta-return change.
 */
export const KEEP_RECENT_DOC_RESULTS = 1

/** Stub body that replaces an elided doc page-state `tool_result`. */
export const ELIDED_DOC_RESULT_PLACEHOLDER =
  '[Earlier doc page state elided to save context. The current page outline is delivered fresh in your context every turn; call getCurrentPage to refetch full block content if you need it.]'

function isElidableDocResult(block: ContentBlock): boolean {
  // Error results are elidable too (the `invalid_ops` body carries a full
  // outline) — the keep-recent window preserves the most-recent one's
  // re-anchor signal; only superseded snapshots are stubbed.
  return (
    block.type === 'tool_result' &&
    DOC_PAGE_STATE_TOOLS.has(block.name) &&
    block.content !== ELIDED_DOC_RESULT_PLACEHOLDER
  )
}

/**
 * Collapse all but the most-recent `keepRecent` doc page-state `tool_result`
 * bodies to a compact stub. Returns the input array unchanged (same reference)
 * when there is nothing to elide.
 *
 * Operates on a shallow copy; messages whose content actually changes are
 * cloned, the rest are passed through by reference.
 */
export function elideStaleDocToolResults(
  messages: Message[],
  keepRecent: number = KEEP_RECENT_DOC_RESULTS,
): Message[] {
  // First pass: locate every elidable doc page-state result by position, in
  // conversation order, so we know which ones fall outside the keep-recent
  // window. We match on the `tool_result` block's own `name` (guaranteed
  // present by the provider ContentBlock type and by the read-time pairing
  // pass that runs before this transform).
  const positions: Array<{ msgIdx: number; blockIdx: number }> = []
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const content = messages[msgIdx].content
    if (messages[msgIdx].role !== 'user' || typeof content === 'string') continue
    for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
      if (isElidableDocResult(content[blockIdx])) {
        positions.push({ msgIdx, blockIdx })
      }
    }
  }

  if (positions.length <= keepRecent) return messages

  // Keep the trailing `keepRecent`; stub the rest.
  const elideKeys = new Set(
    positions
      .slice(0, positions.length - keepRecent)
      .map((p) => `${p.msgIdx}:${p.blockIdx}`),
  )

  return messages.map((msg, msgIdx) => {
    if (msg.role !== 'user' || typeof msg.content === 'string') return msg
    let changed = false
    const content = msg.content.map((block, blockIdx) => {
      if (block.type === 'tool_result' && elideKeys.has(`${msgIdx}:${blockIdx}`)) {
        changed = true
        return { ...block, content: ELIDED_DOC_RESULT_PLACEHOLDER }
      }
      return block
    })
    return changed ? { ...msg, content } : msg
  })
}
