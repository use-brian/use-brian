import { describe, expect, it, vi } from 'vitest'
import type { AccessCeiling, ContentBlock } from '@use-brian/core'
import { AuthorityChangedError, createAuthorityLease } from '../../context-scope/authority-lease.js'
import { DeliveryAudienceUnverifiedError } from '../../context-scope/delivery-authority.js'
import type { TurnLoopResult } from '../../turn/kernel.js'
import { createChatPostReplyBoundary } from '../chat-post-reply.js'

const ceiling: AccessCeiling = { workspaceId: 'workspace', userId: 'actor', clearance: 'internal',
  compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: ['assistant'] }
const content: ContentBlock[] = [{ type: 'text', text: 'Hello.' }]
const completed: TurnLoopResult = { selection: { kind: 'text', text: 'Hello.' }, finalText: null, aborted: false }

describe('[COMP:api/chat-post-reply] completed reply authority refusal', () => {
  it('retains the saved reply while refusing follow-up effects under a changed policy', async () => {
    let policyCurrent = true
    const authority = createAuthorityLease(ceiling, async () => ceiling, async () => policyCurrent)
    const boundary = createChatPostReplyBoundary()
    boundary.beginFinalization(completed, false, new AbortController().signal)
    const saved: ContentBlock[][] = []
    await authority.execute(async () => { saved.push(content) })
    await authority.assertCurrent()
    boundary.recordPublishedReply(content)
    policyCurrent = false
    const followUp = vi.fn()
    let failure: unknown
    try { await authority.execute(followUp) } catch (error) { failure = error }
    expect(followUp).not.toHaveBeenCalled()
    expect(saved).toEqual([content])
    expect(boundary.notice(failure)).toMatchObject({ code: 'post_reply_authority_changed' })
    policyCurrent = true
    await expect(authority.assertCurrent()).rejects.toBeInstanceOf(AuthorityChangedError)
  })

  it('does not certify publication when authority changes during the save', async () => {
    let policyCurrent = true
    const authority = createAuthorityLease(ceiling, async () => ceiling, async () => policyCurrent)
    const boundary = createChatPostReplyBoundary()
    boundary.beginFinalization(completed, false, new AbortController().signal)
    let failure: unknown
    try {
      await authority.execute(async () => { policyCurrent = false })
      await authority.assertCurrent()
      boundary.recordPublishedReply(content)
    } catch (error) { failure = error }
    expect(failure).toMatchObject({ operationMayHaveExecuted: true })
    expect(boundary.notice(failure)).toBeNull()
    expect(boundary.notice(new AuthorityChangedError())).toBeNull()
  })

  it.each<{ row: ContentBlock[] }>([
    { row: [] }, { row: [{ type: 'text', text: '  ' }] },
    { row: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tool-1', name: 'search', input: {} }] },
  ])('does not certify empty content or narration alongside a tool call: $row', ({ row }) => {
    const boundary = createChatPostReplyBoundary()
    boundary.beginFinalization(completed, false, new AbortController().signal)
    boundary.recordPublishedReply(row)
    expect(boundary.notice(new AuthorityChangedError())).toBeNull()
  })

  it('requires successful loop completion and a published final reply', () => {
    const boundary = createChatPostReplyBoundary()
    boundary.recordPublishedReply(content)
    expect(boundary.notice(new AuthorityChangedError())).toBeNull()
    for (const [result, providerFailed] of [
      [{ ...completed, aborted: true }, false],
      [completed, true],
      [{ ...completed, selection: { kind: 'empty', reason: 'tools_only' } }, false],
      [{ ...completed, selection: { kind: 'question', question: {} } }, false],
    ] as [TurnLoopResult, boolean][]) {
      boundary.beginFinalization(result, providerFailed, new AbortController().signal)
      boundary.recordPublishedReply(content)
      expect(boundary.notice(new AuthorityChangedError())).toBeNull()
    }
  })

  it('preserves uncertain operations, audience refusals, other errors and late cancellation', () => {
    const boundary = createChatPostReplyBoundary(), abort = new AbortController()
    boundary.beginFinalization(completed, false, abort.signal)
    boundary.recordPublishedReply(content)
    for (const error of [new AuthorityChangedError(true), new DeliveryAudienceUnverifiedError(),
      new Error('database failure'), { reason: 'authority_changed' }]) {
      expect(boundary.notice(error)).toBeNull()
    }
    expect(boundary.notice(new AuthorityChangedError())).not.toBeNull()
    abort.abort()
    expect(boundary.notice(new AuthorityChangedError())).toBeNull()
  })
})
