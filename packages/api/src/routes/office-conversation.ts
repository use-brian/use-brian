/**
 * The only routes that reach an Office file's shared conversation, and both
 * are artifact-scoped (D4): the thread is never listed or searched elsewhere.
 *
 * GET  /artifacts/:artifactId/conversation  any reader of the file: the thread
 *      id (null until the first send), whether the caller may send, and the
 *      workspace assistant that answers. Messages and the live follow stream
 *      then ride `GET /api/sessions/:id/messages|stream`, whose read gate for
 *      `office_thread` is the same Office access predicate.
 * POST /artifacts/:artifactId/conversation  a Comment/Edit sender: get or
 *      lazily create the thread before the first chat turn.
 *
 * A caller who cannot read the file gets 404, with no existence signal.
 * Spec: docs/architecture/features/office.md -> "Brian conversation in the file".
 * [COMP:api/office-chat-session]
 */
import { Router } from 'express'
import type { ResolvedOfficeAccess } from '../office/access.js'
import type { OfficeArtifactSessionLink } from '../db/office-artifact-sessions.js'

export type OfficeConversationDeps = {
  resolveAccess(userId: string, artifactId: string): Promise<ResolvedOfficeAccess | null>
  findSession(artifactId: string): Promise<OfficeArtifactSessionLink | null>
  ensureSession(params: { artifactId: string; assistantId: string; userId: string }): Promise<OfficeArtifactSessionLink>
  workspaceAssistant(userId: string, workspaceId: string): Promise<{ id: string; name: string } | null>
}

export function officeConversationRoutes(deps: OfficeConversationDeps): Router {
  const router = Router()

  router.get('/artifacts/:artifactId/conversation', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const artifactId = String(req.params.artifactId)
    const access = await deps.resolveAccess(userId, artifactId)
    if (!access || access.mode === 'session') return void res.status(404).json({ error: 'Office artifact not found' })
    const [link, assistant] = await Promise.all([deps.findSession(artifactId), deps.workspaceAssistant(userId, access.workspaceId)])
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({
      sessionId: link?.sessionId ?? null,
      canSend: access.canComment && Boolean(assistant),
      role: access.role,
      assistant: assistant ? { id: assistant.id, name: assistant.name } : null,
    })
  })

  router.post('/artifacts/:artifactId/conversation', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const artifactId = String(req.params.artifactId)
    const access = await deps.resolveAccess(userId, artifactId)
    if (!access || access.mode === 'session') return void res.status(404).json({ error: 'Office artifact not found' })
    if (!access.canComment) return void res.status(403).json({ error: 'office_chat_read_only' })
    const assistant = await deps.workspaceAssistant(userId, access.workspaceId)
    if (!assistant) return void res.status(409).json({ error: 'office_chat_no_assistant' })
    const link = await deps.ensureSession({ artifactId, assistantId: assistant.id, userId })
    res.status(201).json({ sessionId: link.sessionId, assistant: { id: assistant.id, name: assistant.name } })
  })

  return router
}
