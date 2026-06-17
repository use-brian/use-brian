/**
 * Fathom tools — read-only access to meeting recordings, transcripts,
 * summaries, and action items.
 *
 * The `api` object is injected by the API layer so core stays free of
 * network/OAuth deps.
 *
 * See docs/architecture/integrations/fathom.md.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import { type Json, str, asRows, projectList } from './_connector-result.js'

// Fathom meeting objects carry host / share-settings / per-participant user
// objects the model never needs. Project to the documented fields, but
// PRESERVE any inline include the caller explicitly asked for
// (includeTranscript / includeSummary / includeActionItems / includeCrmMatches).
// See `_connector-result.ts`.
const INLINE_INCLUDES = ['default_summary', 'transcript', 'summary', 'action_items', 'crm_matches'] as const

function meetingRow(m: Json, full = false): Json {
  const out: Json = {
    recording_id: str(m, 'recording_id') ?? str(m, 'id'),
    title: str(m, 'title'),
    recorded_at: str(m, 'recorded_at'),
    url: str(m, 'url') ?? str(m, 'share_url'),
  }
  if (full) {
    out.participants = asRows(m.attendees ?? m.participants).map((p) => str(p, 'name') ?? str(p, 'email'))
    out.meeting_type = str(m, 'meeting_type')
  }
  for (const k of INLINE_INCLUDES) if (m[k] !== undefined) out[k] = m[k]
  return out
}

export type FathomApi = {
  listMeetings(params: {
    cursor?: string
    limit?: number
    recordedAfter?: string
    recordedBefore?: string
    includeTranscript?: boolean
    includeSummary?: boolean
    includeActionItems?: boolean
    includeCrmMatches?: boolean
  }): Promise<unknown>

  getMeeting(meetingId: string): Promise<unknown>

  getTranscript(meetingId: string): Promise<unknown>

  getSummary(meetingId: string): Promise<unknown>
}

export function createFathomTools(api: FathomApi): Tool[] {
  const listMeetings = buildTool({
    name: 'fathomListMeetings',
    description:
      'List recent Fathom meetings (recording_id, title, recorded_at, URL). Pagination via cursor. ' +
      'For meetings recorded <30min ago, set includeSummary: true here instead of calling fathomGetSummary — ' +
      'the per-recording endpoint 404s while Fathom is still processing; the inline default_summary returns null instead, ' +
      'which is a clear "not ready" signal.',
    inputSchema: z.object({
      cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
      limit: z.number().optional().describe('Max meetings to return per page (default 25).'),
      recordedAfter: z.string().optional().describe('ISO 8601 timestamp — only meetings recorded on or after this.'),
      recordedBefore: z.string().optional().describe('ISO 8601 timestamp — only meetings recorded on or before this.'),
      includeTranscript: z.boolean().optional().describe('Embed transcript inline. Increases response size; prefer fathomGetTranscript per meeting.'),
      includeSummary: z.boolean().optional().describe('Embed AI summary inline.'),
      includeActionItems: z.boolean().optional().describe('Embed extracted action items inline.'),
      includeCrmMatches: z.boolean().optional().describe('Embed matched CRM contacts/companies inline.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 20_000,

    async execute(input) {
      try {
        const data = await api.listMeetings({
          cursor: input.cursor,
          limit: input.limit,
          recordedAfter: input.recordedAfter,
          recordedBefore: input.recordedBefore,
          includeTranscript: input.includeTranscript,
          includeSummary: input.includeSummary,
          includeActionItems: input.includeActionItems,
          includeCrmMatches: input.includeCrmMatches,
        })
        const r = (data ?? {}) as Json
        const rows = asRows(Array.isArray(data) ? data : (r.items ?? r.meetings ?? r.recordings))
        return { data: {
          ...projectList(rows, input.limit ?? 25, (m) => meetingRow(m)),
          next_cursor: str(r, 'next_cursor'),
        } }
      } catch (err) {
        return { data: `Fathom error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getMeeting = buildTool({
    name: 'fathomGetMeeting',
    description:
      'Get metadata for a specific Fathom meeting (title, recording URL, participants, timestamps). ' +
      'Use the meeting ID returned by fathomListMeetings.',
    inputSchema: z.object({
      meetingId: z.string().describe('The Fathom meeting / recording ID.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.getMeeting(input.meetingId)
        return { data: meetingRow((data ?? {}) as Json, true) }
      } catch (err) {
        return { data: `Fathom error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getTranscript = buildTool({
    name: 'fathomGetTranscript',
    description:
      'Verbatim transcript (speaker-tagged, timestamped) for one recording. ' +
      'Heavy — only when the user asks for quotes or who-said-what. For summaries use fathomGetSummary.',
    inputSchema: z.object({
      meetingId: z.string().describe('The Fathom meeting / recording ID.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 30_000,

    async execute(input) {
      try {
        const data = await api.getTranscript(input.meetingId)
        return { data }
      } catch (err) {
        return { data: `Fathom error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getSummary = buildTool({
    name: 'fathomGetSummary',
    description:
      'AI summary + action items for one Fathom recording by recording_id. ' +
      'Default for "what was the meeting about / decided / action items". ' +
      'For recordings <30min old, use fathomListMeetings with includeSummary: true instead — this endpoint ' +
      '404s during processing. A 404 here means "still processing", not missing; do not retry with fathomGetTranscript.',
    inputSchema: z.object({
      meetingId: z.string().describe('The Fathom meeting / recording ID.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 20_000,

    async execute(input) {
      try {
        const data = await api.getSummary(input.meetingId)
        return { data }
      } catch (err) {
        return { data: `Fathom error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  return [listMeetings, getMeeting, getTranscript, getSummary]
}
