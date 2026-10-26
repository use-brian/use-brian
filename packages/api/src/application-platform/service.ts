/** Canonical module dispatcher and atomic command receipts. [COMP:api/application-records] */
import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { applicationAuthorityAllowsOperation, applicationAuthorityFieldCatalog, defineApplicationModules, validateApplicationResourceCatalog, type ApplicationModuleDefinition, type ApplicationOperationContext,
  type ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError, WORKSPACE_MODULES, applicationCommandSchema, applicationResourceRefSchema,
  type ApplicationCommand, type ApplicationOperationReceipt, type ApplicationResourceRef,
  type WorkspaceModuleRegistry } from '@use-brian/shared'
import { getAppPool } from '../db/client.js'
import { lockWorkspaceModule, requireWorkspaceModuleAdmission } from '../db/workspace-modules-store.js'
import { getApplicationExecutionBinding, runApplicationTransaction } from './execution-context.js'
import { z } from 'zod'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'

function stable(value: unknown, wire = false): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stable(item, wire)).join(',')}]`
  return `{${Object.entries(value).sort(([left], [right]) => wire ? (left < right ? -1 : left > right ? 1 : 0) : left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item, wire)}`).join(',')}}`
}
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')

/** Snapshot wire input before any handler transform; leave actor/lock hashes stable. */
function commandFingerprint(command: ApplicationCommand): string {
  return `wire-v1:${createHash('sha256').update(stable({
    input: command.input, expectedVersion: command.expectedVersion ?? null,
  }, true)).digest('hex')}`
}


export class ApplicationPlatformService {
  readonly #registry: ReturnType<typeof defineApplicationModules<PoolClient>>
  constructor(modules: readonly ApplicationModuleDefinition<PoolClient>[],
    private readonly pool: Pool = getAppPool(), existing: WorkspaceModuleRegistry = WORKSPACE_MODULES) {
    this.#registry = defineApplicationModules(modules, existing)
  }

  /** Inspection cannot replace definitions in the live dispatcher. */
  get registry(): ReturnType<typeof defineApplicationModules<PoolClient>> {
    return { workspaceModules: this.#registry.workspaceModules, applications: new Map(this.#registry.applications) }
  }

  /** Deployed code and migration metadata must agree; this grants no authority. */
  async assertDeployedModuleCurrent(client:PoolClient,moduleKey:string) {
    const module=this.module(moduleKey)
    const matched=(await client.query<{matched:boolean|null}>('SELECT application_deployed_module_matches($1,$2,$3::text[],$4::text[],$5::text[],$6) AS matched',
      [moduleKey,module.application.version,module.application.commands,module.application.queries,module.application.dependencies,module.defaultState])).rows[0]?.matched
    if(matched===false||matched==null&&module.application.policyCapabilities.includes('canonical_module_roles'))throw new ApplicationPlatformError('access_unavailable','The deployed module contract is unavailable.')
  }

  private module(key: string) {
    const module = this.#registry.applications.get(key)
    if (!module) throw new ApplicationPlatformError('operation_not_available', 'The operation is unavailable.')
    return module
  }

  async catalog(execution: ExecutionContext) {
    const binding = getApplicationExecutionBinding(execution)
    if (!binding) throw new ApplicationPlatformError('authentication_required', 'Application authentication is required.')
    const module = this.module(binding.state.moduleKey)
    return this.transaction(execution, async transaction => {
      await this.assertDeployedModuleCurrent(transaction,module.key)
      const state = await lockWorkspaceModule(transaction, execution.security.access.workspaceId, module.key, this.#registry.workspaceModules, { kind: 'application' })
      requireWorkspaceModuleAdmission(state, 'read')
      const declarations = module.resolveResources ? await module.resolveResources({ execution, transaction, idempotencyKey: '', afterCommit: () => {
        throw new ApplicationPlatformError('operation_not_available', 'A catalog cannot schedule effects.')
      } }) : module.application.resources
      const resources = validateApplicationResourceCatalog(module.key, declarations).flatMap(resource => {
        const fields = resource.fields.map(field => field.key)
        const actions = binding.state.readOnly ? ['read', 'query'] : ['read', 'query', 'schema', 'create', 'patch']
        const decisions = actions.map(action => applicationAuthorityFieldCatalog(binding.state.layers,
          { origin: resource.origin, typeKey: resource.typeKey, workspaceId: binding.state.workspaceId, id: 'catalog', version: resource.schemaVersion }, action, fields, fields))
        if (!decisions.some(decision => decision.allowed)) return []
        const visible = new Set(decisions.flatMap(decision => [...decision.readFields, ...(binding.state.readOnly ? [] : decision.writeFields)]))
        return [{ ...resource, fields: resource.fields.filter(field => visible.has(field.key)) }]
      })
      // Typed handler admission still runs at invocation; a catalog is never a lease.
      const commands = binding.state.readOnly ? [] : module.application.commands.filter(key => applicationAuthorityAllowsOperation(binding.state.layers, `command:${key}`))
      return { moduleKey: module.key, version: module.application.version, resources,
        queries: [...module.application.queries], commands,
        operationSchemas: { queries: Object.fromEntries(module.application.queries.map(key => [key, toJsonSchemaCompat(z.object({ input: module.queries[key].input }).strict())])),
          commands: Object.fromEntries(commands.map(key => [key, toJsonSchemaCompat(applicationCommandSchema.extend({ input: module.commands[key].input }))])) } }
    })
  }

  private async transaction<T>(execution: ExecutionContext, operation: (client: PoolClient, afterCommit: (effect: () => void) => void) => Promise<T>, effectful = false, commandLock?: string): Promise<T> {
    return runApplicationTransaction(this.pool, execution, operation, effectful, commandLock)
  }

  async query(execution: ExecutionContext, moduleKey: string, queryKey: string, rawInput: unknown): Promise<unknown> {
    const application = getApplicationExecutionBinding(execution)
    if (application && application.state.moduleKey !== moduleKey) throw new ApplicationPlatformError('access_unavailable', 'The module is unavailable.')
    const module = this.module(moduleKey)
    const query = Object.hasOwn(module.queries, queryKey) ? module.queries[queryKey] : undefined
    if (!query) throw new ApplicationPlatformError('operation_not_available', 'The operation is unavailable.')
    const parsed = query.input.safeParse(rawInput)
    if (!parsed.success) throw new ApplicationPlatformError('invalid_value', 'The query input is invalid.')
    return this.transaction(execution, async (transaction, afterCommit) => {
      await this.assertDeployedModuleCurrent(transaction,moduleKey)
      const context = { execution, transaction, idempotencyKey: '', afterCommit }
      const state = await lockWorkspaceModule(transaction, execution.security.access.workspaceId, moduleKey, this.#registry.workspaceModules, application ? { kind: 'application' } : undefined)
      requireWorkspaceModuleAdmission(state, 'read')
      await query.authorize(context, parsed.data)
      const result = await query.execute(context, parsed.data)
      await query.authorizeResult?.(context, result)
      await query.authorize(context, parsed.data)
      return result
    })
  }

  /** Read the canonical saved outcome without re-executing an uncertain command. */
  async reconcile(execution: ExecutionContext, moduleKey: string, commandKey: string, rawCommand: ApplicationCommand): Promise<
    { state: 'applied'; receipt: ApplicationOperationReceipt } | { state: 'uncertain' }> {
    const application = getApplicationExecutionBinding(execution)
    if (execution.surface.readOnly || application && (application.state.moduleKey !== moduleKey
      || !applicationAuthorityAllowsOperation(application.state.layers, `command:${commandKey}`))) {
      throw new ApplicationPlatformError('access_unavailable', 'The operation is unavailable.')
    }
    const module = this.module(moduleKey)
    const handler = Object.hasOwn(module.commands, commandKey) ? module.commands[commandKey] : undefined
    if (!handler) throw new ApplicationPlatformError('operation_not_available', 'The operation is unavailable.')
    const command = applicationCommandSchema.safeParse(rawCommand)
    if (!command.success) throw new ApplicationPlatformError('invalid_value', 'The command envelope is invalid.')
    const requestHash = commandFingerprint(command.data)
    const input = handler.input.safeParse(command.data.input)
    if (!input.success) throw new ApplicationPlatformError('invalid_value', 'The command input is invalid.')
    const workspaceId = execution.security.access.workspaceId, actorUserId = execution.security.access.userId
    const actorKey = hash(application ? { kind: 'application', appId: application.state.appId, workspaceId,
      principal: application.state.principal, serviceUserId: application.state.serviceUserId ?? null, assistant: execution.assistant }
      : { identity: execution.identity, assistant: execution.assistant, actorUserId })
    const identity = [workspaceId, moduleKey, commandKey, actorKey, command.data.idempotencyKey]
    return this.transaction(execution, async transaction => {
      await this.assertDeployedModuleCurrent(transaction, moduleKey)
      const state = await lockWorkspaceModule(transaction, workspaceId, moduleKey, this.#registry.workspaceModules,
        application ? { kind: 'application' } : undefined)
      requireWorkspaceModuleAdmission(state, 'existing_recovery')
      await transaction.query("SELECT set_config('app.application_command_key',$1,true),set_config('app.deployed_application_module',$2,true),set_config('app.v2_assistant_id',$3,true)", [commandKey,moduleKey,execution.assistant.id])
      const context: ApplicationOperationContext<PoolClient> = { execution, transaction, idempotencyKey: command.data.idempotencyKey,
        afterCommit: () => { throw new ApplicationPlatformError('operation_not_available', 'Reconciliation cannot schedule effects.') },
        ...(command.data.expectedVersion ? { expectedVersion: command.data.expectedVersion } : {}),
        ...(command.data.correlationKey ? { correlationKey: command.data.correlationKey } : {}) }
      await handler.authorize(context, input.data)
      const row = (await transaction.query<{ id: string; request_hash: string; resources: ApplicationResourceRef[] }>(
        `SELECT id,request_hash,resources FROM application_operation_receipts
         WHERE workspace_id=$1 AND module_key=$2 AND operation_key=$3 AND actor_key=$4 AND idempotency_key=$5`, identity)).rows[0]
      if (!row || !row.request_hash.startsWith('wire-v1:')) return { state: 'uncertain' as const }
      if (row.request_hash !== requestHash) throw new ApplicationPlatformError('record_version_conflict', 'The idempotency key belongs to different input.')
      await handler.authorizeResult(context, row.resources)
      await handler.authorize(context, input.data)
      return { state: 'applied' as const, receipt: { id: row.id, idempotencyKey: command.data.idempotencyKey,
        effect: 'committed' as const, resources: row.resources } }
    }, false, hash(identity))
  }

  async command(execution: ExecutionContext, moduleKey: string, commandKey: string, rawCommand: ApplicationCommand): Promise<ApplicationOperationReceipt> {
    const application = getApplicationExecutionBinding(execution)
    if (execution.surface.readOnly || application && application.state.moduleKey !== moduleKey) throw new ApplicationPlatformError('access_unavailable', 'The operation is unavailable.')
    if (application && !applicationAuthorityAllowsOperation(application.state.layers, `command:${commandKey}`)) {
      throw new ApplicationPlatformError('access_unavailable', 'The operation is unavailable.')
    }
    const module = this.module(moduleKey)
    const handler = Object.hasOwn(module.commands, commandKey) ? module.commands[commandKey] : undefined
    if (!handler) throw new ApplicationPlatformError('operation_not_available', 'The operation is unavailable.')
    const command = applicationCommandSchema.safeParse(rawCommand)
    if (!command.success) throw new ApplicationPlatformError('invalid_value', 'The command envelope is invalid.')
    const requestHash = commandFingerprint(command.data)
    const input = handler.input.safeParse(command.data.input)
    if (!input.success) throw new ApplicationPlatformError('invalid_value', 'The command input is invalid.')
    const workspaceId = execution.security.access.workspaceId, actorUserId = execution.security.access.userId
    const actorKey = hash(application ? { kind: 'application', appId: application.state.appId, workspaceId,
      principal: application.state.principal, serviceUserId: application.state.serviceUserId ?? null, assistant: execution.assistant }
      : { identity: execution.identity, assistant: execution.assistant, actorUserId })
    const identity = [workspaceId, moduleKey, commandKey, actorKey, command.data.idempotencyKey]
    return this.transaction(execution, async (transaction, afterCommit) => {
      await this.assertDeployedModuleCurrent(transaction,moduleKey)
      const context: ApplicationOperationContext<PoolClient> = { execution, transaction, afterCommit,
        idempotencyKey: command.data.idempotencyKey,
        ...(command.data.expectedVersion ? { expectedVersion: command.data.expectedVersion } : {}),
        ...(command.data.correlationKey ? { correlationKey: command.data.correlationKey } : {}) }
      const state = await lockWorkspaceModule(transaction, workspaceId, moduleKey, this.#registry.workspaceModules, application ? { kind: 'application' } : undefined)
      await transaction.query("SELECT set_config('app.application_command_key',$1,true),set_config('app.deployed_application_module',$2,true),set_config('app.v2_assistant_id',$3,true)", [commandKey,moduleKey,execution.assistant.id])
      await handler.authorize(context, input.data)
      const existing = await transaction.query<{ id: string; request_hash: string; resources: ApplicationResourceRef[] }>(
        `SELECT id,request_hash,resources FROM application_operation_receipts
         WHERE workspace_id=$1 AND module_key=$2 AND operation_key=$3 AND actor_key=$4 AND idempotency_key=$5`, identity)
      if (existing.rows[0]) {
        requireWorkspaceModuleAdmission(state, 'existing_recovery')
        if (!existing.rows[0].request_hash.startsWith('wire-v1:')) {
          throw new ApplicationPlatformError('outcome_uncertain', 'The saved request cannot be verified. Use the application recovery path before retrying.', 'uncertain')
        }
        if (existing.rows[0].request_hash !== requestHash) throw new ApplicationPlatformError('record_version_conflict', 'The idempotency key belongs to different input.')
        await handler.authorizeResult(context, existing.rows[0].resources)
        return { id: existing.rows[0].id, idempotencyKey: command.data.idempotencyKey, effect: 'committed', resources: existing.rows[0].resources }
      }
      requireWorkspaceModuleAdmission(state, handler.operationClass ?? 'new_work')
      const resources = applicationResourceRefSchema.array().max(100).parse(await handler.execute(context, input.data))
      if (resources.some(resource => resource.workspaceId !== workspaceId)) throw new ApplicationPlatformError('access_unavailable', 'The command returned an unavailable resource.')
      await handler.authorizeResult(context, resources)
      const id = randomUUID()
      await transaction.query(`INSERT INTO application_operation_receipts
        (id,workspace_id,module_key,operation_key,actor_key,actor_user_id,idempotency_key,request_hash,resources,correlation_key,application_client_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id,workspaceId,moduleKey,commandKey,actorKey,actorUserId,command.data.idempotencyKey,requestHash,JSON.stringify(resources),command.data.correlationKey ?? null,application?.state.appId ?? null])
      await transaction.query(`INSERT INTO application_command_audit(receipt_id,workspace_id,module_key,actor_user_id,operation_key)
        VALUES($1,$2,$3,$4,$5)`, [id,workspaceId,moduleKey,actorUserId,commandKey])
      await transaction.query(`INSERT INTO application_committed_events(receipt_id,workspace_id,module_key,event_key,resources)
        VALUES($1,$2,$3,$4,$5)`, [id,workspaceId,moduleKey,handler.eventKey,JSON.stringify(resources)])
      return { id, idempotencyKey: command.data.idempotencyKey, effect: 'committed', resources }
    }, true, hash(identity))
  }
}
