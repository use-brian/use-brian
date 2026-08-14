/** Office commands, snapshots, comments, suggestions and explicit @Brian revisions. [COMP:api/office-routes] */
import { Router } from 'express'
import { z } from 'zod'
import { OfficeCommandSchema } from '@use-brian/office-model'
import type { OfficeArtifactRow } from '../db/office-artifacts.js'
import type { OfficeCommentAnchor } from '../db/office-comments.js'
import type { OfficeToolPort } from '@use-brian/core'
import type { ResolvedOfficeAccess } from '../office/access.js'

const AnchorSchema = z.object({
  kind: z.enum(['text_range','block','table_cell','slide','object','chart_datum','note_range','point','region']),
  targetIds: z.array(z.string().uuid()).min(1).max(100),
  range: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).optional(),
  relative: z.object({ from: z.record(z.string(), z.unknown()), to: z.record(z.string(), z.unknown()) }).strict().optional(),
  geometry: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1).optional(), height: z.number().positive().max(1).optional() }).optional(),
}).strict()

export type OfficeCollaborationRouteDeps = {
  getArtifact(userId: string, artifactId: string): Promise<OfficeArtifactRow | null>
  resolveAccess(userId: string, artifactId: string): Promise<ResolvedOfficeAccess | null>
  getSnapshot(userId: string, artifactId: string): Promise<{ snapshot: unknown; seq: number; baseVersion: number } | null>
  appendCommand(params: { userId: string; artifactId: string; expectedSeq: number; command: z.infer<typeof OfficeCommandSchema> }): Promise<{ snapshot: unknown; seq: number; baseVersion: number } | 'conflict' | null>
  listThreads(userId: string, artifactId: string): Promise<Array<Record<string, unknown>>>
  getThreadContext(userId: string, threadId: string): Promise<{ artifactId: string; workspaceId: string; status: 'open' | 'resolved' | 'detached' } | null>
  getMessageContext(userId: string, messageId: string): Promise<{ artifactId: string; workspaceId: string } | null>
  createThread(params: { userId: string; workspaceId: string; artifactId: string; artifactVersionId: string; anchor: OfficeCommentAnchor; body: string; mentions?: string[]; brianTriggerKey?: string }): Promise<{ threadId: string; messageId: string }>
  reply(params: { userId: string; workspaceId: string; threadId: string; body: string; mentions?: string[]; brianTriggerKey?: string }): Promise<{ id: string } | null>
  resolve(params: { userId: string; threadId: string; resolved: boolean }): Promise<boolean>
  updateThread(params: { userId: string; threadId: string; assignedUserId: string | null; assignedToBrian: boolean; dueAt: string | null }): Promise<boolean>
  react(params: { userId: string; messageId: string; reaction: 'thumbs_up' | 'heart' | 'check'; active: boolean }): Promise<boolean>
  detachMissingTargets(params: { userId: string; artifactId: string; validTargetIds: string[] }): Promise<number>
  listSuggestions(userId: string, artifactId: string): Promise<Array<Record<string, unknown>>>
  getSuggestion(userId: string, suggestionId: string): Promise<{ id: string; artifactId: string; status: 'open' | 'accepted' | 'rejected' | 'superseded' | 'conflicted'; commandBatch: unknown } | null>
  createSuggestion(params: { userId: string; workspaceId: string; artifactId: string; threadId?: string; baseVersionId: string; proposedByType: 'user' | 'assistant'; proposedByAssistantId?: string; commandBatch: unknown; affectedObjectIds: string[] }): Promise<{ id: string }>
  decideSuggestion(params: { userId: string; suggestionId: string; decision: 'accepted' | 'rejected' | 'conflicted'; expectedStatus?: 'open' | 'conflicted' }): Promise<boolean>
  applySuggestion(params: { artifactId: string; suggestionId: string; command: z.infer<typeof OfficeCommandSchema> }): Promise<'applied' | 'conflict'>
  service: OfficeToolPort
}

export function officeCollaborationRoutes(deps: OfficeCollaborationRouteDeps): Router {
  const router = Router()
  router.get('/artifacts/:artifactId/snapshot', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const artifactId = String(req.params.artifactId)
    if (!await deps.resolveAccess(userId, artifactId)) return void res.status(404).json({ error: 'Office artifact not found' })
    const live = await deps.getSnapshot(userId, artifactId)
    if (!live) return void res.status(409).json({ error: 'artifact_not_ready' })
    res.json(live)
  })

  router.post('/artifacts/:artifactId/commands', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ expectedSeq: z.number().int().min(1), mode: z.enum(['apply','suggest']).default('apply'), command: OfficeCommandSchema }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid Office command', issues: body.error.issues })
    const artifactId = String(req.params.artifactId)
    const [artifact, access] = await Promise.all([deps.getArtifact(userId, artifactId), deps.resolveAccess(userId, artifactId)])
    if (!artifact || !access) return void res.status(404).json({ error: 'Office artifact not found' })
    const authorizedCommand = OfficeCommandSchema.parse({
      ...body.data.command,
      actor: { type: 'user', id: userId },
      origin: body.data.command.origin === 'offline' ? 'offline' : 'manual',
    })
    if (body.data.mode === 'suggest' || !access.canEdit) {
      if (!access.canComment || !artifact.headVersionId) return void res.status(403).json({ error: 'comment_access_required' })
      const suggestion = await deps.createSuggestion({ userId, workspaceId: artifact.workspaceId, artifactId, baseVersionId: artifact.headVersionId, proposedByType: 'user', commandBatch: authorizedCommand, affectedObjectIds: commandTargets(authorizedCommand) })
      return void res.status(202).json({ mode: 'suggestion', suggestion })
    }
    const result = await deps.appendCommand({ userId, artifactId, expectedSeq: body.data.expectedSeq, command: authorizedCommand })
    if (result === 'conflict') return void res.status(409).json({ error: 'sequence_conflict' })
    if (!result) return void res.status(404).json({ error: 'Office artifact not found' })
    res.json(result)
  })

  router.get('/artifacts/:artifactId/comments', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const artifactId = String(req.params.artifactId)
    if (!await deps.resolveAccess(userId, artifactId)) return void res.status(404).json({ error: 'Office artifact not found' })
    res.json({ threads: await deps.listThreads(userId, artifactId) })
  })

  router.post('/artifacts/:artifactId/comments/detach-missing', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const artifactId = String(req.params.artifactId)
    const access = await deps.resolveAccess(userId, artifactId)
    if (!access?.canEdit) return void res.status(404).json({ error: 'Office artifact not found' })
    const live = await deps.getSnapshot(userId, artifactId)
    if (!live) return void res.status(409).json({ error: 'artifact_not_ready' })
    res.json({ detached: await deps.detachMissingTargets({ userId, artifactId, validTargetIds: collectIds(live.snapshot) }) })
  })

  router.post('/artifacts/:artifactId/comments', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ anchor: AnchorSchema, body: z.string().min(1).max(20_000), mentions: z.array(z.string().uuid()).max(100).default([]), invokeBrian: z.object({ assistantId: z.string().uuid(), expectedVersion: z.number().int().min(0), idempotencyKey: z.string().min(8).max(255) }).optional() }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid Office comment', issues: body.error.issues })
    const artifactId = String(req.params.artifactId)
    const [artifact, access] = await Promise.all([deps.getArtifact(userId, artifactId), deps.resolveAccess(userId, artifactId)])
    if (!artifact || !access || !access.canComment || !artifact.headVersionId) return void res.status(404).json({ error: 'Office artifact not found' })
    const brianTriggerKey = body.data.invokeBrian?.idempotencyKey
    const created = await deps.createThread({ userId, workspaceId: artifact.workspaceId, artifactId, artifactVersionId: artifact.headVersionId, anchor: body.data.anchor, body: body.data.body, mentions: body.data.mentions, brianTriggerKey })
    const revision = body.data.invokeBrian ? await deps.service.revise({ userId, assistantId: body.data.invokeBrian.assistantId, artifactId, instruction: body.data.body, targetIds: body.data.anchor.targetIds, expectedVersion: body.data.invokeBrian.expectedVersion, idempotencyKey: body.data.invokeBrian.idempotencyKey }) : undefined
    res.status(201).json({ ...created, revision })
  })

  router.post('/comment-threads/:threadId/replies', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ body: z.string().min(1).max(20_000), mentions: z.array(z.string().uuid()).max(100).default([]), brianTriggerKey: z.string().min(8).max(255).optional() }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid comment reply' })
    const threadId = String(req.params.threadId)
    const context = await deps.getThreadContext(userId, threadId)
    const access = context ? await deps.resolveAccess(userId, context.artifactId) : null
    if (!context || !access?.canComment) return void res.status(404).json({ error: 'Comment not found' })
    const reply = await deps.reply({ userId, workspaceId: context.workspaceId, threadId, ...body.data })
    if (!reply) return void res.status(409).json({ error: 'duplicate_or_detached' })
    res.status(201).json(reply)
  })

  router.post('/comment-threads/:threadId/resolve', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ resolved: z.boolean() }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid resolve request' })
    const threadId = String(req.params.threadId)
    const context = await deps.getThreadContext(userId, threadId)
    const access = context ? await deps.resolveAccess(userId, context.artifactId) : null
    if (!context || !access?.canComment || !await deps.resolve({ userId, threadId, resolved: body.data.resolved })) return void res.status(404).json({ error: 'Comment not found' })
    res.json({ ok: true })
  })

  router.patch('/comment-threads/:threadId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ assignedUserId: z.string().uuid().nullable(), assignedToBrian: z.boolean(), dueAt: z.string().datetime().nullable() }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid comment update' })
    const threadId = String(req.params.threadId)
    const context = await deps.getThreadContext(userId, threadId)
    const access = context ? await deps.resolveAccess(userId, context.artifactId) : null
    if (!context || !access?.canComment || !await deps.updateThread({ userId, threadId, ...body.data })) return void res.status(404).json({ error: 'Comment not found' })
    res.json({ ok: true })
  })

  router.post('/comment-messages/:messageId/reactions', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ reaction: z.enum(['thumbs_up','heart','check']), active: z.boolean() }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid reaction' })
    const messageId = String(req.params.messageId)
    const context = await deps.getMessageContext(userId, messageId)
    const access = context ? await deps.resolveAccess(userId, context.artifactId) : null
    if (!context || !access?.canComment || !await deps.react({ userId, messageId, ...body.data })) return void res.status(404).json({ error: 'Comment not found' })
    res.json({ ok: true })
  })

  router.get('/artifacts/:artifactId/suggestions', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const artifactId = String(req.params.artifactId)
    if (!await deps.resolveAccess(userId, artifactId)) return void res.status(404).json({ error: 'Office artifact not found' })
    res.json({ suggestions: await deps.listSuggestions(userId, artifactId) })
  })

  router.post('/suggestions/:suggestionId/decision', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ decision: z.enum(['accepted','rejected']) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid suggestion decision' })
    const suggestionId = String(req.params.suggestionId)
    const suggestion = await deps.getSuggestion(userId, suggestionId)
    const access = suggestion ? await deps.resolveAccess(userId, suggestion.artifactId) : null
    if (!suggestion || !access?.canEdit) return void res.status(404).json({ error: 'Suggestion not found' })
    if (suggestion.status === body.data.decision) return void res.json({ ok: true })
    if (suggestion.status !== 'open' && suggestion.status !== 'conflicted') return void res.status(409).json({ error: 'suggestion_conflict' })
    if (body.data.decision === 'accepted') {
      const command = OfficeCommandSchema.safeParse(suggestion.commandBatch)
      if (!command.success) return void res.status(409).json({ error: 'suggestion_invalid' })
      const applied = await deps.applySuggestion({ artifactId: suggestion.artifactId, suggestionId, command: command.data })
      if (applied === 'conflict') {
        await deps.decideSuggestion({ userId, suggestionId, decision: 'conflicted', expectedStatus: suggestion.status })
        return void res.status(409).json({ error: 'suggestion_conflict' })
      }
    }
    if (!await deps.decideSuggestion({ userId, suggestionId, decision: body.data.decision, expectedStatus: suggestion.status })) {
      const repaired = await deps.getSuggestion(userId, suggestionId)
      if (repaired?.status === body.data.decision) return void res.json({ ok: true })
      return void res.status(409).json({ error: 'suggestion_conflict' })
    }
    res.json({ ok: true })
  })
  return router
}

function commandTargets(command: z.infer<typeof OfficeCommandSchema>): string[] {
  if ('targetId' in command) return [command.targetId]
  if ('imageId' in command) return [command.imageId]
  if ('slideId' in command) return [command.slideId]
  if (command.kind === 'batch') return [...new Set(command.commands.flatMap((child) => {
    const parsed = OfficeCommandSchema.safeParse(child)
    return parsed.success ? commandTargets(parsed.data) : []
  }))]
  return []
}

function collectIds(value: unknown): string[] {
  const ids = new Set<string>()
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return
    if (!Array.isArray(candidate)) {
      const id = (candidate as { id?: unknown }).id
      if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) ids.add(id)
    }
    for (const child of Array.isArray(candidate) ? candidate : Object.values(candidate)) visit(child)
  }
  visit(value)
  return [...ids]
}
