import { describe, expect, it } from 'vitest'
import {
  CONTEXT_NOT_AVAILABLE_MESSAGE,
  CUSTOM_MODEL_IMAGE_REJECTION,
  channelUserErrorText,
} from '../_channel-error-text.js'

describe('[COMP:api/channel-error-text] channel sendError text', () => {
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
