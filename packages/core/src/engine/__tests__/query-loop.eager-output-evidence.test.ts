import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createConfirmationResolver } from '../../mcp/types.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'
import { ContextScopeAccumulator, type ScopeEvidence } from '../../security/context-scope.js'
import { buildTool, type ToolContext } from '../../tools/types.js'
import { assertModelOutputAuthority, queryLoop, type QueryEvent } from '../query-loop.js'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const projectId = '33333333-3333-4333-8333-333333333333'
const source = {
  workspaceId: '11111111-1111-4111-8111-111111111111', userId: null, assistantId: null,
  resourceKind: 'memory', resourceId: '22222222-2222-4222-8222-222222222222',
  version: '1', sensitivity: 'internal' as const, compartments: ['result-only'], projectIds: [projectId],
}

// Engine integration only: the output callback below models fresh admission of a
// superseded *successful* candidate. It is not the API authority implementation;
// that guard's native evidence/admission behavior must be tested in the API suite.
// No executor/provider mocks, clocks, sleeps, paid models, or database are used.
describe('[COMP:engine/eager-output-evidence] real queryLoop + toolExecutor', () => {
  function fixture(count: number, approval = false, candidateFails = false) {
    const releaseTools = deferred(), allStarted = deferred(), noted = deferred()
    const captured = deferred(), releaseCandidate = deferred()
    const accumulator = new ContextScopeAccumulator()
    const resolver = createConfirmationResolver()
    const events: QueryEvent[] = [], timeline: string[] = []
    const candidates: ScopeEvidence[] = [], admissions: ScopeEvidence[] = [], inputs: ScopeEvidence[] = []
    let active = 0, started = 0, finished = 0, streamEnded = false, armCandidate = false
    let suspendedSnapshot: ScopeEvidence | undefined
    const denial = new Error('Fictional actual admission failure')
    const tool = buildTool({
      name: 'observe', description: 'Read a fictional Project record', inputSchema: z.object({ index: z.number() }),
      isReadOnly: true, isConcurrencySafe: true, requiresConfirmation: approval,
      async execute({ index }, current) {
        active++; started++; timeline.push(`start:${index}`)
        if (started === count) allStarted.resolve()
        try {
          await releaseTools.promise
          // The native reader raises high-water synchronously while output's
          // earlier, empty candidate is still awaiting admission.
          current.scopeAccumulator!.noteProjectIds([projectId])
          timeline.push(`note:${index}`)
          finished++
          if (finished === count) noted.resolve()
          return { data: { value: `Fictional Project record ${index}` }, scopeEvidence: { sources: [source] } }
        } finally { active-- }
      },
    })
    const send = vi.fn(() => (async function* (): AsyncGenerator<StreamChunk> {
      const turn = send.mock.calls.length
      yield { type: 'message_start', model: 'fixture-model' }
      if (turn === 1) {
        for (let index = 0; index < count; index++) {
          const id = `call-${index}`
          yield { type: 'tool_use_start', id, name: 'observe' }
          yield { type: 'tool_use_delta', id, input: JSON.stringify({ index }) }
          yield { type: 'tool_use_end', id }
        }
        // This cannot resolve if tools are deferred until stream completion;
        // for count=2 it also cannot resolve if safe tools execute serially.
        await allStarted.promise
        armCandidate = true
        yield { type: 'thinking_delta', text: 'Fictional overlapping reasoning' }
        streamEnded = true
        timeline.push('stream-end')
        yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
      } else {
        yield { type: 'text_delta', text: 'Final answer admitted with Project floor' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
      }
    })())
    const createSession = vi.fn(() => ({ send }))
    const provider: LLMProvider = {
      name: 'fixture', models: ['fixture-model'], createSession,
      stream: () => { throw new Error('Unexpected stateless fallback') },
    }
    const output = vi.fn(async (current: ToolContext) => {
      // Candidate success may be superseded; errors are never caught/retried.
      for (;;) {
        const snapshot = current.scopeAccumulator!.evidence
        candidates.push(snapshot)
        if (armCandidate) {
          armCandidate = false
          suspendedSnapshot = snapshot
          timeline.push('candidate-captured')
          captured.resolve()
          await releaseCandidate.promise
          if (candidateFails) throw denial
        }
        if (JSON.stringify(snapshot) !== JSON.stringify(current.scopeAccumulator!.evidence)) {
          timeline.push('fresh-admission')
          continue
        }
        admissions.push(snapshot)
        return
      }
    })
    const context: ToolContext = {
      userId: 'fictional-user', assistantId: 'fictional-assistant', sessionId: 'fictional-session',
      appId: 'fixture', channelType: 'web', channelId: 'fixture', abortSignal: new AbortController().signal,
      // queryLoop projects the context; share the production invocation identity
      // so final-sink checks and subsequent loops observe the same sticky latch.
      executionContext: {} as NonNullable<ToolContext['executionContext']>,
      scopeAccumulator: accumulator, assertModelOutputAuthority: output,
      assertModelInputAuthority: async current => { inputs.push(current.scopeAccumulator!.evidence) },
    }
    const run = async () => {
      for await (const event of queryLoop({
        provider, model: 'fixture-model', systemPrompt: 'Fictional context',
        messages: [{ role: 'user', content: 'Read fictional Project records' }],
        tools: new Map([['observe', tool]]), context, ledger: NOOP_TURN_LEDGER, maxTurns: 2,
        ...(approval ? { confirmationResolver: resolver } : {}),
      })) {
        events.push(event)
        if (event.type === 'tool_confirmation_required') resolver.resolve(event.request.toolCallId, 'allow')
      }
    }
    return {
      run, events, context, accumulator, send, createSession, output, inputs, candidates, admissions, timeline,
      captured, releaseTools, noted, releaseCandidate, denial,
      state: () => ({ active, started, streamEnded, suspendedSnapshot }),
    }
  }

  it.each([
    { count: 1, approval: false }, { count: 2, approval: false }, { count: 2, approval: true },
  ])('freshly admits overlapping output, tool results and final answer ($count tools, approval=$approval)', async ({ count, approval }) => {
    const f = fixture(count, approval)
    const running = f.run()
    try {
      await f.captured.promise
      expect(f.state()).toMatchObject({ active: count, started: count, streamEnded: false })
      expect(f.state().suspendedSnapshot?.projectIds).toEqual([])
      expect(f.accumulator.projectIds).toEqual([])
      expect(f.events.some(e => e.type === 'thinking_delta')).toBe(false)
      expect(f.events.filter(e => e.type === 'tool_confirmation_required')).toHaveLength(approval ? count : 0)
      f.releaseTools.resolve()
      await f.noted.promise
      expect(f.accumulator.projectIds).toEqual([projectId])
      expect(f.state().streamEnded).toBe(false)
      // The suspended successful proof must not itself release this event.
      expect(f.events.some(e => e.type === 'thinking_delta')).toBe(false)
      f.releaseCandidate.resolve()
      await running
    } finally {
      f.releaseTools.resolve(); f.releaseCandidate.resolve()
      await running.catch(() => {})
    }
    expect(f.timeline.indexOf('fresh-admission')).toBeGreaterThan(f.timeline.indexOf(`note:${count - 1}`))
    expect(f.timeline.indexOf('stream-end')).toBeGreaterThan(f.timeline.indexOf('fresh-admission'))
    expect(f.admissions.some(snapshot => snapshot.projectIds?.includes(projectId))).toBe(true)
    expect(f.accumulator.evidence).toMatchObject({ projectIds: [projectId], compartments: ['result-only'], sources: [source] })
    const results = f.events.flatMap(event => event.type === 'tool_result' ? event.results : [])
    expect(results).toHaveLength(count)
    for (let index = 0; index < count; index++) {
      expect(results).toContainEqual(expect.objectContaining({ type: 'tool_result', toolUseId: `call-${index}`, content: expect.stringContaining(`Fictional Project record ${index}`) }))
    }
    expect(JSON.stringify(results)).not.toContain('scopeEvidence')
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.inputs[0]?.projectIds).toEqual([])
    expect(f.inputs.at(-1)).toMatchObject({ projectIds: [projectId], sources: [source] })
    expect(f.admissions.at(-1)).toMatchObject({ projectIds: [projectId], sources: [source] })
    expect(f.events).toContainEqual({ type: 'text_delta', text: 'Final answer admitted with Project floor' })
    // A successful candidate superseded by evidence must not poison the context.
    await expect(assertModelOutputAuthority(f.context)).resolves.toBeUndefined()
  })

  it('keeps an actual candidate error sticky even when its empty snapshot was superseded', async () => {
    const f = fixture(1, false, true)
    const running = f.run()
    // Attach rejection handling before releasing the deliberately failing proof.
    const rejected = expect(running).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false, cause: f.denial })
    try {
      await f.captured.promise
      expect(f.state()).toMatchObject({ active: 1, streamEnded: false })
      expect(f.state().suspendedSnapshot?.projectIds).toEqual([])
      f.releaseTools.resolve()
      await f.noted.promise
      expect(f.accumulator.projectIds).toEqual([projectId])
      f.releaseCandidate.resolve()
      await rejected
    } finally {
      f.releaseTools.resolve(); f.releaseCandidate.resolve()
      await running.catch(() => {})
    }
    expect(f.timeline).not.toContain('fresh-admission')
    expect(f.events.some(event => event.type === 'thinking_delta' || event.type === 'tool_result' || event.type === 'text_delta')).toBe(false)
    expect(f.send).toHaveBeenCalledTimes(1)
    f.context.assertModelOutputAuthority = async () => {}
    await expect(assertModelOutputAuthority(f.context)).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    await expect(f.run()).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect(f.createSession).toHaveBeenCalledTimes(1)
    expect(f.send).toHaveBeenCalledTimes(1)
  })
})
