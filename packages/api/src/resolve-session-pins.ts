import { canRead } from '@use-brian/core'
import { query } from './db/client.js'
import { listSessionPins, PIN_INSTRUCTION_MAX_CHARS, type SessionPin } from './db/session-pins-store.js'

/**
 * Assembly-time resolution of a room's pinned context (multiplayer chat P1b,
 * T15/D10) — agentic RAG, not context stuffing.
 *
 * The pin block is an INDEX, inheriting the core architecture (memory index +
 * brain tools: hand the model a compact map, let it fetch agentically):
 *
 *   - Small primitives (task / contact / company / deal) render as compact
 *     inline cards — current state, ~tens of tokens each.
 *   - Pages / files / URLs render as TITLE + REFERENCE ONLY; the model's
 *     existing tools do deeper reads on demand, and because the pin names the
 *     exact id, retrieval is deterministic (a direct read, not an
 *     exploratory search). URLs are never fetched server-side.
 *   - `instruction` text rides verbatim (capped at ~2k chars).
 *
 * Every turn resolves FRESH under the session's `effective_clearance` and the
 * room's workspace — resolution is the gate: a pin never smuggles content
 * above the room's level, and a pin whose target is gone or above clearance
 * renders as "unavailable", never silently dropped. The whole block is
 * hard-capped (~3k tokens); over budget, the OLDEST pins degrade to
 * label-only first.
 *
 * Tool-awareness rule: the block names pinned DATA, never tool names.
 *
 * The block represents pins visible on the room surface and therefore joins
 * `<user_visible_context>` via `attachUserVisibleContext`. Private runtime
 * metadata must never share that user-role prefix.
 */

type Clearance = 'public' | 'internal' | 'confidential'

/** ~3k tokens at ~4 chars/token. */
const PIN_BLOCK_CHAR_CAP = 12_000

const UNAVAILABLE_LINE =
  '- (a pinned item is unavailable at this room’s clearance or was removed)'

type ResolvedPinLine = {
  /** The full card / reference line. */
  full: string
  /** The degrade-to form when the block is over budget (oldest first). */
  short: string
  /** Human chip label for the UI (`null` = unavailable at this clearance). */
  label: string | null
}

function fmtDate(d: Date | string | null): string | null {
  if (!d) return null
  const date = typeof d === 'string' ? new Date(d) : d
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

function readable(clearance: Clearance, sensitivity: string | null): boolean {
  if (!sensitivity) return true
  return canRead(clearance, sensitivity as Clearance)
}

async function resolvePinLine(
  pin: SessionPin,
  workspaceId: string,
  clearance: Clearance,
): Promise<ResolvedPinLine> {
  const unavailable: ResolvedPinLine = { full: UNAVAILABLE_LINE, short: UNAVAILABLE_LINE, label: null }
  try {
    switch (pin.kind) {
      case 'instruction': {
        const text = (pin.text ?? '').slice(0, PIN_INSTRUCTION_MAX_CHARS)
        return { full: `- Instruction: ${text}`, short: `- Instruction: ${text}`, label: text.slice(0, 60) }
      }
      case 'url': {
        const line = `- URL: ${pin.url ?? ''} (not fetched — read on demand)`
        return { full: line, short: line, label: pin.url ?? '' }
      }
      case 'task': {
        const r = await query<{ title: string; status: string; due: Date | null; sensitivity: string }>(
          `SELECT title, status, due, sensitivity FROM tasks
            WHERE id = $1 AND workspace_id = $2 AND retracted_at IS NULL`,
          [pin.refId, workspaceId],
        )
        const row = r.rows[0]
        if (!row || !readable(clearance, row.sensitivity)) return unavailable
        const due = fmtDate(row.due)
        return {
          full: `- Task "${row.title}" (${row.status}${due ? `, due ${due}` : ''}) [task id: ${pin.refId}]`,
          short: `- Task "${row.title}" [task id: ${pin.refId}]`,
          label: row.title,
        }
      }
      case 'contact':
      case 'company': {
        // Pins reference the CRM specialization rows (`contacts` /
        // `companies`) — the ids the CRM surface and flat-read SDK expose.
        const table = pin.kind === 'contact' ? 'contacts' : 'companies'
        const r = await query<{ name: string; sensitivity: string }>(
          `SELECT name, sensitivity FROM ${table}
            WHERE id = $1 AND workspace_id = $2 AND retracted_at IS NULL`,
          [pin.refId, workspaceId],
        )
        const row = r.rows[0]
        if (!row || !readable(clearance, row.sensitivity)) return unavailable
        const label = pin.kind === 'contact' ? 'Contact' : 'Company'
        const line = `- ${label} "${row.name}" [${pin.kind} id: ${pin.refId}]`
        return { full: line, short: line, label: row.name }
      }
      case 'deal': {
        const r = await query<{
          stage: string
          amount: string | null
          closeDate: Date | null
          sensitivity: string
          name: string | null
        }>(
          `SELECT d.stage, d.amount, d.close_date AS "closeDate", d.sensitivity,
                  e.display_name AS "name"
             FROM deals d
             LEFT JOIN entities e ON e.id = d.entity_id
            WHERE d.id = $1 AND d.workspace_id = $2 AND d.retracted_at IS NULL`,
          [pin.refId, workspaceId],
        )
        const row = r.rows[0]
        if (!row || !readable(clearance, row.sensitivity)) return unavailable
        const close = fmtDate(row.closeDate)
        const bits = [row.stage, row.amount ? `$${row.amount}` : null, close ? `close ${close}` : null]
          .filter(Boolean)
          .join(', ')
        const label = row.name ? `Deal "${row.name}"` : 'Deal'
        return {
          full: `- ${label} (${bits}) [deal id: ${pin.refId}]`,
          short: `- ${label} [deal id: ${pin.refId}]`,
          label: row.name ?? 'Deal',
        }
      }
      case 'page': {
        const r = await query<{ name: string; clearance: string }>(
          `SELECT name, clearance FROM saved_views
            WHERE id = $1 AND workspace_id = $2`,
          [pin.refId, workspaceId],
        )
        const row = r.rows[0]
        if (!row || !readable(clearance, row.clearance)) return unavailable
        // Title + reference ONLY — the body is read by id on demand (T15).
        const line = `- Page "${row.name}" [page id: ${pin.refId}] (not inlined — read by id when needed)`
        return { full: line, short: line, label: row.name }
      }
      case 'file': {
        const r = await query<{ name: string; title: string | null; sensitivity: string }>(
          `SELECT name, title, sensitivity FROM workspace_files
            WHERE id = $1 AND workspace_id = $2 AND retracted_at IS NULL`,
          [pin.refId, workspaceId],
        )
        const row = r.rows[0]
        if (!row || !readable(clearance, row.sensitivity)) return unavailable
        const line = `- File "${row.title ?? row.name}" [file id: ${pin.refId}] (not inlined — read by id when needed)`
        return { full: line, short: line, label: row.title ?? row.name }
      }
      default:
        return unavailable
    }
  } catch {
    return unavailable
  }
}

/**
 * Build the room's `# Pinned context` user-visible block, or `null` when the
 * session has no pins. Best-effort: any single pin's resolution failure
 * degrades to the "unavailable" line, never the whole block.
 */
export async function buildPinnedContextBlock(params: {
  sessionId: string
  workspaceId: string
  /** The session's `effective_clearance` — the resolution ceiling. */
  clearance: string | null
}): Promise<string | null> {
  const pins = await listSessionPins(params.sessionId)
  if (pins.length === 0) return null
  const clearance: Clearance =
    params.clearance === 'public' || params.clearance === 'confidential'
      ? params.clearance
      : 'internal'

  const resolved = await Promise.all(
    pins.map((pin) => resolvePinLine(pin, params.workspaceId, clearance)),
  )

  const header = [
    '# Pinned context',
    'The team pinned these as this conversation’s working frame. Work inside it.',
    'Inline cards show current state. Pages, files and URLs are references — read them by their id when the conversation needs their contents; never assume what is inside them.',
  ].join('\n')

  // Budget: degrade OLDEST pins to their short form first; if still over,
  // drop oldest lines behind one omission note.
  const lines = resolved.map((r) => r.full)
  const total = () => header.length + lines.reduce((n, l) => n + l.length + 1, 0)
  for (let i = 0; i < lines.length && total() > PIN_BLOCK_CHAR_CAP; i++) {
    lines[i] = resolved[i].short
  }
  let omitted = 0
  while (lines.length > 1 && total() > PIN_BLOCK_CHAR_CAP) {
    lines.shift()
    omitted++
  }
  if (omitted > 0) lines.unshift(`- (${omitted} older pin(s) omitted for space)`)

  return `${header}\n${lines.join('\n')}`
}

/**
 * Chip labels for the pins UI (`GET /:id/pins`), resolved under the SAME
 * session-clearance ceiling as assembly (the gate already guarantees every
 * reader's clearance >= the session's, so these labels leak nothing).
 * `null` = unavailable (missing / above clearance) — the chip renders its
 * unavailable state rather than disappearing.
 */
export async function resolveSessionPinLabels(
  pins: SessionPin[],
  workspaceId: string,
  clearance: string | null,
): Promise<Map<string, string | null>> {
  const ceiling: Clearance =
    clearance === 'public' || clearance === 'confidential' ? clearance : 'internal'
  const entries = await Promise.all(
    pins.map(async (pin) => {
      const line = await resolvePinLine(pin, workspaceId, ceiling)
      return [pin.id, line.label] as const
    }),
  )
  return new Map(entries)
}
