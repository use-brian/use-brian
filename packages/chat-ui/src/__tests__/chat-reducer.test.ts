import { describe, it, expect } from 'vitest'
import { chatReducer, initialChatState } from '../chat-reducer.js'
import type { Message, PendingConfirmation } from '../types.js'

const userMessage = (id: string, text: string): Message => ({
  id,
  role: 'user',
  text,
  timestamp: new Date(0),
})

describe('[COMP:chat-ui/chat-reducer] chat reducer', () => {
  it('keeps unchanged refresh snapshots and row identities stable', () => {
    const first = { ...userMessage('m1', 'hello'), userAttachments: [{ id: 'file', name: 'notes.txt' }] }
    const second = userMessage('m2', 'reply')
    const state = { ...initialChatState, sessionId: 'session', messages: [first, second], streamingText: 'partial', isStreaming: true }
    expect(chatReducer(state, { type: 'messages/load', messages: structuredClone(state.messages) })).toBe(state)
    const refreshed = structuredClone(state.messages)
    refreshed[1].text = 'updated reply'
    const next = chatReducer(state, { type: 'messages/load', messages: refreshed })
    expect(next.messages[0]).toBe(first)
    expect(next.messages[1]).toBe(refreshed[1])
    expect(next.streamingText).toBe('partial')
    expect(next.isStreaming).toBe(true)
    expect(next.pendingConfirmations).toBe(state.pendingConfirmations)
  })

  it('reconciles additions, removals, ordering and attachment changes without retaining stale data', () => {
    const first = { ...userMessage('m1', 'hello'), userAttachments: [{ id: 'file', name: 'old.txt' }] }
    const second = userMessage('m2', 'reply')
    const state = { ...initialChatState, messages: [first, second] }
    const moved = chatReducer(state, { type: 'messages/load', messages: [structuredClone(second), structuredClone(first)] })
    expect(moved.messages[0]).toBe(second)
    expect(moved.messages[1]).toBe(first)
    const updated = { ...structuredClone(first), userAttachments: [{ id: 'file', name: 'new.txt' }] }
    const next = chatReducer(state, { type: 'messages/load', messages: [updated, userMessage('m3', 'new')] })
    expect(next.messages).toEqual([updated, userMessage('m3', 'new')])
    expect(next.messages[0]).not.toBe(first)
    expect(chatReducer(next, { type: 'messages/load', messages: [] }).messages).toEqual([])
  })

  it('keeps unknown timestamps stable but applies corrected timestamps', () => {
    const message = { ...userMessage('m1', 'hello'), timestamp: new Date(NaN) }
    const state = { ...initialChatState, messages: [message] }
    expect(chatReducer(state, { type: 'messages/load', messages: structuredClone(state.messages) })).toBe(state)
    const next = chatReducer(state, { type: 'messages/load', messages: [userMessage('m1', 'hello')] })
    expect(next.messages[0].timestamp.getTime()).toBe(0)
  })

  it('separates finished text and saved text from foreground completion', () => {
    const started = chatReducer(initialChatState, { type: 'stream/start' })
    const writing = chatReducer(started, { type: 'stream/append', text: 'Hello.' })
    const saving = chatReducer(writing, { type: 'stream/text-complete' })
    expect(saving).toMatchObject({ isStreaming: true, streamingText: 'Hello.', replyPhase: 'saving', messages: [] })
    const finishing = chatReducer(saving, { type: 'stream/saved' })
    expect(finishing).toMatchObject({ isStreaming: true, streamingText: 'Hello.', replyPhase: 'finishing', messages: [] })
    expect(chatReducer(finishing, { type: 'stream/text-complete' })).toBe(finishing)
    const done = chatReducer(finishing, { type: 'stream/finalize', finalMessage: { ...userMessage('answer', 'Hello.'), role: 'assistant' } })
    expect(done).toMatchObject({ isStreaming: false, streamingText: '', replyPhase: 'generating' })
    expect(done.messages).toHaveLength(1)
    expect(chatReducer(done, { type: 'stream/saved' })).toBe(done)
  })

  it('resets completion display for recovery text, new turns, resets and aborts', () => {
    const finishing = chatReducer(chatReducer(initialChatState, { type: 'stream/start' }), { type: 'stream/saved' })
    for (const action of [{ type: 'stream/start' }, { type: 'stream/reset' }, { type: 'stream/append', text: 'Recovery' }, { type: 'stream/abort' }] as const) {
      expect(chatReducer(finishing, action).replyPhase).toBe('generating')
    }
  })

  it('starts in the initial state', () => {
    expect(initialChatState.sessionId).toBeNull()
    expect(initialChatState.messages).toEqual([])
    expect(initialChatState.isStreaming).toBe(false)
    expect(initialChatState.pendingConfirmations).toEqual([])
  })

  it('updates the sessionId without touching messages or stream state', () => {
    // Switching ids must not wipe messages or stream state — the chat
    // route emits a `session` SSE event mid-turn (including on the
    // first turn of a brand-new session, where messages contains an
    // optimistic user message and isStreaming is true). A destructive
    // reset there used to make the user message disappear and leave
    // only the assistant reply on screen.
    const seeded = chatReducer(
      {
        ...initialChatState,
        sessionId: null,
        streamingText: 'partial',
        isStreaming: true,
      },
      { type: 'message/append', message: userMessage('m1', 'hi') },
    )
    const next = chatReducer(seeded, { type: 'session/set', sessionId: 's1' })
    expect(next.sessionId).toBe('s1')
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]?.text).toBe('hi')
    expect(next.streamingText).toBe('partial')
    expect(next.isStreaming).toBe(true)
  })

  it('is a no-op when session/set receives the current sessionId', () => {
    const seeded = chatReducer(
      { ...initialChatState, sessionId: 's1' },
      { type: 'message/append', message: userMessage('m1', 'hi') },
    )
    const next = chatReducer(seeded, { type: 'session/set', sessionId: 's1' })
    expect(next).toBe(seeded)
    expect(next.messages).toHaveLength(1)
  })

  it('appends a message', () => {
    const next = chatReducer(initialChatState, {
      type: 'message/append',
      message: userMessage('m1', 'hello'),
    })
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]?.text).toBe('hello')
  })

  it('replaces a message by id', () => {
    const seeded = chatReducer(initialChatState, {
      type: 'message/append',
      message: userMessage('m1', 'first'),
    })
    const next = chatReducer(seeded, {
      type: 'message/replace',
      messageId: 'm1',
      message: userMessage('m1', 'edited'),
    })
    expect(next.messages[0]?.text).toBe('edited')
  })

  it('rekeys a message id while preserving consumer-widened fields', () => {
    // The `user_message_saved` re-key (optimistic local id → server row id)
    // must not rebuild the message: consumers widen Message with fields the
    // reducer doesn't know about (app-web's `userAttachments` image-preview
    // thumbnails), and a wholesale replace made a sent image vanish the
    // moment the turn started streaming.
    const widened = {
      ...userMessage('local-1', 'see attached'),
      userAttachments: [{ id: 'f1', name: 'shot.png', mime: 'image/png' }],
    } as Message
    const seeded = chatReducer(initialChatState, {
      type: 'message/append',
      message: widened,
    })
    const next = chatReducer(seeded, {
      type: 'message/rekey',
      messageId: 'local-1',
      id: 'srv-1',
    })
    expect(next.messages[0]?.id).toBe('srv-1')
    expect(next.messages[0]?.text).toBe('see attached')
    expect(
      (next.messages[0] as Record<string, unknown>).userAttachments,
    ).toEqual([{ id: 'f1', name: 'shot.png', mime: 'image/png' }])
    // A miss is a no-op.
    const missed = chatReducer(seeded, {
      type: 'message/rekey',
      messageId: 'not-there',
      id: 'srv-2',
    })
    expect(missed.messages[0]?.id).toBe('local-1')
  })

  it('marks a stream as starting and accumulates text', () => {
    const started = chatReducer(initialChatState, { type: 'stream/start' })
    expect(started.isStreaming).toBe(true)
    const partial = chatReducer(started, { type: 'stream/append', text: 'Hel' })
    const fuller = chatReducer(partial, { type: 'stream/append', text: 'lo' })
    expect(fuller.streamingText).toBe('Hello')
  })

  it('resets the live buffer without ending the stream (drops an intermediate text segment)', () => {
    // A stray token the model emits alongside an intermediate tool step (e.g.
    // Gemini gluing a "20" text part onto an `inspectMyActivity(limit:20)`
    // call) must not survive into the final answer. `stream/reset` clears the
    // buffer while keeping isStreaming true, so the next segment starts clean.
    const leaked = chatReducer(
      { ...initialChatState, isStreaming: true, streamingText: '20' },
      { type: 'stream/reset' },
    )
    expect(leaked.streamingText).toBe('')
    expect(leaked.isStreaming).toBe(true)
    const answer = chatReducer(leaked, {
      type: 'stream/append',
      text: 'I have diagnosed the two causes',
    })
    expect(answer.streamingText).toBe('I have diagnosed the two causes')
  })

  it('finalizes a stream by appending the final assistant message', () => {
    const streaming = chatReducer(
      { ...initialChatState, isStreaming: true, streamingText: 'partial' },
      {
        type: 'stream/finalize',
        finalMessage: {
          id: 'a1',
          role: 'assistant',
          text: 'partial answer',
          timestamp: new Date(0),
        },
      },
    )
    expect(streaming.isStreaming).toBe(false)
    expect(streaming.streamingText).toBe('')
    expect(streaming.messages).toHaveLength(1)
    expect(streaming.messages[0]?.text).toBe('partial answer')
  })

  it('aborts a stream without committing', () => {
    const aborted = chatReducer(
      { ...initialChatState, isStreaming: true, streamingText: 'half' },
      { type: 'stream/abort' },
    )
    expect(aborted.isStreaming).toBe(false)
    expect(aborted.streamingText).toBe('')
    expect(aborted.messages).toEqual([])
  })

  it('tracks pending confirmations and updates by toolCallId', () => {
    const confirmation: PendingConfirmation = {
      toolCallId: 'tc1',
      toolName: 'saveMemory',
      input: { content: 'note' },
      sessionId: 's1',
      status: 'pending',
    }
    const added = chatReducer(initialChatState, {
      type: 'confirmation/add',
      confirmation,
    })
    expect(added.pendingConfirmations).toHaveLength(1)

    const approving = chatReducer(added, {
      type: 'confirmation/update',
      toolCallId: 'tc1',
      patch: { status: 'approving' },
    })
    expect(approving.pendingConfirmations[0]?.status).toBe('approving')

    const cleared = chatReducer(approving, { type: 'confirmation/clear' })
    expect(cleared.pendingConfirmations).toEqual([])
  })

  it('deduplicates a restored approval and prefers its live SSE card', () => {
    const restored: PendingConfirmation = {
      toolCallId: 'approval:ap-1',
      approvalId: 'ap-1',
      restored: true,
      toolName: 'fileWrite',
      input: { path: 'plan.md' },
      sessionId: 's1',
      status: 'pending',
    }
    const live: PendingConfirmation = {
      ...restored,
      toolCallId: 'tool-call-1',
      restored: false,
    }
    const recovered = chatReducer(initialChatState, {
      type: 'confirmation/add',
      confirmation: restored,
    })
    const replaced = chatReducer(recovered, {
      type: 'confirmation/add',
      confirmation: live,
    })
    expect(replaced.pendingConfirmations).toEqual([live])

    const lateRecovery = chatReducer(replaced, {
      type: 'confirmation/add',
      confirmation: restored,
    })
    expect(lateRecovery).toBe(replaced)
  })

  it('sets and clears reply-to', () => {
    const set = chatReducer(initialChatState, {
      type: 'reply/set',
      replyTo: { id: 'm1', role: 'assistant', text: 'reply context' },
    })
    expect(set.replyTo?.id).toBe('m1')
    const cleared = chatReducer(set, { type: 'reply/set', replyTo: null })
    expect(cleared.replyTo).toBeNull()
  })
})

describe('[COMP:chat-ui/chat-reducer] mid-turn queued messages', () => {
  const queuedMessage = (id: string): Message => ({
    id,
    role: 'user',
    text: 'and what about Jack?',
    timestamp: new Date('2026-08-06T10:00:00Z'),
    queued: 'pending',
  })

  it('clears the queued flag when the running turn takes the message', () => {
    const state = chatReducer(
      { ...initialChatState, messages: [queuedMessage('input-1')] },
      { type: 'message/queued', messageId: 'input-1', state: null },
    )
    // Absent, not `undefined`-valued — the flag is what the UI renders a
    // "Queued" chip from, so it must not survive as a falsy key.
    expect('queued' in state.messages[0]).toBe(false)
    expect(state.messages[0].text).toBe('and what about Jack?')
  })

  it('upgrades a pending message to steering in place', () => {
    const state = chatReducer(
      { ...initialChatState, messages: [queuedMessage('input-1')] },
      { type: 'message/queued', messageId: 'input-1', state: 'steering' },
    )
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].queued).toBe('steering')
  })

  it('removes a queued message the turn never took', () => {
    // The host drops it and re-sends as an ordinary turn; leaving it would
    // show the message twice.
    const state = chatReducer(
      {
        ...initialChatState,
        messages: [
          { id: 'm1', role: 'assistant', text: 'answer', timestamp: new Date() },
          queuedMessage('input-1'),
        ],
      },
      { type: 'message/remove', messageId: 'input-1' },
    )
    expect(state.messages.map((m) => m.id)).toEqual(['m1'])
  })

  it('leaves other messages untouched', () => {
    const other: Message = {
      id: 'm1', role: 'user', text: 'first', timestamp: new Date(),
    }
    const state = chatReducer(
      { ...initialChatState, messages: [other, queuedMessage('input-1')] },
      { type: 'message/queued', messageId: 'input-1', state: null },
    )
    expect(state.messages[0]).toBe(other)
  })
})
