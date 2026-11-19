/** [COMP:api/turn-kernel] Reply publication under the original owner (plan
 * section 3.3, D9). One writer serves every lane: it chooses the existing store
 * operation exactly as the displaced adapter branches did, while the owner (never
 * the adapter) supplies the lease pin, the terminal binding and the durable
 * completion state. Store operations are mocked here; their SQL keeps its own
 * opening, pre-commit and post-commit checks (database suites).
 * Spec: docs/architecture/engine/turn-kernel.md "Reply publication". */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tx = vi.hoisted(() => ({ query: vi.fn(async (_sql: string) => ({ rows: [] })), release: vi.fn() }))
vi.mock('../../db/notify-listener.js', () => ({ registerNotifyChannel: vi.fn(), startNotifyListener: vi.fn() }))
vi.mock('../../db/client.js', async importOriginal => ({ ...await importOriginal<object>(), getPool: () => ({ connect: async () => tx }) }))
// The stored writer is the real store function over the mocked row writer and pool.
const recordCompletion = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('../../db/conversation-publication-recovery.js', async importOriginal => ({
  ...await importOriginal<object>(), recordTurnCompletion: recordCompletion }))
vi.mock('../../db/conversation-store.js', async importOriginal => ({
  publishStoredTurnPublication: (await importOriginal<typeof import('../../db/conversation-store.js')>()).publishStoredTurnPublication,
  publishNativeSessionMessageBatch: vi.fn(async (input: { messages: unknown[] }) => input.messages.map((row, index) => ({ id: `native-${index}`, sequenceNum: index + 1, ...row as object }))),
  publishBufferedWebConversation: vi.fn(async (input: { messages: unknown[]; terminalBinding: (rows: unknown[]) => unknown }) => {
    input.terminalBinding(input.messages)
    return input.messages.map((row, index) => ({ id: `buffered-${index}`, sequenceNum: index + 1, ...row as object }))
  }),
}))
vi.mock('../../db/sessions.js', () => ({
  claimTurnLeaseOutcome: vi.fn(async () => ({ token: 'fixture-token', turnId: null })),
  releaseTurnOutcome: vi.fn(async (_id: string, reason: string) => ({ turnId: null, reason })),
  touchTurnLease: vi.fn(async () => ({ held: true, cancelRequested: false })), TURN_HEARTBEAT_INTERVAL_MS: 60_000,
  addSessionMessage: vi.fn(async (row: object) => ({ id: 'stored-row', sequenceNum: 1, createdAt: new Date(), ...row })),
}))

import type { ContentBlock } from '@use-brian/agent-runtime/providers/types.js'
import { publishBufferedWebConversation, publishNativeSessionMessageBatch } from '../../db/conversation-store.js'
import { addSessionMessage } from '../../db/sessions.js'
import { assembleTurnPublication, writeTurnPublication, type TurnPublicationOwnerPort } from '../publication.js'
import { openAssistantTurn } from '../kernel.js'

const native = { execution: { id: 'fixture-execution' }, accumulator: {} } as never
const derivation = { derivation: { producer: 'turn:fixture', sources: [] } }
const scope = { scope: { workspaceId: 'fixture-workspace' } as never }
const reply = [{ role: 'assistant' as const, content: [{ type: 'text', text: 'Fictional reply.' }] }]
const port = (over: Partial<TurnPublicationOwnerPort> = {}): TurnPublicationOwnerPort =>
  ({ sessionId: 'fixture-session', token: 'fixture-token', operationId: '00000000-0000-4000-8000-0000000000aa', stopped: false,
    bindTerminal: vi.fn(() => ({}) as never), ...over })
const execute = vi.fn(<T,>(operation: () => Promise<T>) => operation()) as unknown as (<T>(operation: () => Promise<T>) => Promise<T>) & ReturnType<typeof vi.fn>

beforeEach(() => { vi.clearAllMocks() })

describe('[COMP:api/turn-kernel] writeTurnPublication', () => {
  it('pins the owner token on the native batch, or the stopped token for a stopped buffer', async () => {
    for (const stopped of [false, true]) {
      vi.mocked(publishNativeSessionMessageBatch).mockClear()
      await writeTurnPublication(port({ stopped }), { disposition: 'reply', rows: reply, write: derivation, native, execute,
        pendingAnnotation: { fixture: true } })
      expect(publishNativeSessionMessageBatch).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'fixture-session', authority: native,
        derivation: derivation.derivation, messages: reply,
        publication: { pendingAnnotation: { fixture: true }, ...(stopped ? { stoppedTurnToken: 'fixture-token' } : { turnToken: 'fixture-token' }) } }))
    }
    expect(addSessionMessage).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('binds the shared-web buffered root through the owner, never the adapter', async () => {
    const owner = port(), root = { operationId: 'fixture-operation' } as never
    await writeTurnPublication(owner, { disposition: 'reply', rows: reply, write: derivation, native, execute,
      buffered: { root, selectedOrdinals: [0] } })
    expect(publishBufferedWebConversation).toHaveBeenCalledWith(expect.objectContaining({ operation: root }))
    expect(owner.bindTerminal).toHaveBeenCalledWith(root, native, reply, [0])
    expect(publishNativeSessionMessageBatch).not.toHaveBeenCalled()
  })

  it('uses the stored writer inside the adapter bracket: one row directly, several in one transaction', async () => {
    const [single] = await writeTurnPublication(port(), { disposition: 'reply', rows: reply, write: scope, native: null, execute })
    expect(single).toMatchObject({ id: 'stored-row', role: 'assistant', scope: scope.scope, sessionId: 'fixture-session' })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(tx.query).not.toHaveBeenCalled()
    const rows = [...reply, { role: 'user' as const, content: [{ type: 'tool_result', toolUseId: 'call', content: 'done' }] }]
    expect(await writeTurnPublication(port(), { disposition: 'reply', rows, write: scope, native: null, execute })).toHaveLength(2)
    expect(tx.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(vi.mocked(addSessionMessage).mock.calls.slice(1).every(([, client]) => (client as unknown) === tx)).toBe(true)
    expect(tx.release).toHaveBeenCalledOnce()
  })

  it('rolls back the stored transaction and releases its client on failure', async () => {
    vi.mocked(addSessionMessage).mockResolvedValueOnce({ id: 'first' } as never).mockRejectedValueOnce(new Error('Fictional write failure'))
    await expect(writeTurnPublication(port(), { disposition: 'reply', rows: [...reply, ...reply], write: scope, native: null, execute }))
      .rejects.toThrow('Fictional write failure')
    expect(tx.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK'])
    expect(tx.release).toHaveBeenCalledOnce()
  })

  it('refuses a terminal binding or annotation without native authority, and authority inside the write', async () => {
    await expect(writeTurnPublication(port(), { disposition: 'reply', rows: reply, write: scope, native, execute,
      buffered: { root: {} as never, selectedOrdinals: null } })).rejects.toThrow('require the native writer')
    await expect(writeTurnPublication(port(), { disposition: 'reply', rows: reply, write: scope, native: null, execute,
      pendingAnnotation: {} })).rejects.toThrow('require the native writer')
    await expect(writeTurnPublication(port(), { disposition: 'reply', rows: reply, write: { ...derivation, authority: native } as never, native, execute }))
      .rejects.toThrow('belongs to the publication request')
    expect(publishNativeSessionMessageBatch).not.toHaveBeenCalled()
    expect(addSessionMessage).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/turn-kernel] assembleTurnPublication', () => {
  const text = (value: string): ContentBlock => ({ type: 'text', text: value })
  const call = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'readThing', input: {} })
  it('keeps tool pairing, stubs missing results and puts attachments only on the last round', () => {
    const attachments = [{ fileId: 'fixture-file' }] as never
    const { rows, assistantRows, ordinals } = assembleTurnPublication([
      { content: [text('Checking.'), call('a'), call('b')], toolResults: [{ type: 'tool_result', toolUseId: 'a', content: 'ok' } as never], origin: 'o1' },
      { content: [], toolResults: [] },
      { content: [text('Final.')], toolResults: [], origin: 'o2' },
    ], { reason: 'Fictional stub', sender: { senderAssistantId: 'fixture-assistant' }, attachments })
    expect(rows.map(row => row.role)).toEqual(['assistant', 'user', 'assistant'])
    expect((rows[1]!.content as { toolUseId: string }[]).map(block => block.toolUseId)).toEqual(['a', 'b'])
    expect(rows[0]!.attachments).toBeUndefined()
    expect(rows[2]).toMatchObject({ senderAssistantId: 'fixture-assistant', attachments })
    expect([...assistantRows].map(([index, row]) => [index, row.isLast])).toEqual([[0, false], [2, true]])
    expect([...ordinals]).toEqual([['o1', 0], ['o2', 2]])
  })

  it('places lead rows first, never last, and drops rounds a transform empties', () => {
    const lead = { role: 'assistant' as const, content: [text('Observed.')], senderAssistantId: 'fixture-assistant' }
    const { rows, assistantRows } = assembleTurnPublication([{ content: [text('<followup>[]</followup>')], toolResults: [] }],
      { reason: 'stub', sender: {}, lead: [lead], transform: () => [] })
    expect(rows).toEqual([lead])
    expect(assistantRows.get(0)).toMatchObject({ turnIndex: -1, isLast: false })
    expect(() => assembleTurnPublication([{ content: [text('x')], toolResults: [], origin: 'same' }, { content: [text('y')], toolResults: [], origin: 'same' }],
      { reason: 'stub', sender: {} })).toThrow('Duplicate publication output origin')
  })
})

describe('[COMP:api/turn-kernel] AssistantTurn.publish completion state', () => {
  const open = () => openAssistantTurn({ sessionId: 'fixture-session', policy: { admission: 'personal' }, abortController: new AbortController() })

  it('publishes one reply with one completion identity; closing rows never mark it', async () => {
    const owner = await open()
    try {
      const identity = owner.completion.operationId
      expect(owner.completion).toMatchObject({ state: 'unpublished', durable: false, publishedReply: false })
      await owner.publish({ disposition: 'closing', rows: reply, write: scope, native: null, execute })
      expect(owner.completion.state).toBe('unpublished')
      const afterCommit = vi.fn(async () => { expect(owner.completion.state).toBe('committed') })
      await owner.publish({ disposition: 'reply', rows: reply, write: scope, native: null, execute, afterCommit })
      expect(afterCommit).toHaveBeenCalledOnce()
      expect(owner.completion).toMatchObject({ operationId: identity, state: 'committed' })
      await expect(owner.publish({ disposition: 'reply', rows: reply, write: scope, native: null, execute }))
        .rejects.toThrow('already published its reply')
    } finally { await owner.finish() }
    await expect(owner.publish({ disposition: 'closing', rows: reply, write: scope, native: null, execute })).rejects.toThrow('closed')
  })

  it('records the durable completion header with the owner identity on every lane writer, reply only', async () => {
    const completion = { lane: 'resume' as const, input: { kind: 'approval' as const, ref: '00000000-0000-4000-8000-0000000000bb' },
      assistantId: '00000000-0000-4000-8000-0000000000cc' }
    // Stored writer: rows and the header in one transaction, then COMMIT.
    const owner = await open()
    try {
      await owner.publish({ disposition: 'closing', rows: reply, write: scope, native: null, execute, completion })
      expect(recordCompletion).not.toHaveBeenCalled()
      expect(owner.completion.durable).toBe(false)
      await owner.publish({ disposition: 'reply', rows: reply, write: scope, native: null, execute, completion })
      expect(recordCompletion).toHaveBeenCalledExactlyOnceWith(tx, expect.objectContaining({ sessionId: 'fixture-session', token: 'fixture-token',
        stopped: false, binding: { operationId: owner.completion.operationId, ...completion } }))
      expect(tx.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
      expect(owner.completion).toMatchObject({ durable: true, state: 'committed' })
    } finally { await owner.finish() }
    // Native writer: the binding rides the same native batch.
    const nativeOwner = await open()
    try {
      await nativeOwner.publish({ disposition: 'reply', rows: reply, write: derivation, native, execute, completion: { ...completion, lane: 'web' } })
      expect(publishNativeSessionMessageBatch).toHaveBeenLastCalledWith(expect.objectContaining({ publication: expect.objectContaining({
        turnToken: 'fixture-token', completion: { operationId: nativeOwner.completion.operationId, ...completion, lane: 'web' } }) }))
      expect(nativeOwner.completion.durable).toBe(true)
    } finally { await nativeOwner.finish() }
  })

  it('records a refused publication distinctly from an uncertain commit', async () => {
    for (const [failure, state] of [[new Error('Fictional refusal'), 'refused'],
      [Object.assign(new Error('Fictional lost acknowledgement'), { operationMayHaveExecuted: true }), 'uncertain']] as const) {
      const owner = await open()
      vi.mocked(addSessionMessage).mockRejectedValueOnce(failure)
      try {
        await expect(owner.publish({ disposition: 'reply', rows: reply, write: scope, native: null, execute })).rejects.toBe(failure)
        expect(owner.completion).toMatchObject({ state, publishedReply: false })
      } finally { await owner.finish() }
    }
  })
})
