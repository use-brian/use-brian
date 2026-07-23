/**
 * OSS ingestion control plane for Studio's Ingestion page.
 *
 * [COMP:api/ingest-route]
 */
import { Router } from 'express'
import { z } from 'zod'
import type { IngestSourceProvider } from '@use-brian/core'
import { OFFICIAL_CONNECTORS } from '@use-brian/shared'
import { listUsableWorkspaceConnectors } from '../connectors/usable-connectors.js'
import type {
  ConnectorInstance,
  ConnectorInstanceStore,
  ConnectorScope,
} from '../db/connector-instance-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import { createIngestRuleEditorStore } from '../db/ingest-rules-editor-store.js'
import type { IngestRuleRow, IngestRulesStore } from '../db/ingest-rules-store.js'
import type { IngestExternalSink, IngestSinkStore } from '../db/ingest-sink-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import { listAffiliatedRepos } from '../github/client.js'

type Options = {
  connectorInstanceStore: ConnectorInstanceStore
  ingestRulesStore: IngestRulesStore
  workspaceStore: WorkspaceStore
  connectorGrantStore: ConnectorGrantStore
  ingestSinkStore: IngestSinkStore
}

const PROVIDER_TO_SOURCE: Record<string, IngestSourceProvider> = {
  gcal: 'calendar',
  github: 'github',
  fathom: 'fathom',
  slack: 'slack',
  whatsapp: 'whatsapp',
  imap: 'imap',
  shopify: 'shopify',
}

type IngestNature = 'noisy' | 'events' | 'signal'

const PROVIDER_NATURE: Record<string, IngestNature> = {
  gcal: 'events',
  github: 'events',
  fathom: 'signal',
  slack: 'noisy',
  whatsapp: 'noisy',
  imap: 'noisy',
  shopify: 'events',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const saveReposBody = z.object({
  repos: z.array(z.string().min(1).max(200)).max(200),
  orgs: z.array(z.string().min(1).max(200)).max(200).optional(),
})

const routingModeSchema = z.enum(['realtime', 'scheduled', 'drop'])
const sensitivitySchema = z.enum(['public', 'internal', 'confidential'])
const filterParamsSchema = z.record(z.unknown())
const addRuleBody = z.object({
  filterType: z.string().min(1).max(64),
  filterParams: filterParamsSchema.optional(),
  routingMode: routingModeSchema,
  routingSchedule: z.string().min(1).nullable().optional(),
  routingTimezone: z.string().min(1).max(64).optional(),
  alert: z.boolean().optional(),
  episodeSensitivity: sensitivitySchema.nullable().optional(),
  ruleOrder: z.number().int().min(0).optional(),
})
const patchRuleBody = addRuleBody.partial().refine((patch) => Object.keys(patch).length > 0, {
  message: 'Body must include at least one field to update',
})

const sinkUrlSchema = z.string().url().refine(
  (url) => url.startsWith('https://') || url.startsWith('http://'),
  { message: 'endpointUrl must be an http(s) URL' },
)
const createSinkBody = z.object({
  workspaceId: z.string().uuid(),
  endpointUrl: sinkUrlSchema,
  authKind: z.enum(['bearer', 'hmac']),
  secret: z.string().min(16, 'secret must be at least 16 characters'),
  mode: z.enum(['all', 'rule_filtered']).optional(),
  enabled: z.boolean().optional(),
})
const patchSinkBody = createSinkBody.omit({ workspaceId: true }).partial().refine(
  (patch) => Object.keys(patch).length > 0,
  { message: 'Body must include at least one field to update' },
)

function toRuleDto(rule: IngestRuleRow) {
  return {
    id: rule.id,
    ruleOrder: rule.ruleOrder,
    filterType: rule.filterType,
    filterParams: rule.filterParams,
    routingMode: rule.routingMode,
    routingSchedule: rule.routingSchedule,
    routingTimezone: rule.routingTimezone,
    alert: rule.alert,
    episodeSensitivity: rule.episodeSensitivity,
  }
}

function ingestsIntoWorkspace(
  instance: ConnectorInstance,
  workspaceId: string,
  ownedPersonal: boolean,
): boolean {
  if (!instance.ingestionEnabled) return false
  if (instance.scope === 'workspace') return instance.workspaceId === workspaceId
  if (instance.ingestWorkspaceId) return instance.ingestWorkspaceId === workspaceId
  return ownedPersonal
}

function toSourceDto(
  instance: ConnectorInstance,
  source: IngestSourceProvider,
  rules: IngestRuleRow[],
  workspaceName: string | null,
  workspaceId: string,
  ownedPersonal: boolean,
) {
  return {
    instanceId: instance.id,
    provider: instance.provider,
    source,
    nature: PROVIDER_NATURE[instance.provider] ?? 'events',
    scope: instance.scope as ConnectorScope,
    workspaceName,
    sensitivity: instance.sensitivity,
    label: instance.label,
    connectedEmail: instance.connectedEmail,
    connected: instance.connected,
    ingestionEnabled: ingestsIntoWorkspace(instance, workspaceId, ownedPersonal),
    ingestTargetWorkspaceId: instance.ingestWorkspaceId,
    rules: rules.map(toRuleDto),
  }
}

function toSinkDto(sink: IngestExternalSink) {
  return {
    id: sink.id,
    connectorInstanceId: sink.connectorInstanceId,
    workspaceId: sink.workspaceId,
    endpointUrl: sink.endpointUrl,
    authKind: sink.authKind,
    mode: sink.mode,
    enabled: sink.enabled,
    hasSecret: sink.hasSecret,
    lastAckCursor: sink.lastAckCursor,
    lastDeliveredAt: sink.lastDeliveredAt,
    createdAt: sink.createdAt,
  }
}

export function ingestRoutes(opts: Options): Router {
  const router = Router()
  const ruleEditor = createIngestRuleEditorStore()

  router.get('/sources', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : ''
    if (!UUID_RE.test(workspaceId)) {
      return void res.status(400).json({ error: 'workspaceId is required' })
    }

    try {
      const workspace = await opts.workspaceStore.get(userId, workspaceId)
      if (!workspace) return void res.status(404).json({ error: 'Workspace not found' })
      const ownedPersonal = workspace.isPersonal === true && workspace.ownerUserId === userId
      const usable = await listUsableWorkspaceConnectors({
        connectorInstanceStore: opts.connectorInstanceStore,
        connectorGrantStore: opts.connectorGrantStore,
        userId,
        workspaceId,
      })
      const ingestible = usable.filter(({ instance }) => PROVIDER_TO_SOURCE[instance.provider])
      const rules = await opts.ingestRulesStore.listByConnectorInstances(
        userId,
        ingestible.map(({ instance }) => instance.id),
      )
      const rulesByInstance = new Map<string, IngestRuleRow[]>()
      for (const rule of rules) {
        const existing = rulesByInstance.get(rule.connectorInstanceId)
        if (existing) existing.push(rule)
        else rulesByInstance.set(rule.connectorInstanceId, [rule])
      }
      const sources = ingestible.map(({ instance }) => toSourceDto(
        instance,
        PROVIDER_TO_SOURCE[instance.provider],
        rulesByInstance.get(instance.id) ?? [],
        instance.scope === 'workspace' ? workspace.name : null,
        workspaceId,
        ownedPersonal,
      ))
      const present = new Set(ingestible.map(({ instance }) => instance.provider))
      const available = Object.keys(PROVIDER_TO_SOURCE)
        .filter((provider) => !new Set(['slack', 'whatsapp']).has(provider) && !present.has(provider))
        .map((provider) => ({
          provider,
          source: PROVIDER_TO_SOURCE[provider],
          name: OFFICIAL_CONNECTORS.find((connector) => connector.id === provider)?.name ?? provider,
          nature: PROVIDER_NATURE[provider] ?? 'events',
        }))
      res.json({ sources, available, ownedPersonal })
    } catch (err) {
      console.error('[ingest] list sources failed:', err)
      res.status(500).json({ error: 'Failed to load ingestion sources' })
    }
  })

  router.post('/sources/:instanceId/enable', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { instanceId } = req.params
    if (!UUID_RE.test(instanceId)) return void res.status(404).json({ error: 'Connector not found' })
    const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : ''
    if (!UUID_RE.test(workspaceId)) {
      return void res.status(400).json({ error: 'workspaceId is required' })
    }

    try {
      const workspace = await opts.workspaceStore.get(userId, workspaceId)
      if (!workspace) return void res.status(404).json({ error: 'Workspace not found' })
      const instance = await opts.connectorInstanceStore.get(userId, instanceId)
      if (!instance) return void res.status(404).json({ error: 'Connector not found' })
      const source = PROVIDER_TO_SOURCE[instance.provider]
      if (!source) {
        return void res.status(400).json({ error: 'This connector does not support ingestion' })
      }
      if (!instance.connected) {
        return void res.status(400).json({ error: 'Connect this source before enabling ingestion' })
      }
      const usable = await listUsableWorkspaceConnectors({
        connectorInstanceStore: opts.connectorInstanceStore,
        connectorGrantStore: opts.connectorGrantStore,
        userId,
        workspaceId,
      })
      if (!usable.some(({ instance: candidate }) => candidate.id === instanceId)) {
        return void res.status(403).json({ error: 'This connector is not available in this workspace' })
      }
      if (instance.scope === 'workspace' && instance.workspaceId !== workspaceId) {
        return void res.status(400).json({ error: 'This workspace connector can only ingest into its own workspace' })
      }
      await opts.ingestRulesStore.seedDefaults(userId, instanceId, source)
      const updated = await opts.connectorInstanceStore.update(userId, instanceId, {
        ingestionEnabled: true,
        ...(instance.scope === 'user' ? { ingestWorkspaceId: workspaceId } : {}),
      })
      const rules = await opts.ingestRulesStore.listByConnectorInstance(userId, instanceId)
      const ownedPersonal = workspace.isPersonal === true && workspace.ownerUserId === userId
      res.json({
        source: toSourceDto(
          updated ?? instance,
          source,
          rules,
          instance.scope === 'workspace' ? workspace.name : null,
          workspaceId,
          ownedPersonal,
        ),
      })
    } catch (err) {
      console.error('[ingest] enable failed:', err)
      res.status(500).json({ error: 'Failed to enable ingestion' })
    }
  })

  router.post('/sources/:instanceId/disable', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { instanceId } = req.params
    if (!UUID_RE.test(instanceId)) return void res.status(404).json({ error: 'Connector not found' })
    const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : ''
    if (!UUID_RE.test(workspaceId)) {
      return void res.status(400).json({ error: 'workspaceId is required' })
    }

    try {
      const workspace = await opts.workspaceStore.get(userId, workspaceId)
      if (!workspace) return void res.status(404).json({ error: 'Workspace not found' })
      const instance = await opts.connectorInstanceStore.get(userId, instanceId)
      if (!instance) return void res.status(404).json({ error: 'Connector not found' })
      const source = PROVIDER_TO_SOURCE[instance.provider]
      if (!source) {
        return void res.status(400).json({ error: 'This connector does not support ingestion' })
      }
      const updated = await opts.connectorInstanceStore.update(userId, instanceId, {
        ingestionEnabled: false,
        ...(instance.scope === 'user' ? { ingestWorkspaceId: null } : {}),
      })
      const rules = await opts.ingestRulesStore.listByConnectorInstance(userId, instanceId)
      const ownedPersonal = workspace.isPersonal === true && workspace.ownerUserId === userId
      res.json({
        source: toSourceDto(
          updated ?? instance,
          source,
          rules,
          instance.scope === 'workspace' ? workspace.name : null,
          workspaceId,
          ownedPersonal,
        ),
      })
    } catch (err) {
      console.error('[ingest] disable failed:', err)
      res.status(500).json({ error: 'Failed to disable ingestion' })
    }
  })

  router.get('/sources/:instanceId/github/repos', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { instanceId } = req.params
    if (!UUID_RE.test(instanceId)) {
      return void res.status(404).json({ error: 'GitHub connector not found' })
    }
    try {
      const instance = await opts.connectorInstanceStore.get(userId, instanceId)
      if (!instance || instance.provider !== 'github') {
        return void res.status(404).json({ error: 'GitHub connector not found' })
      }
      const credentials = await opts.connectorInstanceStore.getCredentials(userId, instanceId)
      if (!credentials?.client_secret) {
        return void res.status(400).json({ error: 'Reconnect this GitHub connector first' })
      }
      const repos = await listAffiliatedRepos(credentials.client_secret)
      const config = instance.config as { repos?: string[]; orgs?: string[] }
      const orgCounts = new Map<string, number>()
      for (const repo of repos) {
        if (repo.owner?.type === 'Organization' && repo.owner.login) {
          orgCounts.set(repo.owner.login, (orgCounts.get(repo.owner.login) ?? 0) + 1)
        }
      }
      res.json({
        available: repos.map((repo) => ({
          fullName: repo.full_name,
          private: repo.private,
          description: repo.description,
          ownerLogin: repo.owner?.login ?? null,
          ownerType: repo.owner?.type ?? null,
        })),
        orgs: [...orgCounts].map(([login, repoCount]) => ({ login, repoCount })),
        selected: config.repos ?? [],
        selectedOrgs: config.orgs ?? [],
      })
    } catch (err) {
      console.error('[ingest] github repo list failed:', err)
      res.status(502).json({ error: 'Could not reach GitHub' })
    }
  })

  router.put('/sources/:instanceId/github/repos', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { instanceId } = req.params
    if (!UUID_RE.test(instanceId)) {
      return void res.status(404).json({ error: 'GitHub connector not found' })
    }
    const parsed = saveReposBody.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid body' })
    try {
      const instance = await opts.connectorInstanceStore.get(userId, instanceId)
      if (!instance || instance.provider !== 'github') {
        return void res.status(404).json({ error: 'GitHub connector not found' })
      }
      const orgs = parsed.data.orgs ?? []
      await opts.connectorInstanceStore.setConfig(userId, instanceId, {
        repos: parsed.data.repos,
        orgs,
      })
      res.json({ selected: parsed.data.repos, selectedOrgs: orgs })
    } catch (err) {
      console.error('[ingest] github repo save failed:', err)
      res.status(500).json({ error: 'Failed to save repositories' })
    }
  })

  router.post('/sources/:instanceId/rules', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { instanceId } = req.params
    if (!UUID_RE.test(instanceId)) return void res.status(404).json({ error: 'Connector not found' })
    const parsed = addRuleBody.safeParse(req.body)
    if (!parsed.success) {
      return void res.status(400).json({ error: 'Invalid body', detail: parsed.error.flatten() })
    }
    try {
      const rule = await ruleEditor.addRule(userId, {
        connectorInstanceId: instanceId,
        filterType: parsed.data.filterType,
        filterParams: parsed.data.filterParams ?? {},
        routingMode: parsed.data.routingMode,
        routingSchedule: parsed.data.routingSchedule ?? null,
        routingTimezone: parsed.data.routingTimezone,
        alert: parsed.data.alert,
        episodeSensitivity: parsed.data.episodeSensitivity ?? null,
        ruleOrder: parsed.data.ruleOrder,
      })
      res.status(201).json({ rule })
    } catch (err) {
      const message = (err as Error).message
      if (message.toLowerCase().includes('not visible')) {
        return void res.status(404).json({ error: 'Connector not found' })
      }
      if (message.startsWith('addIngestRule:')) return void res.status(400).json({ error: message })
      console.error('[ingest] add rule failed:', err)
      res.status(500).json({ error: 'Failed to add rule' })
    }
  })

  router.patch('/rules/:ruleId', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { ruleId } = req.params
    if (!UUID_RE.test(ruleId)) return void res.status(404).json({ error: 'Rule not found' })
    const parsed = patchRuleBody.safeParse(req.body)
    if (!parsed.success) {
      return void res.status(400).json({ error: 'Invalid body', detail: parsed.error.flatten() })
    }
    try {
      const rule = await ruleEditor.updateRule(userId, { ruleId, patch: parsed.data })
      res.json({ rule })
    } catch (err) {
      const message = (err as Error).message
      if (message.toLowerCase().includes('not visible')) {
        return void res.status(404).json({ error: 'Rule not found' })
      }
      if (message.startsWith('updateIngestRule:')) return void res.status(400).json({ error: message })
      console.error('[ingest] patch rule failed:', err)
      res.status(500).json({ error: 'Failed to update rule' })
    }
  })

  router.delete('/rules/:ruleId', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { ruleId } = req.params
    if (!UUID_RE.test(ruleId)) return void res.status(404).json({ error: 'Rule not found' })
    try {
      await ruleEditor.deleteRule(userId, ruleId)
      res.status(204).end()
    } catch (err) {
      if ((err as Error).message.toLowerCase().includes('not visible')) {
        return void res.status(404).json({ error: 'Rule not found' })
      }
      console.error('[ingest] delete rule failed:', err)
      res.status(500).json({ error: 'Failed to delete rule' })
    }
  })

  const visibleInstance = (userId: string, instanceId: string) =>
    UUID_RE.test(instanceId) ? opts.connectorInstanceStore.get(userId, instanceId) : Promise.resolve(null)

  router.get('/sources/:instanceId/sinks', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    try {
      const instance = await visibleInstance(userId, req.params.instanceId)
      if (!instance) return void res.status(404).json({ error: 'Connector not found' })
      const sinks = await opts.ingestSinkStore.listByInstance(instance.id)
      res.json({ sinks: sinks.map(toSinkDto) })
    } catch (err) {
      console.error('[ingest] list sinks failed:', err)
      res.status(500).json({ error: 'Failed to list sinks' })
    }
  })

  router.post('/sources/:instanceId/sinks', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const parsed = createSinkBody.safeParse(req.body)
    if (!parsed.success) {
      return void res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' })
    }
    try {
      const instance = await visibleInstance(userId, req.params.instanceId)
      if (!instance) return void res.status(404).json({ error: 'Connector not found' })
      const workspace = await opts.workspaceStore.get(userId, parsed.data.workspaceId)
      if (!workspace) return void res.status(404).json({ error: 'Workspace not found' })
      if (instance.scope === 'workspace' && instance.workspaceId !== parsed.data.workspaceId) {
        return void res.status(400).json({ error: 'This workspace connector can only feed sinks in its own workspace' })
      }
      const sink = await opts.ingestSinkStore.create({
        connectorInstanceId: instance.id,
        ...parsed.data,
      })
      res.status(201).json({ sink: toSinkDto(sink) })
    } catch (err) {
      if ((err as Error).message.includes('CHANNEL_CREDENTIAL_KEY')) {
        return void res.status(503).json({ error: 'Sink secrets are unavailable: server credential key not configured' })
      }
      console.error('[ingest] create sink failed:', err)
      res.status(500).json({ error: 'Failed to create sink' })
    }
  })

  router.patch('/sinks/:sinkId', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { sinkId } = req.params
    if (!UUID_RE.test(sinkId)) return void res.status(404).json({ error: 'Sink not found' })
    const parsed = patchSinkBody.safeParse(req.body)
    if (!parsed.success) {
      return void res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' })
    }
    try {
      const existing = await opts.ingestSinkStore.get(sinkId)
      const instance = existing
        ? await visibleInstance(userId, existing.connectorInstanceId)
        : null
      if (!existing || !instance) return void res.status(404).json({ error: 'Sink not found' })
      const sink = await opts.ingestSinkStore.update(sinkId, parsed.data)
      res.json({ sink: sink ? toSinkDto(sink) : null })
    } catch (err) {
      if ((err as Error).message.includes('CHANNEL_CREDENTIAL_KEY')) {
        return void res.status(503).json({ error: 'Sink secrets are unavailable: server credential key not configured' })
      }
      console.error('[ingest] patch sink failed:', err)
      res.status(500).json({ error: 'Failed to update sink' })
    }
  })

  router.delete('/sinks/:sinkId', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { sinkId } = req.params
    if (!UUID_RE.test(sinkId)) return void res.status(404).json({ error: 'Sink not found' })
    try {
      const existing = await opts.ingestSinkStore.get(sinkId)
      const instance = existing
        ? await visibleInstance(userId, existing.connectorInstanceId)
        : null
      if (!existing || !instance) return void res.status(404).json({ error: 'Sink not found' })
      await opts.ingestSinkStore.remove(sinkId)
      res.status(204).end()
    } catch (err) {
      console.error('[ingest] delete sink failed:', err)
      res.status(500).json({ error: 'Failed to delete sink' })
    }
  })

  return router
}
