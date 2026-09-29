import { describe, expect, it } from 'vitest'
import type { CurrentAuthorityBoundary } from '../../tools/types.js'
import {
  createExecutionContext,
  executionToolContext,
  type CreateExecutionContextInput,
} from '../execution-context.js'

const authority: CurrentAuthorityBoundary = {
  async assertCurrent() {},
  async execute<T>(operation: () => Promise<T>) { return operation() },
}

function input(overrides: Partial<CreateExecutionContextInput> = {}): CreateExecutionContextInput {
  return {
    identity: {
      kind: 'attended',
      principal: { kind: 'workspace_member', userId: 'actor-1' },
    },
    ownership: { kind: 'workspace', workspaceId: 'workspace-1' },
    access: {
      workspaceId: 'workspace-1',
      userId: 'actor-1',
      assistantId: 'assistant-1',
      assistantKind: 'standard',
      clearance: 'internal',
      compartments: [],
      mutationCompartments: [],
      projectIds: [],
      visibilityAssistantIds: ['assistant-1'],
    },
    writeDefaults: { compartments: [], projectIds: [] },
    authority,
    lifecycle: {
      abortSignal: new AbortController().signal,
      sessionId: 'session-1',
      channelType: 'web',
      channelId: 'channel-1',
    },
    ...overrides,
  }
}

describe('[COMP:security/execution-context] validated execution context', () => {
  it('preserves a finite empty grant and projects legacy fields once', () => {
    const execution = createExecutionContext(input())
    expect(execution.security.ceiling.compartments).toEqual([])
    expect(execution.security.ceiling.projectIds).toEqual([])
    expect(executionToolContext(execution, { appId: 'chat' })).toMatchObject({
      userId: 'actor-1',
      workspaceActorUserId: 'actor-1',
      workspaceId: 'workspace-1',
      compartments: [],
      projectIds: [],
      executionContext: execution,
    })
  })

  it('rejects missing axes, implicit ownership, and actor substitution', () => {
    expect(() => createExecutionContext(input({
      access: { ...input().access, compartments: undefined as never },
    }))).toThrow('access_ceiling_missing')
    expect(() => createExecutionContext(input({
      ownership: { kind: 'personal', ownerUserId: 'owner-1' },
    }))).toThrow('execution_ownership_mismatch')
    expect(() => createExecutionContext(input({
      identity: {
        kind: 'attended',
        principal: { kind: 'workspace_member', userId: 'billing-owner' },
      },
    }))).toThrow('execution_actor_mismatch')
  })

  it('intersects delegated authority with the parent and never turns empty into universal', () => {
    const execution = createExecutionContext(input({
      identity: {
        kind: 'delegated',
        actorUserId: 'actor-1',
        delegationId: 'consult-1',
        parentCeiling: {
          workspaceId: 'workspace-1',
          userId: 'actor-1',
          clearance: 'public',
          compartments: [],
          mutationCompartments: [],
          projectIds: [],
          visibilityAssistantIds: [],
        },
      },
      access: { ...input().access, compartments: null, mutationCompartments: null, projectIds: null },
    }))

    expect(execution.security.ceiling).toMatchObject({
      clearance: 'public',
      compartments: [],
      mutationCompartments: [],
      projectIds: [],
      visibilityAssistantIds: [],
    })
  })

  it('keeps programmatic credential ownership separate from the actor', () => {
    const execution = createExecutionContext(input({
      identity: {
        kind: 'programmatic',
        principal: { kind: 'brain_key', credentialId: 'key-1', actorUserId: 'actor-1' },
        credentialOwnerUserId: 'owner-1',
      },
      attribution: { credentialOwnerUserId: 'owner-1', billingUserId: 'payer-1' },
    }))
    expect(execution.security.access.userId).toBe('actor-1')
    expect(execution.attribution).toEqual({
      credentialOwnerUserId: 'owner-1',
      billingUserId: 'payer-1',
    })
  })

  it('allows exact public client self-memory only as an explicit programmatic capability', () => {
    expect(() => createExecutionContext(input({
      access: { ...input().access, clientSelfMemory: { compartment: 'client:abc' } },
      surface: { clientSelfMemory: { compartment: 'client:abc' } },
    }))).toThrow('execution_surface_mismatch:client_self_memory')

    const execution = createExecutionContext(input({
      identity: {
        kind: 'programmatic',
        principal: { kind: 'public_share', credentialId: 'share-1', actorUserId: 'actor-1' },
        credentialOwnerUserId: 'owner-1',
      },
      access: { ...input().access, clientSelfMemory: { compartment: 'client:abc' } },
      surface: { clientSelfMemory: { compartment: 'client:abc' } },
    }))
    expect(execution.security.access.clientSelfMemory).toEqual({ compartment: 'client:abc' })
  })
})
