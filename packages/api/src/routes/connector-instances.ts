/**
 * OSS connector-instance sharing and workspace-owned connector management.
 * Mounted behind requireAuth by boot.ts.
 * Component tag: [COMP:api/connector-instances-route].
 */
import { Router, type Response } from 'express'
import { z } from 'zod'
import type { ConnectorInstanceStore, SensitivityTier } from '../db/connector-instance-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import {
  effectiveReadClearance,
  getWorkspaceMembershipWithClearanceSystem,
} from '../db/workspace-store.js'
import type { WorkspaceAuditStore } from '../db/workspace-audit-store.js'
import type { WorkspaceToolPolicyStore } from '../db/workspace-tool-policy-store.js'

type Membership = Awaited<ReturnType<typeof getWorkspaceMembershipWithClearanceSystem>>

export type ConnectorInstanceRouteOptions = {
  connectorInstanceStore: ConnectorInstanceStore
  connectorGrantStore: ConnectorGrantStore
  workspaceStore: WorkspaceStore
  auditStore: WorkspaceAuditStore
  workspaceToolPolicyStore: WorkspaceToolPolicyStore
  /** Test seam; production uses the system-level clearance lookup. */
  getMembershipWithClearance?: (userId: string, workspaceId: string) => Promise<Membership>
}

const PatchInstanceBody = z.object({
  label: z.string().min(1).max(100).optional(),
  sensitivity: z.enum(['public', 'internal', 'confidential']).optional(),
  connected: z.boolean().optional(),
})

const SetCredentialsBody = z.object({
  clientSecret: z.string().min(8).max(4096),
  clientId: z.string().max(256).optional(),
})

const CreateGrantBody = z.object({
  targetType: z.literal('workspace'),
  targetId: z.string().uuid(),
  sensitivity: z.enum(['public', 'internal', 'confidential']).optional(),
})

const TransferBody = z.object({
  workspaceId: z.string().uuid(),
  sensitivity: z.enum(['public', 'internal', 'confidential']).optional(),
})

const SetToolPolicyBody = z.object({
  policy: z.enum(['allow', 'ask', 'block']),
  classification: z.enum(['read', 'write', 'destructive', 'unknown']).optional(),
})

const SENSITIVITY_RANK: Record<SensitivityTier, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
}

function capSensitivity(requested: SensitivityTier, ceiling: SensitivityTier): SensitivityTier {
  return SENSITIVITY_RANK[requested] <= SENSITIVITY_RANK[ceiling] ? requested : ceiling
}

export function workspaceConnectorInstanceRoutes(opts: ConnectorInstanceRouteOptions): Router {
  const router = Router({ mergeParams: true })
  const getMembership = opts.getMembershipWithClearance ?? getWorkspaceMembershipWithClearanceSystem

  async function requireConnectorClearance(
    req: { userId?: string; params: Record<string, string> },
    res: Response,
  ) {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return null }
    const workspaceId = req.params.workspaceId
    const membership = await getMembership(userId, workspaceId)
    if (!membership) { res.status(403).json({ error: 'Not a workspace member' }); return null }

    const instance = await opts.connectorInstanceStore.get(userId, req.params.instanceId)
    if (!instance || instance.scope !== 'workspace' || instance.workspaceId !== workspaceId) {
      res.status(404).json({ error: 'Workspace instance not found' })
      return null
    }

    const ceiling = effectiveReadClearance(membership.role, membership.clearance, 'confidential')
    if (SENSITIVITY_RANK[ceiling] < SENSITIVITY_RANK[instance.sensitivity]) {
      res.status(404).json({ error: 'Workspace instance not found' })
      return null
    }
    return { userId, instance, ceiling }
  }

  router.get('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const workspaceId = (req.params as Record<string, string>).workspaceId
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a workspace member' }); return }

    const [teamNative, granted] = await Promise.all([
      opts.connectorInstanceStore.listByWorkspace(userId, workspaceId),
      opts.connectorGrantStore.listForTargetSystem('workspace', workspaceId),
    ])
    res.json({
      teamNative,
      granted: granted.map((grant) => ({
        grantId: grant.id,
        grantedByUserId: grant.grantedByUserId,
        grantedAt: grant.grantedAt,
        instance: grant.instance,
      })),
    })
  })

  router.patch('/:instanceId', async (req, res) => {
    const gate = await requireConnectorClearance(req, res)
    if (!gate) return
    const parsed = PatchInstanceBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
      return
    }
    const patch = { ...parsed.data }
    if (patch.sensitivity) patch.sensitivity = capSensitivity(patch.sensitivity, gate.ceiling)
    const instance = await opts.connectorInstanceStore.update(gate.userId, req.params.instanceId, patch)
    res.json({ instance })
  })

  router.post('/:instanceId/credentials', async (req, res) => {
    const gate = await requireConnectorClearance(req, res)
    if (!gate) return
    const parsed = SetCredentialsBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
      return
    }
    try {
      const workspaceId = (req.params as Record<string, string>).workspaceId
      const instance = await opts.connectorInstanceStore.update(gate.userId, req.params.instanceId, {
        credentials: {
          client_id: parsed.data.clientId ?? '',
          client_secret: parsed.data.clientSecret,
        },
        connected: true,
      })
      void opts.auditStore.append({
        workspaceId,
        actorUserId: gate.userId,
        eventType: 'connector.connected',
        subjectId: req.params.instanceId,
        details: { provider: gate.instance.provider, label: gate.instance.label },
      })
      res.json({ instance })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message.includes('CHANNEL_CREDENTIAL_KEY')) {
        res.status(503).json({ error: 'Credential encryption not configured on the server' })
        return
      }
      console.error('[workspace-connector] credentials failed:', error)
      res.status(500).json({ error: 'Failed to set credentials' })
    }
  })

  router.delete('/:instanceId', async (req, res) => {
    const gate = await requireConnectorClearance(req, res)
    if (!gate) return
    const deleted = await opts.connectorInstanceStore.delete(gate.userId, req.params.instanceId)
    if (deleted) {
      void opts.auditStore.append({
        workspaceId: (req.params as Record<string, string>).workspaceId,
        actorUserId: gate.userId,
        eventType: 'connector.disconnected',
        subjectId: req.params.instanceId,
        details: { provider: gate.instance.provider, label: gate.instance.label },
      })
    }
    res.json({ deleted })
  })

  router.get('/:instanceId/tool-policies', async (req, res) => {
    const gate = await requireConnectorClearance(req, res)
    if (!gate) return
    const workspaceId = (req.params as Record<string, string>).workspaceId
    const policies = await opts.workspaceToolPolicyStore.listForWorkspace(workspaceId)
    res.json({ policies: policies.filter((policy) => policy.serverName === gate.instance.provider) })
  })

  router.put('/:instanceId/tools/:toolName/policy', async (req, res) => {
    const gate = await requireConnectorClearance(req, res)
    if (!gate) return
    const parsed = SetToolPolicyBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
      return
    }
    const workspaceId = (req.params as Record<string, string>).workspaceId
    const policy = await opts.workspaceToolPolicyStore.setPolicy({
      workspaceId,
      serverName: gate.instance.provider,
      toolName: req.params.toolName,
      policy: parsed.data.policy,
      classification: parsed.data.classification ?? null,
      updatedBy: gate.userId,
    })
    void opts.auditStore.append({
      workspaceId,
      actorUserId: gate.userId,
      eventType: 'connector.policy_changed',
      subjectId: gate.instance.id,
      details: {
        provider: gate.instance.provider,
        tool: req.params.toolName,
        policy: parsed.data.policy,
      },
    })
    res.json({ policy })
  })

  return router
}

export function memberConnectorInstanceRoutes(opts: ConnectorInstanceRouteOptions): Router {
  const router = Router()
  const getMembership = opts.getMembershipWithClearance ?? getWorkspaceMembershipWithClearanceSystem

  router.post('/:instanceId/grants', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const parsed = CreateGrantBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
      return
    }
    const membership = await getMembership(userId, parsed.data.targetId)
    if (!membership) {
      res.status(403).json({ error: 'Not a member of the target workspace' })
      return
    }
    try {
      const grant = await opts.connectorGrantStore.create({
        actingUserId: userId,
        connectorInstanceId: req.params.instanceId,
        targetType: 'workspace',
        targetId: parsed.data.targetId,
      })
      const sensitivity = parsed.data.sensitivity ??
        effectiveReadClearance(membership.role, membership.clearance, 'confidential')
      await opts.connectorInstanceStore.update(userId, req.params.instanceId, { sensitivity })
      res.status(201).json({ grant })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create grant'
      if (message.includes('workspace-scoped') || message.includes('instance owner') || message.includes('not found')) {
        res.status(400).json({ error: message })
        return
      }
      console.error('[connector-instance] grant failed:', error)
      res.status(500).json({ error: 'Failed to create grant' })
    }
  })

  router.delete('/:instanceId/grants/:grantId', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const revoked = await opts.connectorGrantStore.revoke(userId, req.params.grantId)
    res.json({ revoked })
  })

  router.post('/:instanceId/transfer', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const parsed = TransferBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
      return
    }
    const membership = await getMembership(userId, parsed.data.workspaceId)
    if (!membership) {
      res.status(403).json({ error: 'Not a member of the target workspace' })
      return
    }
    const ceiling = effectiveReadClearance(membership.role, membership.clearance, 'confidential')
    const sensitivity = capSensitivity(parsed.data.sensitivity ?? ceiling, ceiling)
    const instance = await opts.connectorInstanceStore.transferToWorkspace(
      userId,
      req.params.instanceId,
      parsed.data.workspaceId,
      sensitivity,
    )
    if (!instance) {
      res.status(403).json({ error: 'Not the owner of this connector' })
      return
    }
    void opts.auditStore.append({
      workspaceId: parsed.data.workspaceId,
      actorUserId: userId,
      eventType: 'connector.transferred',
      subjectId: instance.id,
      details: { provider: instance.provider, label: instance.label, sensitivity },
    })
    res.json({ instance })
  })

  // Keep this after the parameterized routes: the path remains unambiguous and
  // matches the hosted API contract consumed by Studio.
  router.get('/me/grants', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const grants = await opts.connectorGrantStore.listByGrantor(userId)
    res.json({ grants })
  })

  return router
}
