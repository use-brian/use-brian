// [COMP:recordings/recording-chat-tools] — the recording surface for CHAT.
//
// Three tools, each owning a distinct recording operation:
//
//   listRecordings   — TEMPORAL / nominal: "Tuesday's call", "last week's
//                      meetings with Acme". Semantic search structurally cannot
//                      answer this; no embedding of a transcript encodes "this
//                      is the one from Tuesday".
//   searchRecording  — PRECISION inside one recording: what was said, by whom,
//                      and exactly WHEN (`start_ms`), so the model can cite the
//                      moment and the UI can turn that citation into a seek link.
//   assignRecordingSpeakers — canonical participant metadata: bind stable
//                      diarization labels to the authenticated member or a
//                      visible same-workspace CRM contact.
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
import {
  buildTool,
  actorFromContext,
  type AccessContext,
  type CrmStore,
  type Embedder,
  type Tool,
  scopeEvidenceFromRows,
} from '@use-brian/core'
import {
  listRecordingSpeakerLabels,
  searchRecording as searchRecordingFn,
  readRecordingRange,
  type RecordingSegmentHit,
} from '../db/retrieval-store.js'
import {
  getRecording,
  listRecordings,
  LIST_RECORDINGS_LIMIT_DEFAULT,
  LIST_RECORDINGS_LIMIT_MAX,
  type ListRecordingsFilters,
  type RecordingParticipant,
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
          actor,
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
          scopeEvidence: scopeEvidenceFromRows(rows),
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

const speakerAssignmentSchema = z
  .object({
    speaker: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .describe('Stable diarization label shown in the transcript, e.g. "Speaker 4". Spacing/case variants such as "speaker4" are accepted.'),
    contactId: z
      .string()
      .uuid()
      .optional()
      .describe('Visible CRM contact id from listContacts/saveContact. Required for an external participant.'),
    isSelf: z
      .boolean()
      .optional()
      .describe('True only when this speaker is the authenticated person currently talking to you. Do not use for another teammate.'),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.contactId) === (value.isSelf === true)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Each speaker needs exactly one identity: contactId for an external person, or isSelf: true for the authenticated user.',
      })
    }
  })

const assignSpeakersInputSchema = z.object({
  recordingId: z
    .string()
    .uuid()
    .optional()
    .describe('Recording id. Omit on a page whose player/transcript is currently open; that page is the target.'),
  assignments: z
    .array(speakerAssignmentSchema)
    .min(1)
    .max(64)
    .describe('Speaker identities explicitly asserted by the user or unambiguously self-identified in the transcript.'),
})

export type AssignRecordingSpeakersDeps = {
  resolvePageRecording: (
    actorUserId: string,
    pageId: string,
  ) => Promise<{ recordingId: string; workspaceId: string } | null>
  getRecording?: typeof getRecording
  listSpeakerLabels?: typeof listRecordingSpeakerLabels
  getContact: CrmStore['getContactById']
  getSelf: (userId: string) => Promise<{ name: string | null; email: string | null } | null>
  updateParticipants: (
    recordingId: string,
    participants: RecordingParticipant[],
  ) => Promise<void>
}

/** Case/spacing normalization only; identity words themselves stay exact. */
export function recordingSpeakerKey(label: string): string {
  return label.normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s_:-]+/g, '')
}

/** Merge asserted speakers without clobbering unrelated participant bindings. */
export function mergeRecordingParticipants(
  existing: RecordingParticipant[],
  assigned: RecordingParticipant[],
): RecordingParticipant[] {
  const replacements = new Map(assigned.map((row) => [recordingSpeakerKey(row.speaker), row]))
  const merged: RecordingParticipant[] = []
  for (const row of existing) {
    const key = recordingSpeakerKey(row.speaker)
    merged.push(replacements.get(key) ?? row)
    replacements.delete(key)
  }
  merged.push(...replacements.values())
  return merged
}

/**
 * Canonical chat mutation for transcript speaker assertions. The doc page is
 * only a targeting anchor; this writes recording metadata, never page prose.
 */
export function createAssignRecordingSpeakersTool(deps: AssignRecordingSpeakersDeps): Tool {
  return buildTool({
    name: 'assignRecordingSpeakers',
    requiresCapability: 'crm',
    description:
      'Bind diarized labels in a recording transcript to real people. Use this when the user says things like ' +
      '`speaker4: Holly`, corrects a speaker name, or the transcript unambiguously contains a self-introduction. ' +
      'On a page with a visible recording player/transcript, omit recordingId: the active page is the target. ' +
      'This changes recording participant metadata, NOT meeting-note prose; never use delegateDocEdit as a substitute. ' +
      'For every external person, call listContacts first and use the unique matching id; if none exists, call saveContact, ' +
      'then pass its returned id. If several contacts match, ask the user instead of guessing. For the authenticated user ' +
      'who says "myself", pass isSelf: true. Only assign identities the user asserted or the transcript states unambiguously.',
    inputSchema: assignSpeakersInputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    async execute(input, context) {
      const actor = actorFromContext(context)
      if ('error' in actor) return { data: actor.error, isError: true }

      let recordingId = input.recordingId
      let pageId: string | null = null
      if (!recordingId) {
        pageId = context.docViewId ?? null
        if (!pageId) {
          return {
            data: 'No recording target is active. Call listRecordings to resolve the recording, then retry with its recordingId.',
            isError: true,
          }
        }
        const pageTarget = await deps.resolvePageRecording(context.userId, pageId)
        if (!pageTarget) {
          return {
            data: `The active page \`${pageId}\` has no visible linked recording. Nothing was changed. Use listRecordings and pass an explicit recordingId if the user meant another recording.`,
            isError: true,
          }
        }
        if (pageTarget.workspaceId !== actor.workspaceId) {
          return {
            data: 'The active page recording belongs to a different workspace. Nothing was changed.',
            isError: true,
          }
        }
        recordingId = pageTarget.recordingId
      }

      const recording = await (deps.getRecording ?? getRecording)(context.userId, recordingId)
      if (!recording || recording.workspaceId !== actor.workspaceId) {
        return {
          data: `Recording \`${recordingId}\` is not visible in this workspace. Nothing was changed.`,
          isError: true,
        }
      }

      const knownLabels = await (deps.listSpeakerLabels ?? listRecordingSpeakerLabels)(actor, recordingId)
      const labelsByKey = new Map(knownLabels.map((label) => [recordingSpeakerKey(label), label]))
      const resolvedLabels = input.assignments.map((assignment) => ({
        assignment,
        label: labelsByKey.get(recordingSpeakerKey(assignment.speaker)),
      }))
      const missing = resolvedLabels.filter((row) => !row.label).map((row) => row.assignment.speaker)
      if (missing.length > 0) {
        return {
          data:
            `These speaker labels do not occur in the visible transcript: ${missing.map((label) => `\`${label}\``).join(', ')}. ` +
            `Known labels: ${knownLabels.length > 0 ? knownLabels.map((label) => `\`${label}\``).join(', ') : '(none)'}. ` +
            'Nothing was changed; correct the labels rather than retrying the same input.',
          isError: true,
        }
      }
      const duplicate = resolvedLabels.find(
        (row, index) => resolvedLabels.findIndex((candidate) => candidate.label === row.label) !== index,
      )
      if (duplicate?.label) {
        return {
          data: `Speaker \`${duplicate.label}\` appears more than once in this assignment. Nothing was changed.`,
          isError: true,
        }
      }

      const access: AccessContext = {
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        assistantId: actor.assistantId,
        assistantKind: actor.assistantKind,
        clearance: actor.clearance,
        compartments: actor.compartments,
      }
      const assigned: RecordingParticipant[] = []
      for (const { assignment, label } of resolvedLabels) {
        if (!label) continue
        if (assignment.isSelf === true) {
          const self = await deps.getSelf(context.userId)
          const name = self?.name?.trim() || self?.email?.trim()
          if (!name) {
            return {
              data: 'Your account has no display name or email, so `isSelf` cannot produce an honest transcript name. Nothing was changed; ask the user what name to display.',
              isError: true,
            }
          }
          assigned.push({ speaker: label, name, ...(self?.email ? { email: self.email } : {}) })
          continue
        }
        const contact = await deps.getContact(access, assignment.contactId!)
        if (!contact || contact.workspaceId !== actor.workspaceId) {
          return {
            data:
              `Contact \`${assignment.contactId}\` is not visible in this workspace. Nothing was changed. ` +
              'Call listContacts to resolve the current id; do not retry this id.',
            isError: true,
          }
        }
        assigned.push({
          speaker: label,
          name: contact.name,
          contactId: contact.id,
          ...(contact.email ? { email: contact.email } : {}),
        })
      }

      const participants = mergeRecordingParticipants(recording.participants ?? [], assigned)
      await deps.updateParticipants(recordingId, participants)
      return {
        data: JSON.stringify({
          kind: 'recording_speakers_assigned',
          recordingId,
          ...(pageId ? { pageId } : {}),
          participants: assigned,
        }),
      }
    },
  })
}
