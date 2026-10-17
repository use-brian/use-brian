/** Canonical module dispatcher and atomic command receipts. [COMP:api/application-records] */
import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { defineApplicationModules, type ApplicationModuleDefinition, type ApplicationOperationContext,
  type ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError, WORKSPACE_MODULES, applicationCommandSchema, applicationResourceRefSchema,
  type ApplicationCommand, type ApplicationOperationReceipt, type ApplicationResourceRef,
  type WorkspaceModuleRegistry } from '@use-brian/shared'
import { applyRLSGucs, getAppPool, rollbackAndRelease } from '../db/client.js'
import { runWithAgentAccess } from '../db/agent-access-context.js'
import { lockWorkspaceModule, requireWorkspaceModuleAdmission } from '../db/workspace-modules-store.js'
import { applyApplicationSchema, previewApplicationSchema } from './schema-changes.js'
import type { PropertyDef } from '@use-brian/core'

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
}
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')

export class ApplicationPlatformService {
  readonly registry: ReturnType<typeof defineApplicationModules<PoolClient>>
  constructor(modules: readonly ApplicationModuleDefinition<PoolClient>[],
    private readonly pool: Pool = getAppPool(), existing: WorkspaceModuleRegistry = WORKSPACE_MODULES) {
    this.registry = defineApplicationModules(modules, existing)
  }

  private module(key: string) {
    const module = this.registry.applications.get(key)
    if (!module) throw new ApplicationPlatformError('operation_not_available', 'The operation is unavailable.')
    return module
  }

  previewSchema(execution: ExecutionContext, typeId: string, expectedVersion: number, properties: PropertyDef[]) {
    return this.transaction(execution, client => previewApplicationSchema(client,execution,typeId,expectedVersion,properties))
  }

  applySchema(execution: ExecutionContext, previewId: string) {
    return this.transaction(execution, client => applyApplicationSchema(client,execution,previewId), true)
  }

  private async transaction<T>(execution: ExecutionContext, operation: (client: PoolClient, afterCommit: (effect: () => void) => void) => Promise<T>, effectful = false): Promise<T> {
    if (execution.ownership.kind !== 'workspace' || execution.ownership.workspaceId !== execution.security.access.workspaceId
      || execution.lifecycle.abortSignal.aborted) throw new ApplicationPlatformError('access_unavailable', 'The application is unavailable.')
    await execution.security.authority.assertCurrent()
    return runWithAgentAccess(execution.security.access, async () => {
      const client = await this.pool.connect()
      const effects: Array<() => void> = []
      let commitStarted = false
      try {
        await client.query('BEGIN')
        const role = await client.query(`SELECT r.rolsuper OR r.rolbypassrls OR c.relowner=r.oid AS bypass
          FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='entity_instances'::regclass WHERE r.rolname=current_user`)
        if (role.rows[0]?.bypass !== false) throw new ApplicationPlatformError('access_unavailable', 'A non-owner application role is required.')
        await applyRLSGucs(client, execution.security.access.userId)
        // P1 admits existing members only. P2's explicit application-grant adapter
        // adds non-member admission through enforced app-role policies, never an owner.
        const member = await client.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',
          [execution.security.access.workspaceId, execution.security.access.userId])
        if (!member.rows[0]) throw new ApplicationPlatformError('access_unavailable', 'The application is unavailable.')
        const value = await operation(client, effect => effects.push(effect))
        await execution.security.authority.assertCurrent()
        if (execution.lifecycle.abortSignal.aborted) throw new ApplicationPlatformError('access_unavailable', 'The operation was cancelled.')
        commitStarted = true
        await client.query('COMMIT')
        for (const effect of effects) {
          try { effect() } catch { console.warn('[application-platform] post-commit projection failed') }
        }
        return value
      } catch (error) {
        if (commitStarted && effectful) throw new ApplicationPlatformError('outcome_uncertain', 'Reconcile the saved operation before retrying.', 'uncertain')
        if (!(error instanceof ApplicationPlatformError)) {
          const code = (error as { code?: string })?.code
          if (code === '23505' || code === '40001' || code === '40P01') {
            throw new ApplicationPlatformError('record_version_conflict', 'The record or its declared uniqueness changed. Refresh before retrying.')
          }
          if (code === '22023' || code === '23514' || code === '22P02') {
            throw new ApplicationPlatformError('invalid_value', 'The declared operation constraints were not satisfied.')
          }
          if (code === '42501') throw new ApplicationPlatformError('access_unavailable', 'The operation is unavailable.')
        }
        throw error
      } finally { await rollbackAndRelease(client) }
    })
  }

  async query(execution: ExecutionContext, moduleKey: string, queryKey: string, rawInput: unknown): Promise<unknown> {
    const module = this.module(moduleKey), query = module.queries[queryKey]
    if (!query) throw new ApplicationPlatformError('operation_not_available', 'The operation is unavailable.')
    const parsed = query.input.safeParse(rawInput)
    if (!parsed.success) throw new ApplicationPlatformError('invalid_value', 'The query input is invalid.')
    return this.transaction(execution, async (transaction, afterCommit) => {
      const context = { execution, transaction, idempotencyKey: '', afterCommit }
      const state = await lockWorkspaceModule(transaction, execution.security.access.workspaceId, moduleKey, this.registry.workspaceModules)
      requireWorkspaceModuleAdmission(state, 'read')
      await query.authorize(context, parsed.data)
      const result = await query.execute(context, parsed.data)
      await query.authorize(context, parsed.data)
      return result
    })
  }

  async command(execution: ExecutionContext, moduleKey: string, commandKey: string, rawCommand: ApplicationCommand): Promise<ApplicationOperationReceipt> {
    const module = this.module(moduleKey), handler = module.commands[commandKey]
    if (!handler) throw new ApplicationPlatformError('operation_not_available', 'The operation is unavailable.')
    const command = applicationCommandSchema.safeParse(rawCommand)
    if (!command.success) throw new ApplicationPlatformError('invalid_value', 'The command envelope is invalid.')
    const input = handler.input.safeParse(command.data.input)
    if (!input.success) throw new ApplicationPlatformError('invalid_value', 'The command input is invalid.')
    const workspaceId = execution.security.access.workspaceId, actorUserId = execution.security.access.userId
    const actorKey = hash({ identity: execution.identity, assistant: execution.assistant, actorUserId })
    const requestHash = hash({ input: input.data, expectedVersion: command.data.expectedVersion ?? null })
    return this.transaction(execution, async (transaction, afterCommit) => {
      const context: ApplicationOperationContext<PoolClient> = { execution, transaction, afterCommit,
        idempotencyKey: command.data.idempotencyKey,
        ...(command.data.expectedVersion ? { expectedVersion: command.data.expectedVersion } : {}),
        ...(command.data.correlationKey ? { correlationKey: command.data.correlationKey } : {}) }
      const state = await lockWorkspaceModule(transaction, workspaceId, moduleKey, this.registry.workspaceModules)
      await handler.authorize(context, input.data)
      const identity = [workspaceId, moduleKey, commandKey, actorKey, command.data.idempotencyKey]
      await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [hash(identity)])
      const existing = await transaction.query<{ id: string; request_hash: string; resources: ApplicationResourceRef[] }>(
        `SELECT id,request_hash,resources FROM application_operation_receipts
         WHERE workspace_id=$1 AND module_key=$2 AND operation_key=$3 AND actor_key=$4 AND idempotency_key=$5`, identity)
      if (existing.rows[0]) {
        requireWorkspaceModuleAdmission(state, 'existing_recovery')
        if (existing.rows[0].request_hash !== requestHash) throw new ApplicationPlatformError('record_version_conflict', 'The idempotency key belongs to different input.')
        await handler.authorizeResult(context, existing.rows[0].resources)
        return { id: existing.rows[0].id, idempotencyKey: command.data.idempotencyKey, effect: 'committed', resources: existing.rows[0].resources }
      }
      requireWorkspaceModuleAdmission(state, 'new_work')
      const resources = applicationResourceRefSchema.array().max(100).parse(await handler.execute(context, input.data))
      if (resources.some(resource => resource.workspaceId !== workspaceId)) throw new ApplicationPlatformError('access_unavailable', 'The command returned an unavailable resource.')
      await handler.authorizeResult(context, resources)
      const id = randomUUID()
      await transaction.query(`INSERT INTO application_operation_receipts
        (id,workspace_id,module_key,operation_key,actor_key,actor_user_id,idempotency_key,request_hash,resources,correlation_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id,workspaceId,moduleKey,commandKey,actorKey,actorUserId,command.data.idempotencyKey,requestHash,JSON.stringify(resources),command.data.correlationKey ?? null])
      await transaction.query(`INSERT INTO application_command_audit(receipt_id,workspace_id,module_key,actor_user_id,operation_key)
        VALUES($1,$2,$3,$4,$5)`, [id,workspaceId,moduleKey,actorUserId,commandKey])
      await transaction.query(`INSERT INTO application_committed_events(receipt_id,workspace_id,module_key,event_key,resources)
        VALUES($1,$2,$3,$4,$5)`, [id,workspaceId,moduleKey,handler.eventKey,JSON.stringify(resources)])
      return { id, idempotencyKey: command.data.idempotencyKey, effect: 'committed', resources }
    }, true)
  }
}
