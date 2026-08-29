import { describe, expect, it } from 'vitest'
import {
  buildConfirmationActions,
  confirmationDecisionLabel,
  encodeConfirmationAction,
  interpretConfirmationEvent,
  isConfirmationDecision,
} from '../confirmation-events.js'

describe('[COMP:mcp/confirmation-events] normalized confirmation events', () => {
  it.each([
    ['yes', 'allow'],
    [' Y ', 'allow'],
    ['approve', 'allow'],
    ['OK', 'allow'],
    ['no', 'deny'],
    [' reject ', 'deny'],
    ['always', 'always_allow'],
    ['Always Allow', 'always_allow'],
    ['never', 'always_deny'],
    ['always deny', 'always_deny'],
  ] as const)('maps text %j to %s', (text, decision) => {
    expect(interpretConfirmationEvent({ kind: 'text', text }, 'tool-1')).toEqual({
      status: 'decision',
      decision,
      toolCallId: 'tool-1',
      consume: true,
    })
  })

  it('denies a parked request but preserves unrelated text as a new message', () => {
    expect(interpretConfirmationEvent({ kind: 'text', text: 'change the recipient' }, 'tool-1')).toEqual({
      status: 'decision',
      decision: 'deny',
      toolCallId: 'tool-1',
      consume: false,
    })
  })

  it('leaves unrelated text alone when no confirmation is parked', () => {
    expect(interpretConfirmationEvent({ kind: 'text', text: 'hello' })).toEqual({
      status: 'not_confirmation',
    })
  })

  it.each(['allow', 'deny', 'always_allow', 'always_deny'] as const)(
    'round-trips the %s action',
    (decision) => {
      const data = encodeConfirmationAction('tool-1', decision)
      expect(interpretConfirmationEvent({ kind: 'action', data })).toEqual({
        status: 'decision',
        toolCallId: 'tool-1',
        decision,
        consume: true,
      })
    },
  )

  it.each([
    undefined,
    42,
    '',
    'mcp_confirm',
    'mcp_confirm::allow',
    'mcp_confirm:tool-1',
    'mcp_confirm:tool-1:approve',
    'mcp_confirm:tool-1:constructor',
    'mcp_confirm:tool-1:allow:extra',
    'other:tool-1:allow',
  ])('rejects malformed action data %j', (data) => {
    expect(interpretConfirmationEvent({ kind: 'action', data })).toEqual({ status: 'invalid' })
  })

  it('validates and trims a direct web decision', () => {
    expect(interpretConfirmationEvent({
      kind: 'decision',
      toolCallId: ' tool-1 ',
      decision: 'deny',
      comment: ' use the draft instead ',
    })).toEqual({
      status: 'decision',
      toolCallId: 'tool-1',
      decision: 'deny',
      comment: 'use the draft instead',
      consume: true,
    })
  })

  it.each([
    { toolCallId: '', decision: 'allow' },
    { toolCallId: 'tool-1', decision: 'approved' },
    { toolCallId: 'tool-1', decision: 'constructor' },
    { toolCallId: 'tool-1', decision: 'deny', comment: 42 },
  ])('rejects an invalid direct decision %#', (event) => {
    expect(interpretConfirmationEvent({ kind: 'decision', ...event })).toEqual({ status: 'invalid' })
  })

  it('builds the common two- or four-action prompt', () => {
    expect(buildConfirmationActions('tool-1')).toEqual([
      { id: 'allow', label: 'Allow', data: 'mcp_confirm:tool-1:allow' },
      { id: 'deny', label: 'Deny', data: 'mcp_confirm:tool-1:deny' },
    ])
    expect(buildConfirmationActions('tool-1', true)).toHaveLength(4)
  })

  it('exposes labels and a fail-closed decision guard', () => {
    expect(confirmationDecisionLabel('always_deny')).toBe('Always denied')
    expect(isConfirmationDecision('allow')).toBe(true)
    expect(isConfirmationDecision('constructor')).toBe(false)
    expect(isConfirmationDecision('approved')).toBe(false)
  })
})
