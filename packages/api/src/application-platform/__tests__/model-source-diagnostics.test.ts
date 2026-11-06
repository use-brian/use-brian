import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { ContextScopeAccumulator, createExecutionContext, executionToolContext } from '@use-brian/core'
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import { assertSourceModelInputAuthority, assertSourceModelOutputAuthority } from '../model-source-authority.js'
import { chatTurnErrorEvent } from '../../routes/chat.js'

function fixture(cause: unknown) {
  const userId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID()
  const assertCurrent = vi.fn(async () => { throw cause })
  const execution = createExecutionContext({
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId, authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId },
    access: { workspaceId, userId, assistantId, assistantKind: 'primary', clearance: 'internal',
      compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [] },
    authority: { assertCurrent, execute: async operation => operation() },
    writeDefaults: { compartments: [], projectIds: [] },
    lifecycle: { sessionId: randomUUID(), channelId: 'fixture', channelType: 'web', abortSignal: new AbortController().signal },
  })
  const accumulator = new ContextScopeAccumulator()
  accumulator.note({ sources: [{ workspaceId, userId, assistantId, sensitivity: 'internal', compartments: [], projectIds: [],
    resourceKind: 'memory', resourceId: randomUUID(), version: '1' }] })
  return { context: { ...executionToolContext(execution, { appId: 'diagnostic-fixture' }), scopeAccumulator: accumulator }, assertCurrent }
}

describe('[COMP:api/external-source-access] private source failure diagnostics', () => {
  it.each([assertSourceModelInputAuthority, assertSourceModelOutputAuthority])(
    'preserves the cause for server logs without exposing it on the chat wire or allowing another admission', async guard => {
      const databaseError = Object.assign(new Error('Fictional private database timeout'), { code: '57014' })
      const cause = new Error('Fictional verification failed', { cause: databaseError })
      const f = fixture(cause)
      const error = await guard(f.context).catch(error => error)
      expect(error).toBeInstanceOf(SourceProtocolError)
      expect(error).toMatchObject({ code: 'source_unavailable', reason: 'authority_changed', retrySafe: false })
      expect(error.cause).toBe(cause)
      expect(inspect(error)).toContain('57014')
      expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false)
      expect(JSON.stringify(error)).not.toContain('Fictional')
      expect(chatTurnErrorEvent(error)).toEqual({ code: 'authority_changed', error: 'source_unavailable', operationMayHaveExecuted: undefined })
      expect(JSON.stringify(chatTurnErrorEvent(error))).not.toContain('Fictional')
      await expect(guard(f.context)).rejects.toMatchObject({ code: 'source_access_denied', retrySafe: false })
      expect(f.assertCurrent).toHaveBeenCalledTimes(1)
    },
  )

  it('retains an existing protocol error and its original cause', async () => {
    const original = new SourceProtocolError('source_access_denied')
    Object.defineProperty(original, 'cause', { value: new Error('Fictional original refusal') })
    const f = fixture(original)
    await expect(assertSourceModelInputAuthority(f.context)).rejects.toBe(original)
    expect(original.cause).toBeInstanceOf(Error)
  })
})
