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
