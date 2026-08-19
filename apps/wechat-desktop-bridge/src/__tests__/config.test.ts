/**
 * [COMP:app/wechat-desktop-bridge] config: zod env parsing with readable errors.
 */
import { describe, expect, it } from 'vitest'
import { ConfigError, parseConfig } from '../config.js'

const good = {
  BRIAN_API_URL: 'https://api.example.com/',
  BRIAN_CHANNEL_ID: 'chan_example',
  BRIAN_BRIDGE_TOKEN: 'ubc_exampletoken',
  AGENT_WECHAT_TOKEN: 'agenttoken',
}

describe('[COMP:app/wechat-desktop-bridge] config', () => {
  it('applies defaults and strips trailing slashes', () => {
    const c = parseConfig(good)
    expect(c).toMatchObject({
      BRIAN_API_URL: 'https://api.example.com',
      AGENT_WECHAT_URL: 'http://agent-wechat:6174',
      BRIDGE_STATE_FILE: '/data/bridge-state.json',
      POLL_INTERVAL_MS: 3000,
      BACKFILL_ON_FIRST_BOOT: false,
      BRIDGE_PORT: 8086,
    })
  })

  it('parses overrides', () => {
    const c = parseConfig({ ...good, POLL_INTERVAL_MS: '500', BACKFILL_ON_FIRST_BOOT: 'true', BRIDGE_PORT: '9000' })
    expect(c.POLL_INTERVAL_MS).toBe(500)
    expect(c.BACKFILL_ON_FIRST_BOOT).toBe(true)
    expect(c.BRIDGE_PORT).toBe(9000)
  })

  it('names every missing required variable in one readable error', () => {
    let err: unknown
    try {
      parseConfig({})
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ConfigError)
    const message = (err as Error).message
    for (const key of ['BRIAN_API_URL', 'BRIAN_CHANNEL_ID', 'BRIAN_BRIDGE_TOKEN', 'AGENT_WECHAT_TOKEN']) {
      expect(message).toContain(key)
    }
    expect(message).not.toContain('ZodError')
  })

  it('rejects a non-URL API base', () => {
    expect(() => parseConfig({ ...good, BRIAN_API_URL: 'not a url' })).toThrow(/BRIAN_API_URL/)
  })
})
