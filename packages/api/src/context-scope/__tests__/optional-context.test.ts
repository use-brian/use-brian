import { describe, expect, it, vi } from 'vitest'
import { ContextScopeAccumulator, createExecutionContext, type ScopeSource } from '@use-brian/core'
import { readOptionalContext } from '../optional-context.js'

const source: ScopeSource = {
  workspaceId: 'workspace-1', userId: null, assistantId: null,
  sensitivity: 'internal', compartments: [], projectIds: [],
  resourceKind: 'memory', resourceId: 'memory-1', version: '1',
}
function setup() {
  const assertCurrent = vi.fn(async () => {})
  const execution = createExecutionContext({
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'user-1', authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId: 'workspace-1' },
    access: { workspaceId: 'workspace-1', userId: 'user-1', assistantId: 'assistant-1', assistantKind: 'standard',
      clearance: 'internal', compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: null, sharedAudience: true },
    writeDefaults: { compartments: [], projectIds: [] },
    authority: { assertCurrent, execute: operation => operation() },
    lifecycle: { abortSignal: new AbortController().signal, sessionId: 'session-1', channelType: 'web', channelId: 'thread-1' },
  })
  const accumulator = new ContextScopeAccumulator({ sources: [{ ...source, resourceKind: 'session_message', resourceId: 'required-input' }] })
  return { execution, accumulator, assertCurrent }
}

describe('[COMP:api/optional-context] source admission before prompt assembly', () => {
  it('withholds a private candidate and all reader-added evidence without poisoning required context', async () => {
    const input = setup(), before = input.accumulator.evidence
    const value = await readOptionalContext({ ...input,
      read: async candidate => {
        expect(candidate.accumulator).not.toBe(input.accumulator)
        candidate.accumulator.noteSource({ ...source, userId: 'user-1' })
        return 'PRIVATE MEMORY TEXT'
      }, evidence: () => ({}), fallback: '',
      authorize: async evidence => {
        expect(evidence.sources).toContainEqual(expect.objectContaining({ userId: 'user-1' }))
        return { allowed: false, reason: 'delivery_audience_unverified', diagnostic: 'user_visibility' }
      },
    })
    expect(value).toBe('')
    expect(input.accumulator.evidence).toEqual(before)
  })

  it('merges only admitted sources and preserves the original execution identity', async () => {
    const input = setup()
    const value = await readOptionalContext({ ...input,
      read: async candidate => { expect(candidate.execution).toBe(input.execution); return 'SHARED MEMORY TEXT' },
      evidence: () => ({ sources: [source] }), fallback: '',
      authorize: async evidence => ({ allowed: true, evidence }),
    })
    expect(value).toBe('SHARED MEMORY TEXT')
    expect(input.accumulator.evidence.sources).toContainEqual(source)
    expect(input.accumulator.evidence.sources).toContainEqual(expect.objectContaining({ resourceId: 'required-input' }))
  })

  it.each(['read', 'proof'] as const)('omits an optional %s failure but does not swallow a revoked invocation', async failure => {
    const input = setup(), before = input.accumulator.evidence
    const read = async () => { if (failure === 'read') throw new Error('source unavailable'); return 'hidden' }
    const options = { ...input, read, evidence: () => ({ sources: [source] }), fallback: '',
      authorize: vi.fn(async (): Promise<never> => { throw new Error('source unverifiable') }) }
    expect(await readOptionalContext(options)).toBe('')
    expect(input.accumulator.evidence).toEqual(before)
    input.assertCurrent.mockRejectedValueOnce(new Error('authority changed'))
    await expect(readOptionalContext(options)).rejects.toThrow('authority changed')
  })

  it('never treats unproven legacy text as unrestricted context', async () => {
    const input = setup(), authorize = vi.fn()
    expect(await readOptionalContext({ ...input, read: async () => 'UNPROVEN', evidence: () => ({}), fallback: '', authorize })).toBe('')
    expect(authorize).not.toHaveBeenCalled()
  })

  it('does not accumulate an empty query when none of its result or absence facts enters the prompt', async () => {
    const input = setup(), before = input.accumulator.evidence, authorize = vi.fn()
    expect(await readOptionalContext({ ...input,
      read: async candidate => { candidate.accumulator.noteSource(source); return [] as string[] },
      contributes: rows => rows.length > 0, evidence: () => ({}), fallback: [], authorize,
    })).toEqual([])
    expect(authorize).not.toHaveBeenCalled()
    expect(input.accumulator.evidence).toEqual(before)
  })
})
