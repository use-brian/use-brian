import { describe, expect, it } from 'vitest'
import {
  chatInteractionReducer,
  initialChatInteractionState,
  type ChatInteraction,
} from '../interaction-controller.js'
import type { ChatControllerIdentity } from '../run-controller.js'

const owner: ChatControllerIdentity = { sessionId: 'session-a', generation: 1 }
const restored: ChatInteraction = {
  kind: 'tool-confirmation',
  approvalId: 'approval-1',
  toolCallId: 'approval:approval-1',
  source: 'restored',
  status: 'pending',
  payload: { tool: 'fileWrite' },
}
const live: ChatInteraction = {
  ...restored,
  toolCallId: 'tool-call-1',
  source: 'live',
  payload: { tool: 'fileWrite', path: 'notes.txt' },
}

describe('[COMP:chat-ui/interaction-controller] pending interaction recovery', () => {
  it('lets a live card replace a placeholder and rejects late restoration', () => {
    let state = chatInteractionReducer(initialChatInteractionState, { type: 'visit', identity: owner })
    state = chatInteractionReducer(state, { type: 'present', identity: owner, interaction: restored })
    state = chatInteractionReducer(state, { type: 'present', identity: owner, interaction: live })
    expect(state.pending).toBe(live)
    expect(chatInteractionReducer(state, {
      type: 'present',
      identity: owner,
      interaction: restored,
    })).toBe(state)
  })

  it('deduplicates repeated live events', () => {
    let state = chatInteractionReducer(initialChatInteractionState, { type: 'visit', identity: owner })
    state = chatInteractionReducer(state, { type: 'present', identity: owner, interaction: live })
    expect(chatInteractionReducer(state, {
      type: 'present',
      identity: owner,
      interaction: live,
    })).toBe(state)
  })

  it('keeps a failed response visible and retryable until server resolution', () => {
    let state = chatInteractionReducer(initialChatInteractionState, { type: 'visit', identity: owner })
    state = chatInteractionReducer(state, { type: 'present', identity: owner, interaction: live })
    state = chatInteractionReducer(state, {
      type: 'respond',
      identity: owner,
      approvalId: live.approvalId,
    })
    expect(state.pending?.status).toBe('responding')
    state = chatInteractionReducer(state, {
      type: 'response-failed',
      identity: owner,
      approvalId: live.approvalId,
      error: 'network unavailable',
    })
    expect(state.pending).toMatchObject({ status: 'retryable', error: 'network unavailable' })
    state = chatInteractionReducer(state, {
      type: 'resolved',
      identity: owner,
      approvalId: live.approvalId,
    })
    expect(state.pending).toBeNull()
  })

  it('ignores a late probe and response after session generation changes', () => {
    const next: ChatControllerIdentity = { sessionId: 'session-b', generation: 2 }
    let state = chatInteractionReducer(initialChatInteractionState, { type: 'visit', identity: owner })
    state = chatInteractionReducer(state, { type: 'visit', identity: next })
    expect(chatInteractionReducer(state, {
      type: 'present',
      identity: owner,
      interaction: restored,
    })).toBe(state)
    expect(chatInteractionReducer(state, {
      type: 'resolved',
      identity: owner,
      approvalId: restored.approvalId,
    })).toBe(state)
  })
})
