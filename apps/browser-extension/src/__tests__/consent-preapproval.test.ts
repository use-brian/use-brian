import { describe, expect, it } from 'vitest'
import {
  isTabControlPreapproved,
  PREAPPROVE_TAB_CONTROL_KEY,
} from '../consent-preapproval.js'

describe('[COMP:ext/agent] Consent pre-approval preference', () => {
  it('is off by default', async () => {
    expect(await isTabControlPreapproved({ get: async () => ({}) })).toBe(false)
  })

  it('accepts only an explicit stored true value', async () => {
    const storage = {
      get: async () => ({ [PREAPPROVE_TAB_CONTROL_KEY]: true }),
    }
    expect(await isTabControlPreapproved(storage)).toBe(true)
    expect(
      await isTabControlPreapproved({
        get: async () => ({ [PREAPPROVE_TAB_CONTROL_KEY]: 'true' }),
      }),
    ).toBe(false)
  })

  it('fails closed when storage cannot be read', async () => {
    expect(
      await isTabControlPreapproved({
        get: async () => {
          throw new Error('storage unavailable')
        },
      }),
    ).toBe(false)
  })
})
