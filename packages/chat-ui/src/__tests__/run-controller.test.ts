import { describe, expect, it } from 'vitest'
import {
  chatRunReducer,
  initialChatRunState,
  type ChatControllerIdentity,
} from '../run-controller.js'

const identity = (sessionId: string | null, generation: number): ChatControllerIdentity => ({
  sessionId,
  generation,
})

describe('[COMP:chat-ui/run-controller] run lifecycle', () => {
  it('keeps run phase independent from disconnect and reconnect', () => {
    const owner = identity('session-a', 1)
    let state = chatRunReducer(initialChatRunState, { type: 'visit', identity: owner })
    state = chatRunReducer(state, { type: 'begin', identity: owner })
    state = chatRunReducer(state, { type: 'suspend', identity: owner })
    state = chatRunReducer(state, { type: 'disconnect', identity: owner })
    expect(state).toMatchObject({ phase: 'suspended', connection: 'disconnected' })
    state = chatRunReducer(state, { type: 'reconnect', identity: owner })
    expect(state).toMatchObject({ phase: 'suspended', connection: 'reconnecting' })
  })

  it('ignores late events after a session switch, including A to B to A', () => {
    const firstA = identity('session-a', 1)
    const b = identity('session-b', 2)
    const secondA = identity('session-a', 3)
    let state = chatRunReducer(initialChatRunState, { type: 'visit', identity: firstA })
    state = chatRunReducer(state, { type: 'begin', identity: firstA })
    state = chatRunReducer(state, { type: 'visit', identity: b })
    state = chatRunReducer(state, { type: 'visit', identity: secondA })
    const late = chatRunReducer(state, { type: 'complete', identity: firstA })
    expect(late).toBe(state)
    expect(late).toMatchObject({ identity: secondA, phase: 'idle' })
  })

  it('adopts a fresh server session without changing generation', () => {
    const provisional = identity(null, 1)
    let state = chatRunReducer(initialChatRunState, { type: 'visit', identity: provisional })
    state = chatRunReducer(state, { type: 'begin', identity: provisional })
    state = chatRunReducer(state, {
      type: 'adopt-session',
      identity: provisional,
      sessionId: 'minted-session',
    })
    expect(state.identity).toEqual(identity('minted-session', 1))
    expect(chatRunReducer(state, { type: 'complete', identity: provisional }).phase).toBe('completed')
  })

  it('makes terminal transitions idempotent and first-terminal-wins', () => {
    const owner = identity('session-a', 1)
    let state = chatRunReducer(initialChatRunState, { type: 'visit', identity: owner })
    state = chatRunReducer(state, { type: 'begin', identity: owner })
    const completed = chatRunReducer(state, { type: 'complete', identity: owner })
    expect(chatRunReducer(completed, { type: 'complete', identity: owner })).toBe(completed)
    expect(chatRunReducer(completed, { type: 'fail', identity: owner })).toBe(completed)
    expect(chatRunReducer(completed, { type: 'cancel', identity: owner })).toBe(completed)
  })
})
