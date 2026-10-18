import { describe, expect, it } from 'vitest'
import { DeliveryAudienceUnverifiedError } from '../../context-scope/delivery-authority.js'
import {
  CONTEXT_NOT_AVAILABLE_MESSAGE,
  CUSTOM_MODEL_IMAGE_REJECTION,
  channelUserErrorText,
} from '../_channel-error-text.js'

describe('[COMP:api/channel-error-text] channel sendError text', () => {
  it('explains a delivery refusal and asks users to check saved changes before repeating a request', () => {
    const error = new DeliveryAudienceUnverifiedError(undefined, 'source_held')
    const text = channelUserErrorText(error)
    expect(text).toBe("I couldn't share the reply in this chat because access to some information couldn't be verified. If you requested changes, they may already be saved. Check their status before repeating the request.")
    expect(text).not.toContain('Please try again')
  })

  it.each(['source_held', 'verification_error', 'member_not_found'] as const)(
    'keeps %s and private runtime details out of the access notice', (diagnostic) => {
      const error = new DeliveryAudienceUnverifiedError('evidence_exceeds_audience', diagnostic)
      error.message = 'Private fixture source at restricted.example with record 00000000-0000-0000-0000-000000000001; usage limit'
      const text = channelUserErrorText(error, 'Channel-specific retry advice')
      expect(text).toContain('access to some information')
      expect(text).toContain('may already be saved')
      expect(text).not.toMatch(/source_held|verification_error|member_not_found|evidence_exceeds_audience|restricted\.example|00000000|usage limit|Channel-specific/)
    },
  )

  it('does not classify arbitrary vendor wording as a typed audience refusal', () => {
    const error = new Error('The current destination is not authorized for this response.')
    error.name = 'DeliveryAudienceUnverifiedError'
    expect(channelUserErrorText(error)).toBe('Something went wrong. Please try again.')
  })

  it('surfaces the custom-model inline-image refusal verbatim', () => {
    expect(channelUserErrorText(new Error(CUSTOM_MODEL_IMAGE_REJECTION)))
      .toBe(CUSTOM_MODEL_IMAGE_REJECTION)
  })

  it('keeps near-miss vendor wording out of the reply (exact match only)', () => {
    const nearMiss = new Error(
      'Custom model endpoints currently support text and tools only. Upstream vendor detail that must stay private.',
    )
    expect(channelUserErrorText(nearMiss)).toBe('Something went wrong. Please try again.')
  })

  it('surfaces usage-limit notices verbatim', () => {
    const err = new Error('You have reached your usage limit for today.')
    expect(channelUserErrorText(err)).toBe(err.message)
  })

  it('surfaces the safe context-not-available recovery without context metadata', () => {
    expect(channelUserErrorText(new Error(CONTEXT_NOT_AVAILABLE_MESSAGE)))
      .toBe(CONTEXT_NOT_AVAILABLE_MESSAGE)
    expect(CONTEXT_NOT_AVAILABLE_MESSAGE).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)
  })

  it('replaces arbitrary provider/runtime errors with the generic retry line', () => {
    expect(channelUserErrorText(new Error('Stream idle for 90000ms (no deliverable chunk — prefill window)')))
      .toBe('Something went wrong. Please try again.')
  })

  it('honours a channel-specific fallback', () => {
    expect(channelUserErrorText(new Error('boom'), 'Something went wrong while handling your email. Please try again.'))
      .toBe('Something went wrong while handling your email. Please try again.')
  })
})
