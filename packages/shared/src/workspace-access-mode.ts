/** Workspace experience policy; independent of classification and member legacy mode. */
export type WorkspaceAccessMode = 'simple' | 'departments'
export type WorkspaceAccessModeState = {
  workspaceId: string
  mode: WorkspaceAccessMode
  setupState: 'legacy' | 'ready'
  policyRevision: string
  defaultDepartmentId: string | null
  defaultDepartmentName: string | null
  canAdminister: boolean
  validForMs: number
}

/** Omission is not an explicit General choice. Never use null to encode both. */
export type ResourceDestination =
  | { kind: 'department'; departmentId: string; projectId?: string | null }
  | { kind: 'general'; projectId?: string | null }

export type WorkspaceResourceEnvelope = {
  visibility: 'workspace' | 'private'
  sensitivity: 'public' | 'internal' | 'confidential'
  compartments: string[]
  projectIds: string[]
}

export type ResourceAdmission = {
  policyRevision: string
  origin: 'explicit' | 'inherited' | 'workspace_default' | 'private'
  envelope: WorkspaceResourceEnvelope
  departmentId: string | null
}
