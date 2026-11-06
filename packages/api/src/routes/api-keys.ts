import type { WorkspaceMcpProfile } from '../workspace-mcp/profile.js'
import { withExternalKeyActor } from '../db/external-key-admission.js'
/**
 * Edition-neutral per-assistant API key management.
 * [COMP:api/integrations-api-keys]
 */
import { Router } from 'express'
import { z } from 'zod'
import type { ApiKeyStore } from '../db/api-key-store.js'

type AssistantParams = { assistantId: string }

const createSchema = z.object({
  name: z.string().min(1).max(120),
  workspaceAccess: z.boolean().optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
  contextGroupId: z.string().uuid().nullable().optional(),
  contextProjectId: z.string().uuid().nullable().optional(),
  scope: z.enum(['chat', 'agent']).default('chat'),
  audience: z.enum(['external', 'internal']).default('external'),
  anonymousContext: z.enum(['thin', 'full']).default('thin'),
  toolPolicy: z.enum(['assistant', 'public_research']).optional(),
}).strict()

export function apiKeyRoutes(store: ApiKeyStore, workspaceProfile?: WorkspaceMcpProfile): Router {
  const router = Router({ mergeParams: true })

  router.post<AssistantParams>('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Missing or invalid Authorization header' }); return }
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid input', detail: parsed.error.message }); return }
    if (parsed.data.audience === 'internal' && parsed.data.anonymousContext === 'full') {
      res.status(400).json({
        error: 'Invalid input',
        detail: 'anonymousContext "full" applies to external-audience keys only',
      })
      return
    }
    const toolPolicy = parsed.data.toolPolicy
      ?? (
        parsed.data.audience === 'internal' || parsed.data.scope === 'agent'
          ? 'assistant'
          : 'public_research'
      )
    if (parsed.data.audience === 'internal' && toolPolicy !== 'assistant') {
      return res.status(400).json({
        error: 'invalid_input',
        detail: 'toolPolicy "public_research" applies to external-audience keys only',
      })
    }
    if (parsed.data.scope === 'agent' && toolPolicy !== 'assistant') {
      return res.status(400).json({
        error: 'invalid_input',
        detail: 'toolPolicy "public_research" applies to chat-scope keys only',
      })
    }
    if (!parsed.data.workspaceAccess && (parsed.data.expiresInDays !== undefined
      || parsed.data.contextGroupId !== undefined || parsed.data.contextProjectId !== undefined)) {
      res.status(400).json({ error: 'workspace_mcp_consent_required' }); return
    }
    if (parsed.data.workspaceAccess && parsed.data.scope !== 'agent') {
      res.status(400).json({ error: 'workspace_mcp_requires_agent_scope' }); return
    }
    try {
      if (parsed.data.workspaceAccess && !workspaceProfile) throw new Error('workspace_mcp_profile_unavailable')
      const workspaceMcpConsent = parsed.data.workspaceAccess ? await workspaceProfile!.issue({
        actorUserId: userId, authSessionId: req.authSessionId, assistantId: req.params.assistantId,
        readOnly: false, contextGroupId: parsed.data.contextGroupId ?? null,
        contextProjectId: parsed.data.contextProjectId ?? null, expiresInDays: parsed.data.expiresInDays,
      }) : undefined
      const created = await withExternalKeyActor(req.userId!, req.authSessionId, () => store.create({
        assistantId: req.params.assistantId,
        name: parsed.data.name,
        actingUserId: userId,
        scope: parsed.data.scope,
        audience: parsed.data.audience,
        anonymousContext: parsed.data.anonymousContext,
        toolPolicy,
        ...(workspaceMcpConsent ? { workspaceMcpConsent } : {}),
      }))
      res.json({
        id: created.id,
        workspaceMcpConsent: created.workspaceMcpConsent,
        name: created.name,
        key: created.plaintext,
        prefix: created.prefix,
        scope: created.scope,
        audience: created.audience,
        anonymousContext: created.anonymousContext,
        toolPolicy: created.toolPolicy,
        status: created.status,
        createdAt: created.createdAt,
        lastUsedAt: created.lastUsedAt,
      })
    } catch (err) {
      if ((err as Error).message.startsWith('workspace_mcp_')) {
        res.status(409).json({ error: (err as Error).message }); return
      }
      if ((err as Error).message.includes('Not authorized')) {
        res.status(403).json({ error: 'Not authorized to modify this assistant' })
        return
      }
      if ((err as Error).message.startsWith('external_key_')) {
        res.status(409).json({ error: 'external_key_admission_required' }); return
      }
      console.error('[api-keys] create failed:', err)
      res.status(500).json({ error: 'Failed to create API key' })
    }
  })

  router.get<AssistantParams>('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Missing or invalid Authorization header' }); return }
    try {
      res.json({ keys: await store.listForUser(userId, req.params.assistantId) })
    } catch (err) {
      console.error('[api-keys] list failed:', err)
      res.status(500).json({ error: 'Failed to list API keys' })
    }
  })

  router.delete<{ assistantId: string; keyId: string }>('/:keyId', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Missing or invalid Authorization header' }); return }
    try {
      if (!(await store.revokeForUser(userId, req.params.keyId))) {
        res.status(404).json({ error: 'API key not found' })
        return
      }
      res.status(204).end()
    } catch (err) {
      console.error('[api-keys] revoke failed:', err)
      res.status(500).json({ error: 'Failed to revoke API key' })
    }
  })

  return router
}
