import type { HomeAppKey } from './home-apps.js'

/** Standard mini-app tool declaration. Navigation visibility is independent.
 * Existing capability names stay stable so saved revocations remain effective.
 * [COMP:shared/home-app-tool-config]
 */
export const HOME_APP_TOOL_CONFIG = [
  { id: 'page', capability: 'page', toolSets: ['read', 'write'], seedToolSets: true },
  { id: 'office', capability: 'office', toolSets: ['read', 'write'], seedToolSets: true },
  { id: 'browsers', capability: 'computer', toolSets: ['read', 'write'], seedToolSets: true },
  { id: 'tasks', capability: 'tasks', toolSets: ['read', 'write'], seedToolSets: true },
  { id: 'crm', capability: 'crm', toolSets: ['read', 'write'], seedToolSets: true },
  { id: 'feed', capability: 'feed', toolSets: ['read', 'write'], seedToolSets: true },
] as const satisfies readonly { id: HomeAppKey; capability: string; toolSets: readonly string[]; seedToolSets: boolean }[]

export type HomeAppToolId = (typeof HOME_APP_TOOL_CONFIG)[number]['id']
export type HomeAppToolSet = { app: HomeAppToolId; set: string }

export function homeAppToolSetCapability(app: HomeAppToolId, set: string): string {
  return `home_app:${app}:${set}`
}

export const HOME_APP_TOOL_CAPABILITIES: readonly string[] = HOME_APP_TOOL_CONFIG.flatMap(
  (app) => [app.capability, ...app.toolSets.map((set) => homeAppToolSetCapability(app.id, set))],
)

/** Positive grants: new sets require a migration, never an implicit allow. */
export const DEFAULT_HOME_APP_TOOL_CAPABILITIES: readonly string[] = [
  'page', 'feed',
  ...HOME_APP_TOOL_CONFIG.filter((app) => app.seedToolSets)
    .flatMap((app) => app.toolSets.map((set) => homeAppToolSetCapability(app.id, set))),
]

/** Structural input keeps the catalog usable by both the core and the UI. */
export function homeAppToolRequirements(tool: {
  requiresCapability?: string
  isReadOnly: boolean
  homeAppToolSet?: HomeAppToolSet
}): readonly string[] {
  const primaryApp = HOME_APP_TOOL_CONFIG.find((app) => app.capability === tool.requiresCapability)
  const selectedApp = tool.homeAppToolSet
    ? HOME_APP_TOOL_CONFIG.find((app) => app.id === tool.homeAppToolSet!.app)
    : primaryApp
  if (!selectedApp) return tool.homeAppToolSet ? ['home_app:unknown'] : []
  const set = tool.homeAppToolSet?.set ?? (tool.isReadOnly ? 'read' : 'write')
  // An undeclared set is never unlocked by an arbitrary DB grant.
  if (!(selectedApp.toolSets as readonly string[]).includes(set)) return ['home_app:unknown']
  const requirements = [selectedApp.capability, homeAppToolSetCapability(selectedApp.id, set)]
  // A Page-scoped CRM tool still needs the CRM set as well as Page access.
  if (primaryApp && primaryApp.id !== selectedApp.id) {
    requirements.push(primaryApp.capability, homeAppToolSetCapability(primaryApp.id, tool.isReadOnly ? 'read' : 'write'))
  }
  return requirements
}
