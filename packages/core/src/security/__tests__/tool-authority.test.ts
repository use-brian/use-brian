import { bindWorkspaceCredentialDelegation, workspaceCredentialDelegation } from '../workspace-delegation.js'
import { parseAuthoringAuthority } from '../access-ceiling.js'
import { describe, expect, it } from 'vitest'
import { createExecutionContext, executionToolContext } from '../execution-context.js'
import { pinToolAuthoringAuthority } from '../tool-authority.js'
import type { ToolContext } from '../../tools/types.js'

function context(): ToolContext {
  const execution = createExecutionContext({
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'actor' } },
    ownership: { kind: 'workspace', workspaceId: 'workspace' },
    access: { userId: 'actor', workspaceId: 'workspace', assistantId: 'assistant', assistantKind: 'standard',
      clearance: 'confidential', compartments: null, mutationCompartments: null, projectIds: null,
      visibilityAssistantIds: ['assistant'], departmentRead: {
        workspaceId: 'workspace', userId: 'actor', assistantId: 'assistant', base: 'public',
        departments: { research: 'internal' }, contextDepartment: 'research', binding: ['research'], cap: 'internal',
      } },
    writeDefaults: { compartments: [], projectIds: [] },
    authority: { assertCurrent: async () => {}, execute: async operation => operation() },
    lifecycle: { sessionId: 'session', channelType: 'web', channelId: 'web', abortSignal: new AbortController().signal },
  })
  return executionToolContext(execution, { appId: 'fixture' })
}

describe('[COMP:security/access-ceiling] tool authoring department consent', () => {
  it('persists only the host-bound parent and rejects malformed durable replacements', () => {
    const userId='10000000-0000-4000-8000-000000000001',workspaceId='10000000-0000-4000-8000-000000000002',assistantId='10000000-0000-4000-8000-000000000003';
    const parent={kind:'oauth_token' as const,credentialId:'10000000-0000-4000-8000-000000000004',revision:'a'.repeat(64),userId,workspaceId,assistantId,sessionId:'10000000-0000-4000-8000-000000000005'};
    const execution=createExecutionContext({identity:{kind:'programmatic',principal:{kind:'oauth_token',credentialId:parent.credentialId,actorUserId:userId},credentialOwnerUserId:userId},
      ownership:{kind:'workspace',workspaceId},access:{userId,workspaceId,assistantId,assistantKind:'primary',clearance:'internal',compartments:[],mutationCompartments:[],projectIds:[],visibilityAssistantIds:[]},
      writeDefaults:{compartments:[],projectIds:[]},authority:{assertCurrent:async()=>{},execute:async work=>work()},
      lifecycle:{sessionId:parent.sessionId,sessionPersisted:true,channelType:'programmatic',channelId:parent.credentialId,abortSignal:new AbortController().signal}});
    const tool=executionToolContext(execution,{appId:'fixture'});
    expect(pinToolAuthoringAuthority({...tool,workspaceDelegation:parent} as ToolContext).workspaceDelegation).toBeUndefined();
    bindWorkspaceCredentialDelegation(execution,parent);
    const saved=pinToolAuthoringAuthority(tool);
    expect(parseAuthoringAuthority(JSON.parse(JSON.stringify(saved)))?.workspaceDelegation).toEqual(parent);
    expect(workspaceCredentialDelegation({...execution})).toBeUndefined();
    expect(parseAuthoringAuthority({...saved,workspaceDelegation:{...parent,revision:'invalid'}})).toBeNull();
    expect(parseAuthoringAuthority({...saved,workspaceDelegation:{...parent,userId:assistantId}})).toBeNull();
    parent.revision='b'.repeat(64);
    expect(workspaceCredentialDelegation(execution)?.revision).toBe('a'.repeat(64));
  });

  it('retains the complete execution department ceiling across the compatibility projection', () => {
    const ctx = context()
    const pinned = pinToolAuthoringAuthority(ctx)
    expect(pinned.ceiling.departmentRead).toEqual(ctx.executionContext!.security.ceiling.departmentRead)
    expect(pinned.ceiling.departmentRead).toMatchObject({ base: 'public', departments: { research: 'internal' },
      contextDepartment: 'research', binding: ['research'], cap: 'internal' })
  })
  it('does not let broader flat fields replace the frozen execution ceiling', () => {
    const ctx = context()
    const access = ctx.executionContext!.security.access
    const execution = { ...ctx.executionContext!, security: { ...ctx.executionContext!.security,
      access: { ...access, clearance: 'public' as const, projectIds: ['project'] },
      ceiling: { ...ctx.executionContext!.security.ceiling, clearance: 'public' as const, projectIds: ['project'] },
    } }
    expect(pinToolAuthoringAuthority({ ...ctx, executionContext: execution }).ceiling).toMatchObject({
      clearance: 'public', projectIds: ['project'], departmentRead: { binding: ['research'] },
    })
  })
  it.each(['userId', 'workspaceId', 'assistantId'] as const)('refuses a mismatched %s instead of falling back to flat authority', field => {
    expect(() => pinToolAuthoringAuthority({ ...context(), [field]: 'other' })).toThrow()
  })
  it('refuses malformed execution authority despite valid legacy fields', () => {
    const ctx = context()
    const execution = { ...ctx.executionContext!, security: { ...ctx.executionContext!.security,
      ceiling: { ...ctx.executionContext!.security.ceiling, departmentRead: { ...ctx.executionContext!.security.ceiling.departmentRead!, binding: undefined } },
    } }
    expect(() => pinToolAuthoringAuthority({ ...ctx, executionContext: execution as never })).toThrow()
  })
  it('detaches saved consent from later nested mutation', () => {
    const ctx = context()
    const saved = pinToolAuthoringAuthority(ctx)
    const original = ctx.executionContext!.security.ceiling.departmentRead!
    ;(original.departments as Record<string, string>).research = 'confidential'
    ;(original.binding as string[]).push('operations')
    expect(saved.ceiling.departmentRead).toMatchObject({ departments: { research: 'internal' }, binding: ['research'] })
  })
  it('retains the explicit legacy fallback only when no execution context exists', () => {
    const { executionContext: _execution, ...legacy } = context()
    const saved = pinToolAuthoringAuthority(legacy)
    expect(saved.ceiling.departmentRead).toBeUndefined()
    expect(saved.ceiling.clearance).toBe('confidential')
    expect(() => pinToolAuthoringAuthority({ ...legacy, compartments: undefined })).toThrow()
  })
})
