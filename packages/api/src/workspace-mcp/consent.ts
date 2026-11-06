/** Immutable operation/context consent for native workspace connections. [COMP:api/workspace-mcp] */
import { z } from 'zod'
import { filterToolsByCapabilities, minSensitivity, type AccessCeiling, type Tool, type ToolContext } from '@use-brian/core'

const names = z.array(z.string().min(1).max(200)).max(4096)
export const workspaceMcpConsentSchema = z.object({
  version: z.literal(1),
  assistantId: z.string().uuid(),
  operationNames: names,
  connectorBindings: z.record(z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  maxClearance: z.enum(['public', 'internal', 'confidential']),
  compartments: names,
  mutationCompartments: names,
  projectIds: z.array(z.string().uuid()).max(4096),
  visibilityAssistantIds: z.array(z.string().uuid()).max(4096),
  departmentRead: z.object({
    workspaceId: z.string().uuid(), userId: z.string().uuid(), assistantId: z.string().uuid().nullable(),
    base: z.enum(['public', 'internal', 'confidential']),
    departments: z.record(z.enum(['public', 'internal', 'confidential'])),
    projects: z.record(z.enum(['member', 'oversight'])).optional(),
    contextDepartment: z.string().nullable(), binding: names.nullable(),
    cap: z.enum(['public', 'internal', 'confidential']).nullable(),
  }).strict().optional(),
  contextGroupId: z.string().uuid().nullable(),
  contextProjectId: z.string().uuid().nullable(),
  expiresAt: z.string().datetime(),
}).strict()
export type WorkspaceMcpConsent = z.infer<typeof workspaceMcpConsentSchema>

/** Reject malformed stored consent instead of falling back to legacy access. */
export function readWorkspaceMcpConsent(value: unknown, now = Date.now()): WorkspaceMcpConsent | null {
  if (value === undefined || value === null) return null
  const parsed = workspaceMcpConsentSchema.safeParse(value)
  if (!parsed.success || Date.parse(parsed.data.expiresAt) <= now) throw new Error('workspace_mcp_consent_unavailable')
  return parsed.data
}

export function workspaceMcpMaximum(consent: WorkspaceMcpConsent, workspaceId: string, userId: string): AccessCeiling {
  if (consent.departmentRead && (consent.departmentRead.userId !== userId
    || consent.departmentRead.workspaceId !== workspaceId
    || consent.departmentRead.assistantId !== consent.assistantId)) throw new Error('workspace_mcp_actor_mismatch')
  const read = consent.departmentRead
  const departmentRead = read ? { ...read, base: minSensitivity(read.base, consent.maxClearance),
    cap: minSensitivity(read.cap ?? 'confidential', consent.maxClearance),
    departments: Object.fromEntries(Object.entries(read.departments).map(([id, tier]) => [id, minSensitivity(tier, consent.maxClearance)])) } : undefined
  return { ...(departmentRead ? { departmentRead } : {}), workspaceId, userId, clearance: consent.maxClearance,
    compartments: consent.compartments, mutationCompartments: consent.mutationCompartments,
    projectIds: consent.projectIds, visibilityAssistantIds: consent.visibilityAssistantIds }
}

/** The caller supplies server-observed scopes and native registration, not client names. */
export function snapshotWorkspaceMcpConsent(input: {
  context: ToolContext
  tools: ReadonlyMap<string, Tool>
  readOnly: boolean
  availableCompartments: readonly string[]
  availableProjectIds: readonly string[]
  availableAssistantIds: readonly string[]
  contextGroupId: string | null
  contextProjectId: string | null
  expiresAt: Date
  connectorBindings?: Record<string, string>
}): WorkspaceMcpConsent {
  const access = input.context.executionContext?.security.access
  if (!access || !input.context.workspaceId) throw new Error('workspace_mcp_authority_required')
  const tools = filterToolsByCapabilities(new Map([...input.tools].filter(([, tool]) =>
    !input.readOnly || tool.isReadOnly === true)), input.context.activeCapabilities ?? new Set())
  const finite = (grant: readonly string[] | null | undefined, available: readonly string[]) =>
    [...new Set(grant === null ? available : (grant ?? []).filter(value => available.includes(value)))].sort()
  return workspaceMcpConsentSchema.parse({
    version: 1, assistantId: access.assistantId, connectorBindings: input.connectorBindings ?? {},
    operationNames: [...tools.keys()].sort(), maxClearance: access.clearance,
    compartments: finite(access.compartments, input.availableCompartments),
    mutationCompartments: finite(access.mutationCompartments, input.availableCompartments),
    projectIds: finite(access.projectIds, input.availableProjectIds),
    visibilityAssistantIds: finite(access.visibilityAssistantIds ?? (access.assistantKind === 'primary' ? null : [access.assistantId]), input.availableAssistantIds),
    ...(access.departmentRead ? { departmentRead: structuredClone(access.departmentRead) } : {}),
    contextGroupId: input.contextGroupId, contextProjectId: input.contextProjectId,
    expiresAt: input.expiresAt.toISOString(),
  })
}
