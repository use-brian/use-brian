/** Owner-readable presentation, never model/source evidence. [COMP:api/session-display-history] */
import { z } from 'zod'
import { parseHostObservation } from '@use-brian/shared'
import { applyRLSGucs, getAppPool, runWithAgentAccess } from './client.js'
import type { AuthTokenClaims } from './auth-session-store.js'
import { resolveSessionTitleAuthority } from '../routes/session-title-authority.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { getUserProfilesByIds } from './users.js'

const attachment = z.object({ fileId: z.string(), workspaceId: z.string().uuid(), path: z.string(), name: z.string(),
  mime: z.string(), sizeBytes: z.number().nonnegative(), caption: z.string().optional() })
const rowSchema = z.object({ id: z.string().uuid(), sequence: z.number().int(), role: z.enum(['user', 'assistant']),
  available: z.boolean().optional(),
  timestamp: z.string(), content: z.unknown(), senderUserId: z.string().uuid().nullable(), senderAssistantId: z.string().uuid().nullable(),
  publishedSenderName: z.string().nullable(), replyToText: z.string().nullable(), attachments: z.array(attachment).nullable() })
const pageSchema = z.object({ sessionId: z.string().uuid(), workspaceId: z.string().uuid(), rows: z.array(rowSchema), nextSequence: z.number().int().nullable() })
type StoredRow = z.infer<typeof rowSchema>
type Block = Record<string, unknown>
const record = (value: unknown): value is Block => !!value && typeof value === 'object' && !Array.isArray(value)
const fileTag = /<attached_file\b([^>]*)>[\s\S]*?(?:<\/attached_file>|$)/gi
const attr = (attrs: string, key: string) => new RegExp(`\\b${key}="([^"]*)"`, 'i').exec(attrs)?.[1] ?? ''
const validPreview = (mime: string) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf'].includes(mime)

/** Closed headers retain upload identity and prevent unsafe text-only retry. */
function presentationTexts(texts: string[], uploaded: Array<{ name: string; mime: string }>, keepHeaders: boolean): string[] {
  const text = texts.join('')
  const spans: Array<{ start: number; end: number; replacement: string }> = []
  const replacement = (attrs: string) => {
    const name = attr(attrs, 'name'), mime = attr(attrs, 'type'), id = attr(attrs, 'id')
    uploaded.push({ name, mime })
    const escape = (value: string) => value.replace(/[<>\r\n]/g, '').slice(0, 1024)
    return keepHeaders ? `<attached_file id="${escape(id)}" name="${escape(name)}" type="${escape(mime)}"></attached_file>` : ''
  }
  for (const match of text.matchAll(fileTag)) spans.push({ start: match.index, end: match.index + match[0].length, replacement: replacement(match[1]) })
  const unfinished = /<attached_file\b[^>]*$/i.exec(text)
  if (unfinished && !spans.some(span => span.end > unfinished.index)) {
    spans.push({ start: unfinished.index, end: text.length, replacement: replacement(unfinished[0].slice('<attached_file'.length)) })
  }
  let start = 0
  return texts.map(value => {
    const end = start + value.length
    let cursor = start, result = ''
    for (const span of spans) {
      if (span.end <= start || span.start >= end) continue
      result += text.slice(cursor, Math.max(cursor, span.start))
      if (span.start >= start) result += span.replacement
      cursor = Math.min(end, span.end)
    }
    result += text.slice(cursor, end); start = end
    return result
  })
}

const documentInput = z.object({ title: z.string().trim().min(1).max(512), content: z.string().min(1).max(250_000),
  format: z.enum(['markdown', 'text']).optional(), sourceName: z.string().trim().max(512).optional() })
function pageReceipt(name: string, content: unknown, failed: boolean): string {
  if (failed || !['delegateDocEdit', 'renderPage'].includes(name) || typeof content !== 'string') return ''
  let value: unknown
  try { value = JSON.parse(content) } catch { return '' }
  if (!record(value) || value.status === 'failed') return ''
  const candidates = Array.isArray(value.pageIds) ? value.pageIds : [value.pageId]
  const pageIds = [...new Set(candidates.filter((id): id is string => typeof id === 'string' && z.string().uuid().safeParse(id).success))]
  return pageIds.length ? JSON.stringify({ pageIds }) : ''
}

/** Retain only displayed output and confirmed activity, not raw tool payloads. */
export function projectPrivateChatRows(rows: readonly StoredRow[]) {
  const presented = rows.map(row => ({ ...row, content: [] as Block[], attachments: row.attachments ?? [],
    replyToText: row.replyToText ? presentationTexts([row.replyToText], [], false)[0] : null }))
  const calls = new Map<string, { slot: Block; id: string; name: string; input: unknown }>()
  const complete = (call: { slot: Block; id: string; name: string; input: unknown }, content: unknown, failed: boolean, target: Block[]) => {
    const document = !failed && call.name === 'presentDocument' ? documentInput.safeParse(call.input) : null
    Object.assign(call.slot, { type: 'tool_use', id: call.id, name: call.name, input: document?.success ? document.data : {} })
    target.push({ type: 'tool_result', toolUseId: call.id, name: call.name, isError: failed,
      content: pageReceipt(call.name, content, failed) })
  }
  rows.forEach((row, index) => {
    if (row.available === false) { calls.clear(); return }
    const target = presented[index].content
    const blocks = typeof row.content === 'string' ? [{ type: 'text', text: row.content }] : Array.isArray(row.content) ? row.content.filter(record) : []
    const carrier = blocks.some(block => block.type === 'tool_result' || block.type === 'host_observation'
      || row.role === 'assistant' && block.type === 'tool_use')
    // Call IDs may repeat between turns. Never pair across an authored input.
    if (row.role === 'user' && !carrier || index > 0 && row.sequence !== rows[index - 1].sequence + 1) calls.clear()
    const uploaded: Array<{ name: string; mime: string }> = []
    const textBlocks = blocks.filter(block => block.type === 'text' && typeof block.text === 'string')
    const texts = presentationTexts(textBlocks.map(block => block.text as string), uploaded, row.role === 'user')
    let textIndex = 0
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string' && !carrier) {
        const text = texts[textIndex++]
        if (text.trim()) target.push({ type: 'text', text })
      }
      if (row.role === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const slot = {}; target.push(slot)
        calls.set(block.id, { slot, id: `${row.id}:${block.id}`, name: block.name, input: block.input })
      }
      if (row.role === 'user' && block.type === 'tool_result' && typeof block.toolUseId === 'string') {
        const call = calls.get(block.toolUseId)
        if (call && (block.name === undefined || block.name === call.name)) {
          complete(call, block.content, block.isError === true, target); calls.delete(block.toolUseId)
        }
      }
      const observation = parseHostObservation(block)
      if (observation && row.role === 'user') {
        // Host observations are user-role carriers; expose an activity row,
        // not a forged human utterance or the host's private read payload.
        presented[index].role = 'assistant'
        presented[index].senderUserId = null
        presented[index].publishedSenderName = null
        const slot = {}; target.push(slot)
        complete({ slot, id: `${row.id}:${observation.id}`, name: observation.name, input: observation.input },
          observation.content, observation.isError, target)
      }
    }
    if (row.role === 'user' && !carrier) {
      const used = new Set<number>()
      for (const block of blocks) {
        if (block.type !== 'image' || typeof block.mimeType !== 'string' || !validPreview(block.mimeType)
          || typeof block.data !== 'string' || block.data.length > 24_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) continue
        const match = uploaded.findIndex((item, i) => !used.has(i) && item.mime === block.mimeType
          && (typeof block.name !== 'string' || block.name === item.name))
        if (match < 0) continue
        used.add(match)
        target.push({ type: 'image', mimeType: block.mimeType, data: block.data, name: uploaded[match].name })
      }
    }
  })
  return presented.map(row => ({ ...row, content: row.content.filter(block => typeof block.type === 'string') }))
}

export async function readPrivateChatPresentation(input: { claims: Readonly<AuthTokenClaims>; sessionId: string }) {
  const command = structuredClone(input), { claims } = command
  if (!claims.sessionId || claims.authVersion === undefined) throw new WorkspaceAccessError('authenticated_session_required', 401)
  const { execution } = await resolveSessionTitleAuthority({ ...command, readOnly: true })
  const workspaceId = execution.security.access.workspaceId
  return runWithAgentAccess(execution.security.access, async () => {
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await applyRLSGucs(client, claims.userId)
      await client.query("SELECT set_config('app.v2_assistant_id',$1,true)", [execution.assistant.id])
      const rows: StoredRow[] = []
      let after = 0
      for (;;) {
        const result = await client.query<{ value: unknown }>('SELECT read_private_chat_messages($1,$2,$3,$4,$5,100) AS value',
          [workspaceId, command.sessionId, claims.sessionId, claims.authVersion, after])
        const page = pageSchema.parse(result.rows[0]?.value)
        if (page.sessionId !== command.sessionId || page.workspaceId !== workspaceId) throw new Error('chat_presentation_identity_mismatch')
        rows.push(...page.rows)
        if (page.nextSequence === null) break
        if (page.nextSequence <= after) throw new Error('chat_presentation_cursor_invalid')
        after = page.nextSequence
      }
      const presented = projectPrivateChatRows(rows)
      const profiles = await getUserProfilesByIds(presented.flatMap(row => row.senderUserId ? [row.senderUserId] : []))
      const attributed = presented.map(row => ({ ...row,
        senderName: row.senderUserId ? profiles.get(row.senderUserId)?.name ?? null : null,
        senderAvatarUrl: row.senderUserId ? profiles.get(row.senderUserId)?.avatarUrl ?? null : null }))
      await execution.security.authority.assertCurrent()
      await client.query('COMMIT')
      return attributed
    } catch (error) {
      await client.query('ROLLBACK')
      if ((error as { code?: string }).code === '42501') throw new WorkspaceAccessError('chat_presentation_unavailable', 403)
      throw error
    } finally { client.release() }
  })
}
