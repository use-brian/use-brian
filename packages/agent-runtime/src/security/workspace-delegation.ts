/** Host-bound origin of durable workspace work. [COMP:security/access-ceiling] */
import { z } from 'zod'
import type { ExecutionContext } from './execution-context.js'

/** Server-created parent reference. Never accepted by the external A2A schema. */
type WorkspaceCredentialParent = {
  kind: 'brain_key' | 'assistant_key' | 'oauth_token'
  credentialId: string
  revision: string
  userId: string
  workspaceId: string
  assistantId: string
  sessionId: string
  selectionId?: string
}
/** Host-verified origin of delegated workspace work; `a2a/types.ts` re-exports it. */
export type WorkspaceCredentialDelegation = WorkspaceCredentialParent & {
  /** Additional host-verified origins; flat and bounded. All must remain current. */
  constraints?: WorkspaceCredentialParent[]
}
const parentSchema = z.object({
  kind: z.enum(['brain_key','assistant_key','oauth_token']),credentialId: z.string().uuid(),revision: z.string().regex(/^[a-f0-9]{64}$/),
  userId: z.string().uuid(),workspaceId: z.string().uuid(),assistantId: z.string().uuid(),sessionId: z.string().uuid(),selectionId: z.string().uuid().optional(),
}).strict()
export const WorkspaceCredentialDelegationSchema = parentSchema.extend({ constraints: z.array(parentSchema).max(8).optional() })
const parents = new WeakMap<ExecutionContext, WorkspaceCredentialDelegation>()
/** Host port: bind only after authenticating or restoring the exact credential. */
export function bindWorkspaceCredentialDelegation(execution: ExecutionContext, parent: WorkspaceCredentialDelegation): void {
  const verified = WorkspaceCredentialDelegationSchema.parse(parent)
  if (verified.userId !== execution.security.access.userId || verified.workspaceId !== execution.security.access.workspaceId) throw new Error('workspace_mcp_parent_mismatch')
  parents.set(execution,verified)
}
export function workspaceCredentialDelegation(execution?: ExecutionContext): WorkspaceCredentialDelegation | undefined {
  const parent = execution ? parents.get(execution) : undefined
  return parent ? structuredClone(parent) : undefined
}

/** Intersect provenance without allowing one origin to replace another. */
export function intersectWorkspaceCredentialDelegations(...values: (WorkspaceCredentialDelegation | undefined)[]): WorkspaceCredentialDelegation | undefined {
  const flattened = values.flatMap(value => value ? [((({ constraints, ...parent }) => parent)(value)), ...(value.constraints ?? [])] : [])
  const unique = [...new Map(flattened.map(parent => [JSON.stringify(parent), parent])).values()]
  if (!unique.length) return undefined
  return WorkspaceCredentialDelegationSchema.parse({ ...unique[0], ...(unique.length > 1 ? { constraints: unique.slice(1) } : {}) })
}
