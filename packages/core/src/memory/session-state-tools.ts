import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { SessionStateStore } from './session-state-types.js'

/**
 * Analytics callback for the two session-state write tools.
 * Caller wires these into the analytics logger in the chat route.
 */
export type SessionStateToolEvent =
  | { type: 'session_state_upsert'; source: 'tool'; key: string; wasInsert: boolean }
  | { type: 'session_state_resolve'; source: 'tool'; key: string; hit: boolean }

export type CreateSessionStateToolsOptions = {
  onEvent?: (event: SessionStateToolEvent) => void
}

/**
 * Create the two commitment-tracking tools backed by a `SessionStateStore`.
 *
 * Both tools write with `source='tool'`. The post-turn diff pass writes with
 * `source='diff-pass'` and lives in `session-state-diff.ts`.
 *
 * See `docs/architecture/context-engine/session-state.md`.
 */
export function createSessionStateTools(
  store: SessionStateStore,
  opts?: CreateSessionStateToolsOptions,
): { trackCommitment: Tool; resolveCommitment: Tool } {
  const trackCommitment = buildTool({
    name: 'trackCommitment',
    description:
      'Track a multi-turn commitment the user is relying on you to remember across this session — e.g. medicine nags, in-progress trip decisions, an answer they asked you to wait for, a promise to follow up later. Use a stable, structured key like `pill:2026-04-22` or `trip:seoul-itinerary` so you can resolve the same commitment later. Overwrites summary/detail if the same key already exists. Complements `saveMemory` (cross-session durable facts) and `trackScheduledJob` (cron). Call `resolveCommitment` with the same key when the user confirms completion or cancels.',
    inputSchema: z.object({
      key: z
        .string()
        .min(1)
        .max(200)
        .describe(
          'Stable commitment id. Prefer `kind:identifier` shape, e.g. `pill:2026-04-22`, `trip:seoul-itinerary`, `followup:api-quota-reply`.',
        ),
      summary: z
        .string()
        .min(1)
        .max(400)
        .describe('One-line human-readable summary shown in the # Open commitments prompt block.'),
      detail: z
        .string()
        .max(8000)
        .optional()
        .describe(
          'The authoritative body of the commitment. For evolving state — itineraries, multi-step plans, in-progress to-do lists — store the full current state here and overwrite it each call with the complete updated version (never deltas or just what changed). This is the content you will read back on later turns via the `# Open commitments` block. Can be long-form; up to 8000 chars.',
        ),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      const existing = await store
        .listOpenBySession(context.sessionId)
        .catch(() => [] as Awaited<ReturnType<typeof store.listOpenBySession>>)
      const wasInsert = !existing.some((r) => r.key === input.key)

      const row = await store.upsert({
        sessionId: context.sessionId,
        userId: context.userId,
        assistantId: context.assistantId,
        key: input.key,
        summary: input.summary,
        detail: input.detail ?? null,
        source: 'tool',
      })

      opts?.onEvent?.({
        type: 'session_state_upsert',
        source: 'tool',
        key: row.key,
        wasInsert,
      })

      return {
        data: wasInsert
          ? `Tracked commitment [${row.key}]: ${row.summary}`
          : `Updated commitment [${row.key}]: ${row.summary}`,
      }
    },
  })

  const resolveCommitment = buildTool({
    name: 'resolveCommitment',
    description:
      'Mark a previously tracked commitment as resolved. Call this the moment the user confirms completion ("done", "took it", "finished") or cancels. Use the EXACT key you used with `trackCommitment` (or the key listed in the `# Open commitments` prompt block). Returns an informational no-op if no matching key exists — that means the commitment was never tracked or already resolved.',
    inputSchema: z.object({
      key: z
        .string()
        .min(1)
        .max(200)
        .describe('Commitment id — must match exactly a key previously set via `trackCommitment`.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      const row = await store.resolve({
        sessionId: context.sessionId,
        key: input.key,
        source: 'tool',
      })

      if (!row) {
        opts?.onEvent?.({
          type: 'session_state_resolve',
          source: 'tool',
          key: input.key,
          hit: false,
        })
        return {
          data: `No open commitment with key "${input.key}" in this session.`,
        }
      }

      opts?.onEvent?.({
        type: 'session_state_resolve',
        source: 'tool',
        key: row.key,
        hit: true,
      })
      return { data: `Resolved commitment [${row.key}]: ${row.summary}` }
    },
  })

  return { trackCommitment, resolveCommitment }
}
