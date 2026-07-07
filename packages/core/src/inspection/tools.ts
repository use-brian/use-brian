/**
 * Inspection toolkit — read-only introspection tools exposed to the
 * workspace's primary assistant during a Brain inbox "Ask about this"
 * deliberation. Coexists with the preamble-seeded first message: the
 * preamble gives the model the row body up-front; these tools let it
 * fetch additional context (source-session messages, recall history,
 * provenance walks, recent activity, recent corrections) if the user
 * asks follow-ups.
 *
 * All tools are `isReadOnly: true` and `isConcurrencySafe: true`. The
 * route layer wires them ONLY into sessions with
 * `channel_type='brain_inspection'`; they never leak into normal chat.
 *
 * Spec: docs/architecture/brain/corrections.md.
 *
 * [COMP:inspection/tools]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { InspectionStore } from './types.js'

export function createInspectionTools(store: InspectionStore): {
  inspectMemoryProvenance: Tool
  inspectRecallHistory: Tool
  inspectRowProvenance: Tool
  inspectMyActivity: Tool
  inspectMyMistakes: Tool
} {
  const inspectMemoryProvenance = buildTool({
    name: 'inspectMemoryProvenance',
    description:
      'Fetch the chat-session context around when a memory was saved. ' +
      'Returns the saving assistant name, the originating session id, ' +
      'and ~6 surrounding messages so you can see what was being ' +
      'discussed when the save happened. Use this when the user asks ' +
      '"why was this saved?" or "what was the conversation?". ' +
      'For the row\'s source episode and version history rather than the chat around it, use `inspectRowProvenance`.',
    inputSchema: z.object({
      memoryId: z
        .string()
        .describe('The memory row id (full UUID, or the 8-char prefix the inbox displays).'),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'Inspection tools require workspace context.', isError: true }
      }
      const result = await store.getMemoryProvenance({
        assistantId: context.assistantId,
        workspaceId: context.workspaceId,
        memoryId: input.memoryId,
      })
      if (!result) {
        return { data: `No provenance found for memory ${input.memoryId}.` }
      }
      const messageLines = result.messages.map((m) => {
        const text = renderContent(m.content)
        return `[${m.role} ${m.createdAt.toISOString()}] ${text.slice(0, 280)}`
      })
      const lines = [
        `Saved at: ${result.savedAt.toISOString()}`,
        `Saving assistant: ${result.savingAssistantName ?? '(unknown)'}`,
        result.sourceSessionId
          ? `Source session: ${result.sourceSessionId}`
          : 'Source session: (none captured)',
        '',
        'Surrounding messages:',
        ...(messageLines.length > 0 ? messageLines : ['(none — no source session messages)']),
      ]
      return { data: lines.join('\n') }
    },
  })

  const inspectRecallHistory = buildTool({
    name: 'inspectRecallHistory',
    description:
      'Show how often a brain row was recalled in recent turns and ' +
      'whether downstream user feedback was positive, negative, or a ' +
      'correction. Useful for spotting memories that consistently land ' +
      "in low-rated responses (they're surface candidates for retraction).",
    inputSchema: z.object({
      rowId: z.string().describe('The brain row id (memory, entity, edge, task, etc.).'),
      primitive: z.string().optional().describe('Optional primitive name to narrow the lookup.'),
      limit: z.number().optional().describe('Max events to return (default 10).'),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'Inspection tools require workspace context.', isError: true }
      }
      const events = await store.getRecallHistory({
        workspaceId: context.workspaceId,
        rowId: input.rowId,
        primitive: input.primitive,
        limit: input.limit ?? 10,
      })
      if (events.length === 0) {
        return { data: 'No recall events recorded for this row.' }
      }
      const lines = events.map(
        (e) =>
          `${e.recalledAt.toISOString()} · ${e.recallKind} · outcome: ${e.outcome ?? 'unrated'}`,
      )
      return { data: lines.join('\n') }
    },
  })

  const inspectRowProvenance = buildTool({
    name: 'inspectRowProvenance',
    description:
      'Walk the provenance chain for any brain row — entity / edge / ' +
      'task / contact / company / deal / file / memory. Returns the ' +
      'source episode (where the row was derived from) and a shallow ' +
      'supersession history. ' +
      'Use this for a deep audit walk over any row kind. For the chat conversation around when a memory was saved use `inspectMemoryProvenance`.',
    inputSchema: z.object({
      primitive: z
        .enum(['memory', 'entity', 'entity_link', 'task', 'contact', 'company', 'deal', 'workspace_file'])
        .describe('Primitive kind.'),
      rowId: z.string().describe('Row id (full UUID).'),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'Inspection tools require workspace context.', isError: true }
      }
      const walk = await store.getRowProvenance({
        workspaceId: context.workspaceId,
        primitive: input.primitive,
        rowId: input.rowId,
      })
      if (!walk) {
        return { data: `No provenance found for ${input.primitive} ${input.rowId}.` }
      }
      const lines = [
        walk.sourceEpisodeId
          ? `Source episode: ${walk.sourceEpisodeId}`
          : 'Source episode: (none — manual save)',
        walk.origin ? `Origin: ${walk.origin}` : '',
        '',
        'Version history (newest first):',
        ...(walk.history.length > 0
          ? walk.history.map(
              (v) =>
                `· ${v.id} valid ${v.validFrom.toISOString()} → ${v.validTo?.toISOString() ?? 'present'}${
                  v.reason ? ` (${v.reason})` : ''
                }`,
            )
          : ['· (no prior versions — this is the first write)']),
      ]
      return { data: lines.filter(Boolean).join('\n') }
    },
  })

  const inspectMyActivity = buildTool({
    name: 'inspectMyActivity',
    description:
      'Read recent activity from analytics_events — tool calls, ' +
      'errors, recent turns. Default scope is YOUR own activity; pass ' +
      '`workspaceWide: true` to see every assistant in the workspace ' +
      '(useful for primary assistants answering "what happened across ' +
      'the workspace today?"). Use this to answer "what have you been ' +
      'doing?" or to diagnose why you / another assistant took a ' +
      'specific action.',
    inputSchema: z.object({
      sinceMinutes: z.number().optional().describe('Lookback window in minutes (default 60).'),
      limit: z.number().optional().describe('Max events to return (default 20).'),
      workspaceWide: z
        .boolean()
        .optional()
        .describe(
          'Set true to include every assistant in the workspace. ' +
            'Default false = your own activity only.',
        ),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'Inspection tools require workspace context.', isError: true }
      }
      const events = await store.getRecentActivity({
        assistantId: context.assistantId,
        workspaceId: context.workspaceId,
        sinceMinutes: input.sinceMinutes ?? 60,
        limit: input.limit ?? 20,
        workspaceWide: input.workspaceWide,
      })
      if (events.length === 0) {
        return { data: 'No recorded activity in this window.' }
      }
      const lines = events.map((e) => `${e.occurredAt.toISOString()} · ${e.eventName} · ${e.summary}`)
      return { data: lines.join('\n') }
    },
  })

  const inspectMyMistakes = buildTool({
    name: 'inspectMyMistakes',
    description:
      'Read recent user corrections + retractions. Default scope is ' +
      'rows YOU authored; pass `workspaceWide: true` to include every ' +
      'assistant in the workspace. Use this to answer "what have you ' +
      'been getting wrong?" or — workspace-wide — "what does the user ' +
      'tend to correct, so I can avoid similar mistakes?".',
    inputSchema: z.object({
      sinceDays: z.number().optional().describe('Lookback window in days (default 14).'),
      limit: z.number().optional().describe('Max events to return (default 20).'),
      workspaceWide: z
        .boolean()
        .optional()
        .describe(
          'Set true to include corrections to every assistant in the ' +
            "workspace. Default false = your own rows only.",
        ),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'Inspection tools require workspace context.', isError: true }
      }
      const events = await store.getRecentMistakes({
        assistantId: context.assistantId,
        workspaceId: context.workspaceId,
        sinceDays: input.sinceDays ?? 14,
        limit: input.limit ?? 20,
        workspaceWide: input.workspaceWide,
      })
      if (events.length === 0) {
        return { data: 'No recorded mistakes / corrections in this window.' }
      }
      const lines = events.map(
        (e) =>
          `${e.at.toISOString()} · ${e.action} · ${e.primitive}:${e.rowId.slice(0, 8)}${
            e.reason ? ` — "${e.reason.slice(0, 120)}"` : ''
          }`,
      )
      return { data: lines.join('\n') }
    },
  })

  return {
    inspectMemoryProvenance,
    inspectRecallHistory,
    inspectRowProvenance,
    inspectMyActivity,
    inspectMyMistakes,
  }
}

/** Best-effort textual rendering of a `session_messages.content` JSONB. */
function renderContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .map((c) => {
        if (typeof c === 'string') return c
        if (
          c &&
          typeof c === 'object' &&
          'text' in c &&
          typeof (c as { text?: unknown }).text === 'string'
        ) {
          return (c as { text: string }).text
        }
        return null
      })
      .filter((s): s is string => s !== null)
    if (parts.length > 0) return parts.join('\n')
  }
  try {
    return JSON.stringify(content).slice(0, 400)
  } catch {
    return '(unrenderable content)'
  }
}
