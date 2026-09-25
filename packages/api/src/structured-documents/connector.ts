import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'
import { classifyTool, defaultPolicy, type FilesContext, type McpSettingsStore } from '@use-brian/core'
import { APP_LEVEL_ASSISTANT_ID } from '@use-brian/shared'
import { createConnectorInstanceStore, connectorInstanceGovernanceId, type ConnectorInstanceStore, type ConnectorInstance } from '../db/connector-instance-store.js'
import { createConnectorGrantStore, type ConnectorGrantStore } from '../db/connector-grant-store.js'
import { createDbAssistantConnectorStore, type AssistantConnectorStore } from '../db/assistant-connector-store.js'
import { createDbMcpSettingsStore } from '../db/mcp-settings-store.js'
import { createWorkspaceToolPolicyStore, workspacePolicyAsSettingsStore, type WorkspaceToolPolicyStore } from '../db/workspace-tool-policy-store.js'
import { loadChannelCredentialKey } from '../db/channel-integrations.js'
import { connectorExposureAllowed } from '../context-scope/connector-exposure.js'
import { createStructuredOcrClient, StructuredOcrError, type StructuredOcrClient } from './client.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const ConnectorBindingSchema = z.object({
  connectorInstanceId: z.string().min(1), endpointHash: digest,
  credentialFingerprint: digest, policyFingerprint: digest,
  protocol: z.literal('ocr-evidence/1'),
}).strict()
export type ConnectorBinding = z.infer<typeof ConnectorBindingSchema>
export type StructuredOcrConnectorResolver = {
  list(ctx: FilesContext): Promise<{ connectorInstanceId: string; label: string }[]>
  resolve(ctx: FilesContext, sourceFileId: string, connectorInstanceId: string, expected?: ConnectorBinding): Promise<{ client: StructuredOcrClient; binding: ConnectorBinding; label: string }>
}

// These ASK operations are authorized ONLY by the service's explicit, always-
// policy-authorized document start contract (upload/start/status/export/page retrieval).
// Capabilities runs during preflight and must have an effective ALLOW.
const tools = ['ocr_capabilities', 'ocr_start', 'ocr_status', 'ocr_records', 'ocr_source_page'] as const
export type StructuredOcrConnectorResolverOptions = {
  instanceStore?: Pick<ConnectorInstanceStore, 'listByWorkspaceSystem' | 'getAuthCredentialsSystem'>
  grantStore?: Pick<ConnectorGrantStore, 'listForTargetSystem'>
  assistantStore?: Pick<AssistantConnectorStore, 'isEnabled'>
  settingsStore?: McpSettingsStore
  workspacePolicyStore?: WorkspaceToolPolicyStore
  createClient?: (config: { baseUrl: string; token: string; scope: string }) => StructuredOcrClient
}
const fail = (code: string): never => { throw new StructuredOcrError(code) }
const safeLabel = (label: string) => label.replace(/[\p{Cc}\p{Cf}<>]/gu, '').trim().slice(0, 100) || 'OCR connector'

/** Context must be freshly authorized by the native Files service, not model input.
 * In particular undefined scope axes are not accepted as implicit universe.
 * No store, credentials, discovery or policy result is cached between calls.
 */
export function createStructuredOcrConnectorResolver(options: StructuredOcrConnectorResolverOptions = {}): StructuredOcrConnectorResolver {
  const instances = options.instanceStore ?? createConnectorInstanceStore(
    process.env.CHANNEL_CREDENTIAL_KEY ? loadChannelCredentialKey(process.env.CHANNEL_CREDENTIAL_KEY) : null,
  )
  const grants = options.grantStore ?? createConnectorGrantStore()
  const assistants = options.assistantStore ?? createDbAssistantConnectorStore()
  const settings = options.settingsStore ?? createDbMcpSettingsStore()
  const workspacePolicies = options.workspacePolicyStore ?? createWorkspaceToolPolicyStore()
  const clientFactory = options.createClient ?? createStructuredOcrClient

  async function candidates(ctx: FilesContext) {
    if (!ctx?.userId || !ctx.workspaceId || !ctx.assistantId ||
        ctx.compartments === undefined || ctx.projectIds === undefined ||
        ![ctx.compartments, ctx.projectIds].every(axis => axis === null || (Array.isArray(axis) && axis.every(x => typeof x === 'string')))) fail('connector_context_missing')
    const turn = { effectiveCompartments: ctx.compartments as string[] | null, effectiveProjectIds: ctx.projectIds as string[] | null }
    const [owned, exposed] = await Promise.all([
      instances.listByWorkspaceSystem(ctx.workspaceId), grants.listForTargetSystem('workspace', ctx.workspaceId),
    ])
    const rows = new Map<string, { instance: ConnectorInstance; policyUserId: string; serverName: string; store: McpSettingsStore }>()
    for (const instance of owned) {
      if (instance.scope !== 'workspace' || instance.workspaceId !== ctx.workspaceId || !connectorExposureAllowed(turn, instance)) continue
      rows.set(instance.id, { instance, policyUserId: ctx.userId, serverName: instance.provider, store: workspacePolicyAsSettingsStore(workspacePolicies, ctx.workspaceId) })
    }
    for (const grant of exposed) {
      const instance = grant.instance
      if (grant.targetType !== 'workspace' || grant.targetId !== ctx.workspaceId || grant.connectorInstanceId !== instance.id ||
          instance.scope !== 'user' || instance.userId !== grant.grantedByUserId || !grant.grantedByUserId ||
          !connectorExposureAllowed(turn, grant)) continue
      rows.set(instance.id, { instance, policyUserId: grant.grantedByUserId, serverName: instance.label, store: settings })
    }
    const eligible = [...rows.values()].filter(({ instance: i }) => i.custom && i.connected && i.healthStatus !== 'auth_failed' && i.credentialsType === 'bearer' && !!i.url)
    // Explicitly refuse oversized catalogs; never silently hide a selected ID.
    if (eligible.length > 100) fail('connector_limit_exceeded')
    const enabled = [] as typeof eligible
    for (const row of eligible) {
      if (await assistants.isEnabled(ctx.assistantId!, connectorInstanceGovernanceId(row.instance.provider, row.instance.id), row.instance.provider)) enabled.push(row)
    }
    return enabled
  }
  async function protect<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() } catch (error) {
      if (error instanceof StructuredOcrError) throw error
      return fail('connector_unavailable')
    }
  }
  return {
    list: ctx => protect(async () => (await candidates(ctx)).map(({ instance }) => ({ connectorInstanceId: instance.id, label: safeLabel(instance.label) }))),
    resolve: (ctx, sourceFileId, connectorInstanceId, expected) => protect(async () => {
      if (!sourceFileId || !connectorInstanceId) fail('connector_context_missing')
      const row = (await candidates(ctx)).find(row => row.instance.id === connectorInstanceId)
      if (!row) return fail('connector_unavailable')
      const decisions = []
      for (const toolName of tools) {
        const fallback = defaultPolicy(classifyTool(toolName))
        const lookup = { userId: row.policyUserId, serverName: row.serverName, toolName }
        const l1 = (await row.store.getPolicy({ ...lookup, assistantId: APP_LEVEL_ASSISTANT_ID }))?.policy ?? fallback
        const l2 = (await row.store.getPolicy({ ...lookup, assistantId: ctx.assistantId! }))?.policy ?? fallback
        if (![l1, l2].every(p => p === 'allow' || p === 'ask' || p === 'block')) fail('connector_policy_blocked')
        const effective = l1 === 'block' || l2 === 'block' ? 'block' : l1 === 'ask' || l2 === 'ask' ? 'ask' : 'allow'
        if (effective === 'block') fail('connector_policy_blocked')
        if (toolName === 'ocr_capabilities' && effective !== 'allow') fail('connector_health_approval_required')
        decisions.push({ toolName, l1, l2, effective })
      }
      const credentials = await instances.getAuthCredentialsSystem(connectorInstanceId)
      if (credentials?.type !== 'bearer' || !/^[\x21-\x7e]{1,4096}$/.test(credentials.token)) return fail('connector_unavailable')
      const token = credentials.token
      const binding: ConnectorBinding = {
        connectorInstanceId, endpointHash: hash(row.instance.url!), credentialFingerprint: hash(token),
        policyFingerprint: hash(JSON.stringify({ principal: row.policyUserId, server: row.serverName, workspaceOwned: row.instance.scope === 'workspace', decisions })),
        protocol: 'ocr-evidence/1',
      }
      if (expected !== undefined) {
        const parsed = ConnectorBindingSchema.safeParse(expected)
        if (!parsed.success || Object.keys(binding).some(key => binding[key as keyof ConnectorBinding] !== parsed.data[key as keyof ConnectorBinding])) fail('connector_binding_changed')
      }
      // Fixed key order is the canonical scope serialization. Never persist it.
      const scope = createHmac('sha256', token).update(JSON.stringify({ connectorInstanceId, userId: ctx.userId, workspaceId: ctx.workspaceId, assistantId: ctx.assistantId, sourceFileId })).digest('hex')
      const client = clientFactory({ baseUrl: row.instance.url!, token, scope })
      return { client, binding, label: safeLabel(row.instance.label) }
    }),
  }
}
