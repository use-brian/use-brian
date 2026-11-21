import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createConfirmationResolver } from '../../mcp/types.js'
import type { ContentBlock, LLMProvider, Message, StreamChunk } from '../../providers/types.js'
import { ContextScopeAccumulator } from '../../security/context-scope.js'
import { buildTool, type Tool, type ToolContext } from '../../tools/types.js'
import { createLoopDetector } from '../loop-detector.js'
import { queryLoop, type QueryEvent } from '../query-loop.js'
import { createToolExecutor } from '../tool-executor.js'
import { applyOutputRevisions, queryOutputProvenance, type OutputRecord } from '../output-provenance.js'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'

const usage = { inputTokens: 1, outputTokens: 1 }
const canonical = { path: '/fictional/report', revision: 'fresh-42', text: 'Exact prepared arguments 🧪' }
const cases = [
  { label: 'NUL key', extra: { ['bad\0key']: 'untrusted' } },
  { label: 'NUL value', extra: { nested: [{ value: 'bad\0value' }] } },
  { label: 'unpaired high surrogate key', extra: { ['bad\ud800key']: 'untrusted' } },
  { label: 'unpaired low surrogate value', extra: { nested: [{ value: 'bad\udc00value' }] } },
]

// Independent JSONB text check: inspect decoded strings AND keys, not just
// JSON.stringify output (which escapes invalid Unicode and can hide the bug).
function expectSafe(value: unknown): void {
  if (typeof value === 'string') {
    expect(value).not.toMatch(/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { expectSafe(key); expectSafe(item) }
  }
}
function blocks(messages: Message[]): ContentBlock[] {
  return messages.flatMap(message => typeof message.content === 'string' ? [] : message.content)
}
function fixture() {
  const execute = vi.fn(async () => ({ data: 'must not execute after denial' }))
  const normalAsk = vi.fn(async () => true)
  const target = buildTool({ name: 'fictionalMcpWrite', description: 'Synthetic MCP ask-policy operation',
    inputSchema: z.object({ path: z.string(), revision: z.string(), text: z.string() }).strict(),
    resolveConfirmation: normalAsk, execute })
  const resolveToolCall = vi.fn((input: Record<string, unknown>) => ({ name: target.name, input }))
  const proxyExecute = vi.fn(async () => { throw new Error('Proxy must resolve, not execute') })
  const proxy = buildTool({ name: 'prepared_call', description: 'Deterministic host proxy',
    inputSchema: z.record(z.unknown()), resolveToolCall, execute: proxyExecute })
  const scopeAccumulator = new ContextScopeAccumulator()
  scopeAccumulator.noteProjectIds(['33333333-3333-4333-8333-333333333333'])
  const context: ToolContext = {
    userId: 'fixture-user', assistantId: 'fixture-assistant', sessionId: 'fixture-session',
    appId: 'fixture', channelType: 'web', channelId: 'fixture',
    abortSignal: new AbortController().signal, scopeAccumulator,
  }
  return { context, scopeAccumulator, execute, normalAsk, resolveToolCall, proxyExecute,
    tools: new Map<string, Tool>([[proxy.name, proxy], [target.name, target]]) }
}
function call(raw: string, id: string): StreamChunk[] {
  return [
    { type: 'message_start', model: 'fixture-model' },
    { type: 'tool_use_start', id, name: 'prepared_call' },
    // Split input to exercise the actual streamed argument buffer.
    { type: 'tool_use_delta', id, input: raw.slice(0, 17) },
    { type: 'tool_use_delta', id, input: raw.slice(17) },
    { type: 'tool_use_end', id },
    { type: 'message_end', stopReason: 'tool_use', usage },
  ]
}
const answer: StreamChunk[] = [
  { type: 'message_start', model: 'fixture-model' },
  { type: 'text_delta', text: 'The valid operation was declined.' },
  { type: 'message_end', stopReason: 'end_turn', usage },
]
function scripted(scripts: StreamChunk[][]) {
  const sent: Message[][] = []
  let turn = 0
  const dispatch = (messages: Message[]) => {
    sent.push(structuredClone(messages))
    const chunks = scripts[turn++]
    if (!chunks) throw new Error('Unexpected extra provider turn')
    return (async function* () { yield* chunks })()
  }
  const provider: LLMProvider = { name: 'fixture', models: ['fixture-model'],
    stream: options => dispatch(options.messages), createSession: () => ({ send: dispatch }) }
  return { provider, sent }
}

describe('[COMP:engine/rejected-tool-input] recovery without executable diagnostics', () => {
  for (const stateless of [false, true]) {
    it.each(cases)('$label retains exact evidence and reaches one normal ask (stateless=' + stateless + ')', async ({ extra }) => {
      const f = fixture()
      const original = { ...canonical, ...extra }
      const raw = JSON.stringify(original), originalCopy = structuredClone(original)
      const p = scripted([call(raw, 'rejected-1'), call(JSON.stringify(canonical), 'valid-2'), answer])
      const events: QueryEvent[] = [], snapshots: Message[][] = []
      const records = new Map<string, OutputRecord>()
      const resolver = createConfirmationResolver()
      const initialEvidence = structuredClone(f.scopeAccumulator.evidence)
      for await (const event of queryLoop({ provider: p.provider, model: 'fixture-model', systemPrompt: 'Fictional fixture',
        messages: [{ role: 'user', content: 'Use the exact prepared arguments.' }], tools: f.tools, context: f.context,
        ledger: NOOP_TURN_LEDGER, maxTurns: 3, stateless, confirmationResolver: resolver,
        onTurnEnd: (_turn, history) => { snapshots.push(structuredClone(history)) },
      })) {
        events.push(event)
        const provenance = queryOutputProvenance(event)
        expect(provenance?.qualified).toBe(true)
        applyOutputRevisions(records, provenance!)
        if (event.type === 'tool_confirmation_required') {
          expect(event.request).toMatchObject({ toolCallId: 'valid-2', input: canonical })
          resolver.resolve(event.request.toolCallId, 'deny')
        }
      }
      expect(records.size).toBe(3)
      expect([...records.values()].every(record => record.sealed)).toBe(true)
      for (const record of records.values()) {
        expect(record.response.content.some(block => block.type === 'tool_use' && block.id === 'rejected-1')).toBe(false)
      }
      expect(p.sent).toHaveLength(3)
      expect(f.normalAsk).toHaveBeenCalledOnce()
      expect(f.normalAsk).toHaveBeenCalledWith(expect.any(Object), canonical)
      expect(f.resolveToolCall).toHaveBeenCalledOnce()
      expect(f.resolveToolCall).toHaveBeenCalledWith(canonical, expect.any(Map))
      expect(f.execute).not.toHaveBeenCalled()
      expect(f.proxyExecute).not.toHaveBeenCalled()
      expect(original).toEqual(originalCopy)
      expect(JSON.stringify(original)).toBe(raw)
      expect(f.scopeAccumulator.evidence).toEqual(initialEvidence)
      expect(events.filter(event => event.type === 'tool_confirmation_required')).toHaveLength(1)
      const diagnostic = events.find(event => event.type === 'tool_input' && event.id === 'rejected-1')
      expect(diagnostic).toMatchObject({ input: { rejected: true, nonExecutable: true, record: expect.any(String) } })
      if (diagnostic?.type !== 'tool_input') throw new Error('Missing rejection event')
      const text = diagnostic.input.record as string
      expect(text).toMatch(/^Rejected tool call — NOT EXECUTED/)
      const record = JSON.parse(text.slice(text.indexOf('\n') + 1))
      expect(record).toMatchObject({ kind: 'rejected_tool_call', toolCallId: 'rejected-1', rawArgumentsJson: raw })
      expect(JSON.parse(record.rawArgumentsJson)).toEqual(original)
      const turns = events.filter(event => event.type === 'assistant_turn')
      expect(turns[0].response.content).toContainEqual({ type: 'text', text })
      expect(turns[0].toolResults.every(block => block.type === 'text')).toBe(true)
      for (const turn of turns) {
        expect(turn.response.content.some(block => block.type === 'tool_use' && block.id === 'rejected-1')).toBe(false)
        expect(turn.toolResults.some(block => block.type === 'tool_result' && block.toolUseId === 'rejected-1')).toBe(false)
      }
      const feedback = blocks(p.sent[1])
      expect(feedback.some(block => block.type === 'tool_use' && block.id === 'rejected-1')).toBe(false)
      if (stateless) {
        expect(feedback.some(block => block.type === 'tool_result' && block.toolUseId === 'rejected-1')).toBe(false)
        expect(feedback.some(block => block.type === 'text' && block.text.includes('NOT EXECUTED'))).toBe(true)
      } else {
        expect(feedback).toContainEqual(expect.objectContaining({ type: 'tool_result', toolUseId: 'rejected-1', isError: true }))
      }
      expectSafe(events)
      expectSafe(snapshots)
      expectSafe(p.sent)
      expect(events).toContainEqual({ type: 'text_delta', text: 'The valid operation was declined.' })

      if (stateless) {
        // JSON serialization models a durable checkpoint/reload, not shared
        // object identity or the rejection-text authorship WeakSet.
        const replayHistory: Message[] = JSON.parse(JSON.stringify(snapshots.at(-1)))
        const replay = scripted([answer])
        for await (const _event of queryLoop({ provider: replay.provider, model: 'fixture-model', systemPrompt: 'Replay',
          messages: replayHistory, tools: f.tools, context: f.context, ledger: NOOP_TURN_LEDGER, stateless: true, maxTurns: 1,
        })) { /* drain */ }
        const replayBlocks = blocks(replay.sent[0])
        expect(replayBlocks.some(block => block.type === 'tool_use' && block.id === 'rejected-1')).toBe(false)
        expect(replayBlocks.some(block => block.type === 'tool_result' && block.toolUseId === 'rejected-1')).toBe(false)
        expect(f.resolveToolCall).toHaveBeenCalledOnce()
        expect(f.normalAsk).toHaveBeenCalledOnce()
        expectSafe(replay.sent)
      }
    })
  }

  it.each(['max_tokens','incomplete'] as const)('settles the original stateful rejected call before recovery after %s',async stopReason=>{
    const f=fixture(),first=call(JSON.stringify({...canonical,['bad\0key']:true}),'rejected-1')
    first[first.length-1]={type:'message_end',stopReason,usage}
    const p=scripted([first,call(JSON.stringify(canonical),'valid-2'),answer]),resolver=createConfirmationResolver()
    for await(const event of queryLoop({provider:p.provider,model:'fixture-model',systemPrompt:'Fixture',messages:[{role:'user',content:'Use prepared arguments'}],
      tools:f.tools,context:f.context,ledger:NOOP_TURN_LEDGER,maxTurns:3,confirmationResolver:resolver})){
      if(event.type==='tool_confirmation_required')resolver.resolve(event.request.toolCallId,'deny')
    }
    expect(blocks(p.sent[1])).toContainEqual(expect.objectContaining({type:'tool_result',toolUseId:'rejected-1',isError:true}))
    expect(f.normalAsk).toHaveBeenCalledOnce();expect(f.execute).not.toHaveBeenCalled();expectSafe(p.sent)
  })

  it.each([false,true])('rechecks revocation before recovery dispatch (stateless=%s)',async stateless=>{
    const f=fixture(),before=structuredClone(f.scopeAccumulator.evidence)
    const p=scripted([call(JSON.stringify({...canonical,['bad\0key']:true}),'rejected-1'),call(JSON.stringify(canonical),'valid-2')])
    let revoked=false
    f.context.admitModelInput=async()=>{if(revoked)throw new Error('Synthetic source authority withdrawn')}
    let failure:unknown
    try{
      for await(const event of queryLoop({provider:p.provider,model:'fixture-model',systemPrompt:'Fixture',messages:[{role:'user',content:'Test rejection recovery'}],
        tools:f.tools,context:f.context,ledger:NOOP_TURN_LEDGER,stateless,maxTurns:2})){
        if(event.type==='assistant_turn')revoked=true
      }
    }catch(error){failure=error}
    expect(failure).toMatchObject({reason:'authority_changed',retrySafe:false})
    expect(p.sent).toHaveLength(1);expect(f.normalAsk).not.toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled()
    expect(f.scopeAccumulator.evidence).toEqual(before)
  })

  it.each([false,true])('honors cancellation before recovery dispatch (stateless=%s)',async stateless=>{
    const f=fixture(),controller=new AbortController(),before=structuredClone(f.scopeAccumulator.evidence)
    f.context.abortSignal=controller.signal
    const p=scripted([call(JSON.stringify({...canonical,['bad\0key']:true}),'rejected-1'),call(JSON.stringify(canonical),'valid-2')])
    try{
      for await(const event of queryLoop({provider:p.provider,model:'fixture-model',systemPrompt:'Fixture',messages:[{role:'user',content:'Test rejection cancellation'}],
        tools:f.tools,context:f.context,ledger:NOOP_TURN_LEDGER,stateless,maxTurns:2})){
        if(event.type==='assistant_turn')controller.abort()
      }
    }catch(error){expect(controller.signal.aborted).toBe(true)}
    expect(p.sent).toHaveLength(1);expect(f.normalAsk).not.toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled()
    expect(f.scopeAccumulator.evidence).toEqual(before)
  })

  it.each(['{"value":','null','[]','"not an object"','{"bad":"literal\0"}'])('does not execute empty defaults after malformed/non-object JSON %j',async raw=>{
    const f=fixture(),p=scripted([call(raw,'malformed-1'),answer]),events:QueryEvent[]=[]
    for await(const event of queryLoop({provider:p.provider,model:'fixture-model',systemPrompt:'Fixture',messages:[{role:'user',content:'Test parser rejection'}],
      tools:f.tools,context:f.context,ledger:NOOP_TURN_LEDGER,maxTurns:2,stateless:true}))events.push(event)
    expect(f.resolveToolCall).not.toHaveBeenCalled();expect(f.normalAsk).not.toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled()
    const turn=events.find(event=>event.type==='assistant_turn')
    const text=turn?.type==='assistant_turn'?turn.response.content.find(block=>block.type==='text'):undefined
    if(text?.type!=='text')throw new Error('Missing rejected parse record')
    expect(JSON.parse(text.text.split('\n').slice(1).join('\n')).rawArgumentsJson).toBe(raw)
    expectSafe(events);expectSafe(p.sent)
    expect(blocks(p.sent[1]).some(block=>block.type==='tool_use'||block.type==='tool_result')).toBe(false)
  })

  it('refuses to execute an event diagnostic preview even for an all-optional tool',async()=>{
    const execute=vi.fn(async()=>({data:'must not execute'})),resolveConfirmation=vi.fn(async()=>true)
    const tool=buildTool({name:'optional_action',description:'Synthetic optional operation',inputSchema:z.object({value:z.string().optional()}),execute,resolveConfirmation})
    const f=fixture(),executor=createToolExecutor({tools:new Map([[tool.name,tool]]),context:f.context,loopDetector:createLoopDetector()})
    executor.addTool('replayed-preview',tool.name,{rejected:true,nonExecutable:true,record:'Rejected tool call — NOT EXECUTED. synthetic diagnostic'})
    const results:ContentBlock[]=[]
    for await(const batch of executor.getRemainingResults())results.push(...batch.blocks)
    expect(results).toContainEqual(expect.objectContaining({type:'tool_result',isError:true,content:expect.stringContaining('non-executable')}))
    expect(execute).not.toHaveBeenCalled();expect(resolveConfirmation).not.toHaveBeenCalled()
  })

  it.each(cases)('rejects $label before executor resolution, policy and execution hooks without mutating caller input', async ({ extra }) => {
    const f = fixture(), input = { ...canonical, ...extra }, before = structuredClone(input)
    const onToolStart = vi.fn(), onToolEnd = vi.fn(), onToolCallResolved = vi.fn(), onConfirmationRequired = vi.fn()
    const executor = createToolExecutor({ tools: f.tools, context: f.context, loopDetector: createLoopDetector(),
      onToolStart, onToolEnd, onToolCallResolved, onConfirmationRequired,
      confirmationResolver: { resolve: () => {}, waitForDecision: async () => ({ decision: 'deny' }) },
    })
    executor.addTool('rejected-direct', 'prepared_call', input)
    const results: ContentBlock[] = []
    for await (const batch of executor.getRemainingResults()) results.push(...batch.blocks)
    expect(results).toEqual([expect.objectContaining({ type: 'tool_result', isError: true, content: expect.stringContaining('NOT executed') })])
    for (const spy of [f.resolveToolCall, f.normalAsk, f.execute, f.proxyExecute,
      onToolStart, onToolEnd, onToolCallResolved, onConfirmationRequired]) expect(spy).not.toHaveBeenCalled()
    expect(input).toEqual(before)
    expectSafe(results)
  })
})
