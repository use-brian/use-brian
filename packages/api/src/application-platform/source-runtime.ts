/** Attended native read adapter for exact-instance protected MCP dispatch. [COMP:api/external-source-access] */
import { createHash } from 'node:crypto'
import { ContextScopeAccumulator, type ExecutionContext, type McpServerConfig } from '@use-brian/core'
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import { getAppPool, getPool, applyRLSGucs, runWithAgentAccess } from '../db/client.js'
import { getWorkspaceRoleSystem } from '../db/workspace-store.js'
import { createConnectorRuntimeAuthority } from './connector-runtime-authority.js'
import type { createConnectorActorKeyStore } from './connector-actor-keys.js'
import { createSourceAccessClient, type SourceAccessProfile } from './source-access.js'
import { bindTrustedSourceRead } from './source-store.js'
import { mergeValidatedHeaders } from '../mcp/auth-headers.js'
import { mcpToolDisplayResult } from '../mcp/client.js'

export type ConnectorSourceRuntime = {
  execution: ExecutionContext
  accumulator: ContextScopeAccumulator
  discover: (name: string) => Promise<McpServerConfig>
  call: (tool: string, input: Record<string, unknown>, overrides?: Record<string, string>) => Promise<unknown>
  assertCurrent: () => Promise<void>
}
export type ConnectorSourceRuntimeFactory = (input: { workspaceId: string; instanceId: string;
  execution?: ExecutionContext; accumulator?: ContextScopeAccumulator; headers: Record<string, string> }) => Promise<ConnectorSourceRuntime | null>
type ProfileRow = { id: string; revision: string; status: string; issuer: string; audience: string; tenant: string;
  source_base_url: string; mcp_url: string; http_read_path: string | null }
function unavailable(): never { throw new SourceProtocolError('source_unavailable') }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** No key generation or readiness override. Product setup cannot qualify a profile before the P1-P4 barrier. */
export function createConnectorSourceRuntimeFactory(options: { issuer: string; keys?: ReturnType<typeof createConnectorActorKeyStore>;
  instances: ConnectorInstanceStore }): ConnectorSourceRuntimeFactory {
  return async input => {
    input = { ...input, headers: { ...input.headers } }
    const rows = (await getPool().query<ProfileRow>(`SELECT id,revision::text,status,issuer,audience,tenant,source_base_url,mcp_url,http_read_path
      FROM connector_source_profiles WHERE workspace_id=$1 AND original_connector_instance_id=$2 ORDER BY created_at,id`, [input.workspaceId,input.instanceId])).rows
    if (rows.length === 0) return null
    const live = rows.filter(row => row.status !== 'revoked'), profile = live[0]
    if (live.length !== 1 || profile.status !== 'qualified' || profile.issuer !== options.issuer) unavailable()
    const keys = options.keys
    if (!keys) unavailable()
    const execution = input.execution, accumulator = input.accumulator
    if (!execution || !(accumulator instanceof ContextScopeAccumulator) || execution.identity.kind !== 'attended'
      || execution.identity.principal.kind !== 'workspace_member' || execution.security.access.workspaceId !== input.workspaceId
      || execution.ownership.kind !== 'workspace' || execution.ownership.workspaceId !== input.workspaceId
      || await getWorkspaceRoleSystem(execution.security.access.userId, input.workspaceId, true) === null) unavailable()
    const authenticationKind = execution.identity.principal.authenticationKind
    if (authenticationKind !== 'native_session' && authenticationKind !== 'verified_channel') unavailable()
    const native = await createConnectorRuntimeAuthority({ workspaceId: input.workspaceId, initiatingUserId: execution.security.access.userId,
      assistantId: execution.assistant.id })
    const initialInstance = await options.instances.getSystem(input.instanceId), credentials = await options.instances.getAuthCredentialsSystem(input.instanceId)
    if (!initialInstance || initialInstance.url !== profile.mcp_url || !initialInstance.connected || initialInstance.healthStatus === 'auth_failed'
      || !credentials || !['bearer','custom_header'].includes(credentials.type)) unavailable()
    const instanceState = (row: NonNullable<typeof initialInstance>) => fingerprint([row.id,row.workspaceId,row.userId,row.scope,row.url,row.config,
      row.connected,row.healthStatus === 'auth_failed',row.sensitivity,row.compartments,row.projectIds])
    const initialState = instanceState(initialInstance), credentialState = fingerprint(credentials), initialProfile = fingerprint(profile)
    const readExposure = async (instance: NonNullable<typeof initialInstance>) => {
      if (instance.scope === 'workspace') return instance.workspaceId === input.workspaceId
        ? { id: instance.id, compartments: instance.compartments, projectIds: instance.projectIds } : null
      return (await getPool().query<{ id: string; compartments: string[]; projectIds: string[]; grantedBy: string }>(`SELECT id,compartments,project_ids AS "projectIds",granted_by_user_id AS "grantedBy" FROM connector_grant
        WHERE connector_instance_id=$1 AND target_type='workspace' AND target_id=$2`, [input.instanceId,input.workspaceId])).rows[0] ?? null
    }
    const initialExposure = await readExposure(initialInstance), exposureState = fingerprint(initialExposure)
    if (!initialExposure || !native.allows(initialExposure)) unavailable()
    let invalid = false
    const assertCurrent = async () => {
      if (invalid) unavailable()
      try {
        await execution.security.authority.assertCurrent(); await native.assertCurrent()
        const current = (await getPool().query<ProfileRow>(`SELECT id,revision::text,status,issuer,audience,tenant,source_base_url,mcp_url,http_read_path
          FROM connector_source_profiles WHERE id=$1 AND workspace_id=$2 AND connector_instance_id=$3`, [profile.id,input.workspaceId,input.instanceId])).rows[0]
        const instance = await options.instances.getSystem(input.instanceId), auth = await options.instances.getAuthCredentialsSystem(input.instanceId)
        if (!current || fingerprint(current) !== initialProfile || !instance || instanceState(instance) !== initialState || fingerprint(auth) !== credentialState
          || execution.lifecycle.abortSignal.aborted) unavailable()
        // The current exposure carries target labels; personal-instance source labels do not replace that release.
        const binding = await readExposure(instance)
        if (!binding || fingerprint(binding) !== exposureState || !native.allows(binding)) unavailable()
      } catch { invalid = true; unavailable() }
    }
    await assertCurrent()
    const binding: SourceAccessProfile = { issuer: profile.issuer, audience: profile.audience, workspaceId: input.workspaceId,
      connectorInstanceId: input.instanceId, sourceBaseUrl: profile.source_base_url, mcpUrl: profile.mcp_url,
      ...(profile.http_read_path ? { httpReadPath: profile.http_read_path } : {}), tenant: profile.tenant, bindingRevision: profile.revision,
      subject: { kind: 'human', id: execution.security.access.userId, executingAssistantId: execution.assistant.id } }
    const ports = { ...keys, admit: async () => { await assertCurrent(); return { bindingRevision: profile.revision,
      actor: { kind: 'human' as const, userId: execution.security.access.userId, authenticationKind } } } }
    const client = (overrides?: Record<string, string>) => createSourceAccessClient(execution, binding, ports, { headers: mergeValidatedHeaders(input.headers, overrides) ?? {} })
    const discover = async (name: string, overrides?: Record<string, string>) => {
      await assertCurrent()
      const catalog = await client(overrides).discoverMcp(name)
      await assertCurrent()
      return { ...catalog, tools: catalog.tools.filter(tool => tool.readOnlyHint === true) }
    }
    return { execution, accumulator, assertCurrent, discover,
      async call(tool, args, overrides) {
        const catalog = await discover('Protected source', overrides)
        if (!catalog.tools.some(candidate => candidate.name === tool)) unavailable()
        const read = await client(overrides).readMcp(tool, args)
        await assertCurrent()
        const transaction = await getAppPool().connect()
        try {
          await transaction.query('BEGIN')
          const bound = await runWithAgentAccess(execution.security.access, async () => {
            await applyRLSGucs(transaction, execution.security.access.userId)
            return bindTrustedSourceRead(transaction, execution, read, accumulator)
          })
          await assertCurrent(); await transaction.query('COMMIT'); await assertCurrent()
          return mcpToolDisplayResult(bound.result)
        } catch (error) { await transaction.query('ROLLBACK').catch(() => {}); throw error }
        finally { transaction.release() }
      },
    }
  }
}
