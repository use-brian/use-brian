import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import type { BrainAuth } from './auth.js'

type MemoryOperation = 'saveMemory' | 'getMemory'
const activeOperation = new AsyncLocalStorage<{ execution: ExecutionContext; name: MemoryOperation; current: () => Promise<boolean> }>()
const inputSchema = z.object({
  summary: z.string().trim().min(1),
  detail: z.string().max(16000).optional(),
  scope: z.literal('user').optional(),
}).strict()

/** The credential proof is scoped to one native invocation and its execution context. */
export function privateMemoryCredential(execution: ExecutionContext, name: MemoryOperation) {
  const call = activeOperation.getStore()
  return call?.execution === execution && call.name === name ? call.current : undefined
}

export function privateOAuthMemoryTool(name: MemoryOperation, native: Tool, grant: BrainAuth): Tool {
  const writing = name === 'saveMemory'
  return {
    ...native,
    ...(writing ? { inputSchema, description: 'Save a new private memory for the signed-in person in this workspace. Returns its ID and summary.' } : {}),
    async execute(input, context) {
      const execution = context.executionContext
      const { getAuthenticatedBrainCredentialCurrent } = await import('./auth.js')
      const current = getAuthenticatedBrainCredentialCurrent(grant)
      if (!current || !execution || grant.authKind !== 'oauth_token' || (writing && grant.scope !== 'read_write') || grant.workspaceMcpConsent
        || execution.identity.kind !== 'programmatic' || execution.identity.principal.kind !== 'oauth_token'
        || execution.identity.principal.credentialId !== grant.keyId || execution.identity.principal.actorUserId !== grant.actingUserId
        || execution.ownership.kind !== 'workspace' || execution.ownership.workspaceId !== grant.workspaceId
        || execution.security.access.workspaceId !== grant.workspaceId || execution.security.access.userId !== grant.actingUserId
        || execution.security.access.sharedAudience || execution.lifecycle.sessionPersisted !== false
        || (writing && execution.surface.readOnly) || execution.surface.systemRead || execution.security.access.systemRead || !await current()) {
        return { isError: true, data: 'Reconnect to this workspace with the required personal memory access.' }
      }
      const args = writing ? { ...inputSchema.parse(input), scope: 'user' } : input
      return activeOperation.run({ execution, name, current }, () => native.execute(args, context))
    },
  }
}
