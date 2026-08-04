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
  geometry: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1).optional(), height: z.number().positive().max(1).optional() }).optional(),
}).strict()

export type OfficeCollaborationRouteDeps = {
  getArtifact(userId: string, artifactId: string): Promise<OfficeArtifactRow | null>
  resolveAccess(userId: string, artifactId: string): Promise<ResolvedOfficeAccess | null>
  getSnapshot(userId: string, artifactId: string): Promise<{ snapshot: unknown; seq: number; baseVersion: number } | null>
  appendCommand(params: { userId: string; artifactId: string; expectedSeq: number; command: z.infer<typeof OfficeCommandSchema> }): Promise<{ snapshot: unknown; seq: number; baseVersion: number } | 'conflict' | null>
  listThreads(userId: string, artifactId: string): Promise<Array<Record<string, unknown>>>
  createThread(params: { userId: string; workspaceId: string; artifactId: string; artifactVersionId: string; anchor: OfficeCommentAnchor; body: string; mentions?: string[]; brianTriggerKey?: string }): Promise<{ threadId: string; messageId: string }>
  reply(params: { userId: string; workspaceId: string; threadId: string; body: string; mentions?: string[]; brianTriggerKey?: string }): Promise<{ id: string } | null>
  resolve(params: { userId: string; threadId: string; resolved: boolean }): Promise<boolean>
  createSuggestion(params: { userId: string; workspaceId: string; artifactId: string; threadId?: string; baseVersionId: string; proposedByType: 'user' | 'assistant'; proposedByAssistantId?: string; commandBatch: unknown; affectedObjectIds: string[] }): Promise<{ id: string }>
  decideSuggestion(params: { userId: string; suggestionId: string; decision: 'accepted' | 'rejected' }): Promise<boolean>
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
    const body = z.object({ workspaceId: z.string().uuid(), body: z.string().min(1).max(20_000), mentions: z.array(z.string().uuid()).max(100).default([]), brianTriggerKey: z.string().min(8).max(255).optional() }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid comment reply' })
    const reply = await deps.reply({ userId, threadId: String(req.params.threadId), ...body.data })
    if (!reply) return void res.status(409).json({ error: 'duplicate_or_detached' })
    res.status(201).json(reply)
  })

  router.post('/comment-threads/:threadId/resolve', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ resolved: z.boolean() }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid resolve request' })
    if (!await deps.resolve({ userId, threadId: String(req.params.threadId), resolved: body.data.resolved })) return void res.status(404).json({ error: 'Comment not found' })
    res.json({ ok: true })
  })

  router.post('/suggestions/:suggestionId/decision', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ decision: z.enum(['accepted','rejected']) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid suggestion decision' })
    if (!await deps.decideSuggestion({ userId, suggestionId: String(req.params.suggestionId), decision: body.data.decision })) return void res.status(409).json({ error: 'suggestion_conflict' })
    res.json({ ok: true })
  })
  return router
}

function commandTargets(command: z.infer<typeof OfficeCommandSchema>): string[] {
  if ('targetId' in command) return [command.targetId]
  if ('slideId' in command) return [command.slideId]
  if (command.kind === 'batch') return [...new Set(command.commands.flatMap((child) => {
    const parsed = OfficeCommandSchema.safeParse(child)
    return parsed.success ? commandTargets(parsed.data) : []
  }))]
  return []
}
