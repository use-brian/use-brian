/** Deployed modules compose with the existing lifecycle registry. [COMP:security/application-access] */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { ApplicationPlatformError, applicationResourceSchema, defineWorkspaceModuleRegistry,
  type ApplicationModuleCatalog, type ApplicationResourceDefinition, type ApplicationResourceRef, type WorkspaceModuleDefinition, type WorkspaceModuleRegistry } from '@use-brian/shared'
import type { ExecutionContext } from '../security/execution-context.js'
import { propertyDefSchema } from '../entities/doc-schemas.js'
import { validateDocApplicationSchema, parseApplicationCrmFieldDefinition } from './values.js'

export interface ApplicationOperationContext<Transaction> {
  execution: ExecutionContext
  transaction: Transaction
  idempotencyKey: string
  correlationKey?: string
  expectedVersion?: string
  afterCommit(effect: () => void): void
}
export interface ApplicationRegisteredOperation<Transaction> {
  input: z.ZodType
  /** Resource/action-specific admission is mandatory, never inferred from registration. */
  authorize(context: ApplicationOperationContext<Transaction>, input: unknown): Promise<void>
  execute(context: ApplicationOperationContext<Transaction>, input: unknown): Promise<unknown>
  /** Recheck returned source versions/fields where a query produces protected data. */
  authorizeResult?(context: ApplicationOperationContext<Transaction>, result: unknown): Promise<void>
}
export interface ApplicationRegisteredCommand<Transaction> extends Omit<ApplicationRegisteredOperation<Transaction>, 'execute' | 'authorizeResult'> {
  eventKey: string
  /** Receipts retain only canonical refs, never cached business payloads. */
  execute(context: ApplicationOperationContext<Transaction>, input: unknown): Promise<ApplicationResourceRef[]>
  /** Reauthorize both fresh and replayed refs under current record/field/source rights. */
  authorizeResult(context: ApplicationOperationContext<Transaction>, resources: ApplicationResourceRef[]): Promise<void>
}
export interface ApplicationModuleDefinition<Transaction> extends WorkspaceModuleDefinition {
  application: ApplicationModuleCatalog
  queries: Readonly<Record<string, ApplicationRegisteredOperation<Transaction>>>
  commands: Readonly<Record<string, ApplicationRegisteredCommand<Transaction>>>
  /** Deployed schema reader only, never a function loaded from a persisted manifest. */
  resolveResources?(context: ApplicationOperationContext<Transaction>): Promise<ApplicationResourceDefinition[]>
}

export function validateApplicationResourceCatalog(moduleKey: string, raw: readonly ApplicationResourceDefinition[]): ApplicationResourceDefinition[] {
  const resources = raw.map(resource => applicationResourceSchema.parse(resource))
  if (new Set(resources.map(resource => resource.typeKey)).size !== resources.length) {
    throw new ApplicationPlatformError('invalid_schema', 'Duplicate module resource type.')
  }
  for (const resource of resources) {
    for (const field of resource.fields) if (field.kind === 'crm') {
      const definition = parseApplicationCrmFieldDefinition(field.definition)
      if (field.key !== `custom.${definition.fieldKey}` || resource.origin.kind !== 'native' || resource.typeKey !== definition.entityKind
        || Boolean(field.required) !== definition.isRequired) throw new ApplicationPlatformError('invalid_schema', 'A canonical CRM field binding is invalid.')
    }
    const cells = resource.fields.flatMap(field => {
      if (field.kind !== 'cell') return []
      const property = propertyDefSchema.safeParse(field.property)
      if (!property.success || property.data.name !== field.key) throw new ApplicationPlatformError('invalid_schema', 'A canonical property key is invalid.')
      if (field.relationshipResolverKey && field.relationshipResolverKey !== `relation.${createHash('sha256').update(property.data.name).digest('hex')}`) {
        throw new ApplicationPlatformError('invalid_schema', 'A canonical relationship resolver is invalid.')
      }
      return [property.data]
    })
    validateDocApplicationSchema(cells)
    if (resource.origin.kind === 'native' && (resource.fields.some(field => field.unique === true) || cells.some(property => property.unique === true))) {
      throw new ApplicationPlatformError('invalid_schema', 'Canonical native schemas do not support declared unique fields.')
    }
    if (resource.origin.kind === 'native' && resource.origin.moduleKey !== moduleKey) {
      throw new ApplicationPlatformError('invalid_schema', 'A native resource must name its owning module.')
    }
  }
  return resources
}

/** A database row cannot register a module; callers supply deployed code definitions. */
export function defineApplicationModules<Transaction>(modules: readonly ApplicationModuleDefinition<Transaction>[],
  existing: WorkspaceModuleRegistry): {
    workspaceModules: WorkspaceModuleRegistry
    applications: ReadonlyMap<string, Readonly<ApplicationModuleDefinition<Transaction>>>
  } {
  const registry: Record<string, WorkspaceModuleDefinition> = { ...existing }
  const applications = new Map<string, Readonly<ApplicationModuleDefinition<Transaction>>>()
  const validKey = /^[a-z][a-z0-9_.-]{0,127}$/
  for (const module of modules) {
    if (!validKey.test(module.key) || applications.has(module.key) || registry[module.key]
      || !module.application.version || module.application.commands.length !== Object.keys(module.commands).length
      || module.application.queries.length !== Object.keys(module.queries).length) {
      throw new ApplicationPlatformError('invalid_schema', 'Invalid or duplicate deployed module registration.')
    }
    for (const [names, handlers] of [[module.application.commands, module.commands], [module.application.queries, module.queries]] as const) {
      if (new Set(names).size !== names.length || names.some(name => !validKey.test(name) || !Object.hasOwn(handlers, name))) {
        throw new ApplicationPlatformError('invalid_schema', 'The operation catalog does not match deployed handlers.')
      }
      for (const handler of Object.values(handlers)) {
        if (!(handler.input instanceof z.ZodType) || typeof handler.authorize !== 'function' || typeof handler.execute !== 'function') {
          throw new ApplicationPlatformError('invalid_schema', 'Every deployed operation requires typed input and authority.')
        }
      }
    }
    const resources = validateApplicationResourceCatalog(module.key, module.application.resources)
    if (module.resolveResources !== undefined && typeof module.resolveResources !== 'function') {
      throw new ApplicationPlatformError('invalid_schema', 'A deployed resource reader is required.')
    }
    if (Object.values(module.commands).some(command => typeof command.authorizeResult !== 'function'
      || !module.application.events.includes(command.eventKey))) {
      throw new ApplicationPlatformError('invalid_schema', 'Every command must reauthorize its saved resource references.')
    }
    const frozen = Object.freeze({ ...module,
      application: Object.freeze(structuredClone({ ...module.application, resources })),
      queries: Object.freeze({ ...module.queries }), commands: Object.freeze({ ...module.commands }) })
    applications.set(module.key, frozen)
    registry[module.key] = Object.freeze({ key: module.key, defaultState: module.defaultState,
      application: frozen.application, ...(module.blockingCountCompatibility ? { blockingCountCompatibility: module.blockingCountCompatibility } : {}) })
  }
  for (const module of applications.values()) {
    if (module.application.dependencies.some(dependency => !registry[dependency] || dependency === module.key)) {
      throw new ApplicationPlatformError('invalid_schema', 'An application dependency is unavailable.')
    }
    const reachable = new Set([module.key, ...module.application.dependencies])
    for (const resource of module.application.resources) {
      for (const field of resource.fields) {
        if (field.kind === 'reference' && ![...applications.values()].some(target => reachable.has(target.key)
          && target.application.resources.some(candidate => candidate.typeKey === field.targetTypeKey))) {
          throw new ApplicationPlatformError('invalid_schema', 'A reference target is not in the module dependency catalog.')
        }
      }
    }
  }
  const visit = (name: string, ancestors: Set<string>): void => {
    if (ancestors.has(name)) throw new ApplicationPlatformError('invalid_schema', 'Cyclic module dependencies.')
    const next = new Set([...ancestors, name])
    for (const dependency of applications.get(name)?.application.dependencies ?? []) visit(dependency, next)
  }
  for (const name of applications.keys()) visit(name, new Set())
  return { workspaceModules: defineWorkspaceModuleRegistry(registry), applications }
}
