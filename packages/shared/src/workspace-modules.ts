/** Optional product modules, independent of Home navigation and assistant grants.
 * Spec: docs/operations/workspace-modules.md
 * [COMP:shared/workspace-modules]
 */
export const WORKSPACE_MODULE_STATES = ['enabled', 'draining', 'disabled'] as const
export type WorkspaceModuleState = typeof WORKSPACE_MODULE_STATES[number]

export interface WorkspaceModuleDefinition {
  key: string
  defaultState: WorkspaceModuleState
  /** Deployed application catalog; persisted settings cannot register executable code. */
  application?: import('./application-platform.js').ApplicationModuleCatalog
  /** Optional compatibility projection for a module's pre-registry HTTP clients. */
  blockingCountCompatibility?: { field: string; blockerKey: string }
}

export type WorkspaceModuleRegistry = Readonly<Record<string, Readonly<WorkspaceModuleDefinition>>>

/** Preserve literal keys while exposing one registry shape to stores and routes. */
export function defineWorkspaceModuleRegistry<const Registry extends WorkspaceModuleRegistry>(registry: Registry): Registry {
  return Object.freeze(registry)
}

export const WORKSPACE_MODULES = defineWorkspaceModuleRegistry({
  association: {
    key: 'association',
    defaultState: 'disabled',
    blockingCountCompatibility: { field: 'pendingOrders', blockerKey: 'pending_orders' },
  },
} as const)

export type WorkspaceModuleKey = keyof typeof WORKSPACE_MODULES

export function workspaceModuleKeys(registry: WorkspaceModuleRegistry = WORKSPACE_MODULES): readonly string[] {
  return Object.freeze(Object.keys(registry))
}

export const WORKSPACE_MODULE_KEYS = workspaceModuleKeys(WORKSPACE_MODULES) as readonly WorkspaceModuleKey[]

export function isWorkspaceModuleKey(value: string): value is WorkspaceModuleKey
export function isWorkspaceModuleKey(value: string, registry: WorkspaceModuleRegistry): boolean
export function isWorkspaceModuleKey(value: string, registry: WorkspaceModuleRegistry = WORKSPACE_MODULES): boolean {
  return Object.hasOwn(registry, value) && registry[value].key === value
}

export const WORKSPACE_MODULE_ACTIONS = ['enable', 'request_disable', 'finish_disable'] as const
export type WorkspaceModuleAction = typeof WORKSPACE_MODULE_ACTIONS[number]
export const WORKSPACE_MODULE_OPERATION_CLASSES = ['read', 'new_work', 'existing_recovery', 'new_commerce'] as const
export type WorkspaceModuleOperationClass = typeof WORKSPACE_MODULE_OPERATION_CLASSES[number]
export const WORKSPACE_MODULE_CONFLICTS = ['module_disabled', 'module_draining', 'module_drain_pending', 'stale_module_version'] as const
export type WorkspaceModuleConflict = typeof WORKSPACE_MODULE_CONFLICTS[number]

/** Portable lifecycle failures retain the same code through REST and native tools. */
export class WorkspaceModuleError extends Error {
  constructor(
    readonly code: WorkspaceModuleConflict | 'not_authorized' | 'invalid_input' | 'not_found',
    message: string,
    readonly details?: Record<string, unknown>,
  ) { super(message); this.name = 'WorkspaceModuleError' }
}

export interface WorkspaceModule {
  workspaceId: string
  moduleKey: string
  state: WorkspaceModuleState
  /** Zero means missing/unprovisioned, never enabled. */
  version: number
  enabledAt: string | null
  disableRequestedAt: string | null
  disabledAt: string | null
  updatedAt: string | null
  updatedByUserId: string | null
}

export interface WorkspaceModuleActionInput {
  action: WorkspaceModuleAction
  expectedVersion: number
}

export interface WorkspaceModuleActionResult {
  module: WorkspaceModule
  changed: boolean
  blockingWork: WorkspaceModuleBlockingWork[]
  /** Compatibility field supplied by an Association-facing adapter. */
  pendingOrders?: number
}

export interface WorkspaceModuleBlockingWork {
  key: string
  count: number
}

/** Admission only. Callers still need resource and principal authority. */
export function workspaceModuleAdmits(state: WorkspaceModuleState, operation: WorkspaceModuleOperationClass): boolean {
  return operation === 'read' || operation === 'existing_recovery'
    || ((operation === 'new_work' || operation === 'new_commerce') && state === 'enabled')
}
