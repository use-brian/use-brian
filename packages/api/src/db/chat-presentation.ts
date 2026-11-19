/** Owner-readable presentation, never model/source evidence. [COMP:api/session-display-history] */
import { z } from 'zod'
import { parseHostObservation } from '@use-brian/shared'
import { askQuestionPayload } from '@use-brian/agent-runtime/tools/base/ask-question.js'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from './client.js'
import type { AuthTokenClaims } from './auth-session-store.js'
import { resolveSessionTitleAuthority } from '../routes/session-title-authority.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { getUserProfilesByIds } from './users.js'
import { guestSenderProfile } from './guest-comment-store.js'
import type { ConversationVisibilityActor } from './conversation-visibility.js'

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

/** The displayable part of a question payload: never the routing fields
 * (`actionId`, `version`), which the pending read serves server-derived. */
function presentedQuestion(input: unknown): Block | null {
  const payload = askQuestionPayload(input)
  if (!payload) return null
  const { question, options, allowCustom, context } = payload
  return { question, ...(options ? { options } : {}), ...(allowCustom !== undefined ? { allowCustom } : {}),
    ...(context !== undefined ? { context } : {}) }
}

/**
 * A question round: an assistant row whose only calls are askQuestion, each
 * answered by a successful result in the next row. The engine reaches it only
 * when askQuestion is the round's sole tool (misuse is stripped before
 * publication), so the round ends the turn and its text is the question the user
 * saw, not intermediate narration (askquestion-suspend-resume.md).
 */
function questionRound(rows: readonly StoredRow[], index: number): boolean {
  const row = rows[index], next = rows[index + 1]
  if (row.role !== 'assistant' || row.available === false || !Array.isArray(row.content)) return false
  const calls = row.content.filter(record).filter(block => block.type === 'tool_use')
  if (calls.length === 0 || calls.some(block => block.name !== 'askQuestion' || typeof block.id !== 'string')) return false
  if (!next || next.role !== 'user' || next.available === false || next.sequence !== row.sequence + 1 || !Array.isArray(next.content)) return false
  const results = next.content.filter(record).filter(block => block.type === 'tool_result')
  return calls.every(call => results.some(result => result.toolUseId === call.id && result.isError !== true
    && (result.name === undefined || result.name === 'askQuestion')))
}

/** Retain only displayed output and confirmed activity, not raw tool payloads. */
export function projectPrivateChatRows(rows: readonly StoredRow[]) {
  const presented = rows.map(row => ({ ...row, content: [] as Block[], attachments: row.attachments ?? [],
    replyToText: row.replyToText ? presentationTexts([row.replyToText], [], false)[0] : null }))
  type Call = { slot: Block; id: string; name: string; input: unknown; asked?: boolean }
  const calls = new Map<string, Call>()
  const complete = (call: Call, content: unknown, failed: boolean, target: Block[]) => {
    const document = !failed && call.name === 'presentDocument' ? documentInput.safeParse(call.input) : null
    // A delivered question keeps its payload so a reload shows what was asked.
    const question = !failed && call.asked && call.name === 'askQuestion' ? presentedQuestion(call.input) : null
    Object.assign(call.slot, { type: 'tool_use', id: call.id, name: call.name,
      input: document?.success ? document.data : question ?? {} })
    target.push({ type: 'tool_result', toolUseId: call.id, name: call.name, isError: failed,
      content: pageReceipt(call.name, content, failed) })
  }
  rows.forEach((row, index) => {
    if (row.available === false) { calls.clear(); return }
    const target = presented[index].content
    const blocks = typeof row.content === 'string' ? [{ type: 'text', text: row.content }] : Array.isArray(row.content) ? row.content.filter(record) : []
    const asked = questionRound(rows, index)
    const carrier = !asked && blocks.some(block => block.type === 'tool_result' || block.type === 'host_observation'
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
        // The question shows as text even when the model's own text omitted it.
        const question = asked ? presentedQuestion(block.input)?.question : undefined
        if (typeof question === 'string' && !texts.some(text => text.includes(question))) target.push({ type: 'text', text: question })
        const slot = {}; target.push(slot)
        calls.set(block.id, { slot, id: `${row.id}:${block.id}`, name: block.name, input: block.input, asked })
      }
      if (row.role === 'user' && block.type === 'tool_result' && typeof block.toolUseId === 'string') {
        const call = calls.get(block.toolUseId)
        if (call && (block.name === undefined || block.name === call.name)) {
          complete(call, block.content, block.isError === true, target); calls.delete(block.toolUseId)
        }
      }
      const observation = parseHostObservation(block)
      if (observation) {
        // Native receivers display the executor's assistant-owned carrier as
        // activity. Legacy carriers keep the same safe visual projection.
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

const nativeHistory = z.object({ sessionId: z.string().uuid(), version: z.number().int().positive(), guestName: z.string().nullable(),
  rows: z.array(rowSchema.extend({ senderName: z.string().nullable(), senderAvatarUrl: z.string().nullable(),
    authoredByViewer: z.boolean() }).strict()) }).strict()

export async function readNativeConversationHistory(actor: ConversationVisibilityActor, sessionId: string) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, actor.userId)
    const result = await client.query<{ value: unknown }>(
      'SELECT read_native_conversation_history($1,$2,$3) AS value', [sessionId, actor.authSessionId, actor.authVersion])
    const history = nativeHistory.parse(result.rows[0]?.value)
    if (history.sessionId !== sessionId) throw new Error('conversation_history_identity_mismatch')
    const rows = history.rows.map(({ authoredByViewer, senderName: _name, senderAvatarUrl: _avatar, ...row }) => ({
      ...row,
      content: !authoredByViewer && Array.isArray(row.content)
        ? row.content.filter(block => !record(block) || block.type !== 'image') : row.content,
    }))
    const presented = projectPrivateChatRows(rows).map((row, index) => {
      const original = history.rows[index]
      const guest = guestSenderProfile(row.senderUserId, history.guestName)
      return { ...row, senderName: guest?.name ?? (row.senderUserId ? original.senderName : null),
        senderAvatarUrl: guest || !row.senderUserId ? null : original.senderAvatarUrl }
    })
    await client.query('COMMIT')
    return presented
  } catch (error) {
    const pgError = error as { code?: string; message?: string }
    if (pgError.code === '42501' && pgError.message === 'conversation_access_denied') {
      throw new WorkspaceAccessError('conversation_access_denied', 403)
    }
    throw error
  } finally {
    await rollbackAndRelease(client)
  }
}

export async function readPrivateChatPresentation(input: { claims: Readonly<AuthTokenClaims>; sessionId: string }) {
  const command = structuredClone(input), { claims } = command
  if (!claims.sessionId || claims.authVersion === undefined) throw new WorkspaceAccessError('authenticated_session_required', 401)
  const { execution } = await resolveSessionTitleAuthority({ ...command, readOnly: true })
  const workspaceId = execution.security.access.workspaceId
  // One consistent snapshot across pages (REPEATABLE READ). Its parent `FOR SHARE`
  // raises 40001 when a concurrent writer (a Stop or turn settlement committing on
  // the session row) changed the row after the snapshot. The read is idempotent,
  // so it retries on a fresh snapshot, which then sees the committed settlement;
  // a serialization conflict is never reported as a failed history read.
  for (let attempt = 1; ; attempt++) {
    try { return await readPrivateChatSnapshot(command, execution, workspaceId) }
    catch (error) {
      if ((error as { code?: string }).code !== '40001' || attempt >= PRESENTATION_SERIALIZATION_ATTEMPTS) throw error
      await new Promise(resolve => setTimeout(resolve, 25 * attempt))
    }
  }
}
const PRESENTATION_SERIALIZATION_ATTEMPTS = 4

async function readPrivateChatSnapshot(command: { claims: Readonly<AuthTokenClaims>; sessionId: string },
  execution: Awaited<ReturnType<typeof resolveSessionTitleAuthority>>['execution'], workspaceId: string) {
  const { claims } = command
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
