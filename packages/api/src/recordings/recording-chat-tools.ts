// [COMP:recordings/recording-chat-tools] — the recording surface for CHAT.
//
// Two tools, two axes, and neither is redundant:
//
//   listRecordings   — TEMPORAL / nominal: "Tuesday's call", "last week's
//                      meetings with Acme". Semantic search structurally cannot
//                      answer this; no embedding of a transcript encodes "this
//                      is the one from Tuesday".
//   searchRecording  — PRECISION inside one recording: what was said, by whom,
//                      and exactly WHEN (`start_ms`), so the model can cite the
//                      moment and the UI can turn that citation into a seek link.
//
// Together they compose "what did Priya say about pricing on Tuesday's call?"
// with no orchestration tool: listRecordings resolves the meeting,
// searchRecording drills into it. The third path — unscoped `searchBrain`
// surfacing transcript_segment hits (migration 280 + the KNOWN_SCOPES entry) —
// covers the case where the user does not know which meeting they want.
//
// WHY A SECOND searchRecording. `recordings/recording-search-tool.ts` binds
// `recordingId` in the CLOSURE — deliberately, so the synthesis loop cannot
// pivot off the recording it was told to summarize. That is exactly wrong for
// chat, where choosing the recording IS the job. This one takes `recordingId` as
// a model input, mirroring the external brain-MCP BrainTool, and rebuilds the
// actor from the ToolContext per call so read ceilings hold on every path.

import { z } from 'zod'
import { buildTool, actorFromContext, type Embedder, type Tool } from '@use-brian/core'
import {
  searchRecording as searchRecordingFn,
  readRecordingRange,
  type RecordingSegmentHit,
} from '../db/retrieval-store.js'
import {
  listRecordings,
  LIST_RECORDINGS_LIMIT_DEFAULT,
  LIST_RECORDINGS_LIMIT_MAX,
  type ListRecordingsFilters,
} from '../db/recordings-store.js'

/** Sequential paging defaults to a 10-segment window when only `fromIndex` is given. */
const RANGE_WINDOW = 9

const searchInputSchema = z.object({
  recordingId: z
    .string()
    .uuid()
    .describe('The recording to read. Get it from listRecordings or a transcript search hit.'),
  query: z.string().default('').describe('What to look for in this recording, in natural language.'),
  topK: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('How many segments to return (default 8, max 20). Ignored when paging with fromIndex.'),
  fromIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Sequential paging: first segment index to read (use instead of query for an overview).'),
  toIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Sequential paging: last segment index to read (defaults to fromIndex + 9).'),
})

/**
 * `searchRecording` for chat — `recordingId` is a model INPUT (unlike the
 * synthesis-loop twin, which pins it in the closure). Read-only and
 * concurrency-safe; the 30s timeout matches searchFileContent's budget.
 */
export function createChatSearchRecordingTool(deps: { embedder?: Pick<Embedder, 'embed'> } = {}): Tool {
  const { embedder } = deps
  return buildTool({
    name: 'searchRecording',
    description:
      'Retrieve passages from ONE transcribed recording, scoped to that recording only — never the whole ' +
      'company brain. Pass the `recordingId` (from listRecordings, or from a transcript hit in a brain ' +
      'search) plus a `query`; returns the most relevant segments, each with a `start_ms` timestamp and ' +
      '`speaker`, so you can cite the exact moment ("around 47:12, Priya said ..."). For an overview that ' +
      'spans many segments, page sequential windows with `fromIndex`/`toIndex` instead of relying on top-K. ' +
      'Never returns the whole transcript at once.',
    inputSchema: searchInputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    timeoutMs: 30_000,
    async execute(input, context) {
      // Rebuilt per call, so the read ceiling holds on chat, the callee
      // executor, and workflows alike.
      const actor = actorFromContext(context)
      if ('error' in actor) return { data: actor.error, isError: true }
      try {
        let hits: RecordingSegmentHit[]
        if (typeof input.fromIndex === 'number') {
          const from = input.fromIndex
          const to = typeof input.toIndex === 'number' ? input.toIndex : from + RANGE_WINDOW
          hits = await readRecordingRange(actor, {
            recordingId: input.recordingId,
            fromIndex: from,
            toIndex: to,
          })
        } else {
          hits = await searchRecordingFn(
            actor,
            { recordingId: input.recordingId, query: input.query ?? '', topK: input.topK },
            embedder ? { embedder } : undefined,
          )
        }
        return { data: hits }
      } catch (err) {
        return {
          data: `searchRecording failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })
}

const listInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Match against the recording title / uploaded file name. Omit to list everything.'),
  kind: z
    .enum(['memo', 'meeting'])
    .optional()
    .describe('Narrow to voice memos or meetings.'),
  since: z
    .string()
    .optional()
    .describe('ISO 8601 date/time — only recordings made at or after this moment.'),
  until: z
    .string()
    .optional()
    .describe('ISO 8601 date/time — only recordings made before this moment.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIST_RECORDINGS_LIMIT_MAX)
    .optional()
    .describe(`How many to return (default ${LIST_RECORDINGS_LIMIT_DEFAULT}, max ${LIST_RECORDINGS_LIMIT_MAX}).`),
})

/** Reject a garbage date rather than silently listing everything. */
function parseDate(v: string | undefined, label: string): Date | undefined | { error: string } {
  if (v === undefined) return undefined
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return { error: `listRecordings: \`${label}\` is not a valid date: ${v}` }
  return d
}

/**
 * `listRecordings` — the temporal/nominal lookup. Newest-first; rides
 * `idx_recordings_ws_created`. Returns metadata only (never transcript text):
 * the model picks a recording, then drills with `searchRecording`.
 */
export function createListRecordingsTool(): Tool {
  return buildTool({
    name: 'listRecordings',
    description:
      "Find the user's recordings by WHEN they happened or what they are called — the way to resolve " +
      '"Tuesday\'s call", "my last meeting with Acme", or "the memos from last week". Returns metadata ' +
      'only (id, title, kind, when, duration, status), newest first — not transcript text. Use the ' +
      "returned `recordingId` with `searchRecording` to read what was actually said. If you don't know " +
      'which recording is relevant, search the brain instead and look for transcript hits.',
    inputSchema: listInputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    timeoutMs: 30_000,
    async execute(input, context) {
      const actor = actorFromContext(context)
      if ('error' in actor) return { data: actor.error, isError: true }

      const since = parseDate(input.since, 'since')
      if (since && 'error' in since) return { data: since.error, isError: true }
      const until = parseDate(input.until, 'until')
      if (until && 'error' in until) return { data: until.error, isError: true }

      try {
        const filters: ListRecordingsFilters = {
          ...(input.kind ? { kind: input.kind } : {}),
          ...(since ? { since: since as Date } : {}),
          ...(until ? { until: until as Date } : {}),
          ...(input.query?.trim() ? { q: input.query.trim() } : {}),
        }
        const rows = await listRecordings(
          actor.userId,
          actor.workspaceId,
          filters,
          input.limit ? { limit: input.limit } : {},
        )
        // Project deliberately: gcs_key / storage_uri are infrastructure, not
        // something to hand a model.
        return {
          data: rows.map((r) => ({
            recordingId: r.id,
            title: r.title ?? r.fileName,
            kind: r.kind,
            status: r.status,
            occurredAt: r.createdAt,
            durationMs: r.durationMs,
            truncated: r.truncated,
            hasTranscript: r.transcriptFileId != null,
          })),
        }
      } catch (err) {
        return {
          data: `listRecordings failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })
}
