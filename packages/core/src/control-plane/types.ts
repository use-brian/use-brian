/**
 * Control-plane reader port — the workspace-inspection surface the agent
 * capability toolset reads through (agent-facing capability surface plan,
 * Tier 1). Core declares the interface only; the DB adapter lives in
 * `packages/api/src/agent-surface/control-plane-reader.ts`.
 *
 * Every method is a READ over apparatus the workspace already exposes in
 * Studio: assistants, connectors, skills, channels. Rows are plain
 * serializable projections — compact enough for an agent's context window,
 * concrete enough to act on (ids are always included so a follow-up call
 * can target the row).
 *
 * Access posture: callers pass the acting `(userId, workspaceId)` principal
 * from the ToolContext. Implementations must scope every read to that
 * workspace and respect membership — the same rows the acting principal
 * could see in Studio, nothing more. Clearance enforcement on brain rows is
 * not needed here: this surface lists *apparatus* (config), not knowledge.
 */

export type ControlPlaneAssistant = {
  id: string
  name: string
  kind: 'primary' | 'standard' | 'app'
  clearance: 'public' | 'internal' | 'confidential'
  appType: string | null
  /** Active named-capability grants (tasks / crm / configure / ...). */
  capabilities: string[]
}

export type ControlPlaneConnector = {
  /** Provider slug for built-ins (gcal / gmail / github / ...) or a UUID for custom MCP. */
  provider: string
  /** Official display name, or the instance label for a custom connector. */
  name: string
  /** Registry description when the provider is official. */
  description: string | null
  /** The connector_instance row id — null for an unconfigured catalog row. */
  instanceId: string | null
  label: string
  connected: boolean
  availability: 'connected' | 'available'
  /** True when connecting requires a browser OAuth consent a human must click. */
  oauthRequired: boolean
  /** True when Agent configuration can prepare a resumable web consent handoff. */
  authorizationHandoff: boolean
  /** Workspace-scoped Studio path; no credential material is embedded. */
  connectPath: string | null
  authType: 'none' | 'oauth' | 'bearer' | 'custom_header' | 'api_key' | 'gcs' | 's3' | 'imap' | 'local' | 'cli'
  scope: 'team-native' | 'team-grant' | 'available'
  sensitivity: 'public' | 'internal' | 'confidential'
}

export type ControlPlaneSkill = {
  id: string
  slug: string
  name: string
  description: string
  state: string
  /** Governance: NULL = suggested (not yet activated); set = active. */
  activatedAt: Date | null
  inductionSource: 'self' | 'ingested' | 'authored'
  sensitivity: 'public' | 'internal' | 'confidential'
}

export type ControlPlaneChannel = {
  id: string
  /** channel_integrations.id for workflow event sources; distinct from id. */
  integrationId: string | null
  integrationStatus: string | null
  channelType: string
  displayName: string | null
  clearance: 'public' | 'internal' | 'confidential'
  enabledCapabilities: string[]
  status: string
}

export type ControlPlaneReader = {
  listAssistants(userId: string, workspaceId: string): Promise<ControlPlaneAssistant[]>
  getAssistant(userId: string, workspaceId: string, assistantId: string): Promise<ControlPlaneAssistant | null>
  listConnectors(userId: string, workspaceId: string): Promise<ControlPlaneConnector[]>
  listSkills(userId: string, workspaceId: string): Promise<ControlPlaneSkill[]>
  listChannels(userId: string, workspaceId: string): Promise<ControlPlaneChannel[]>
}
