import { describe, expect, it } from 'vitest'
import {
  feishuConnectorSecretMatches,
  feishuUserAllowed,
} from '../feishu.js'

describe('[COMP:api/feishu-route] internal authentication and access', () => {
  it('fails closed for empty, absent, or unequal connector secrets', () => {
    expect(feishuConnectorSecretMatches(undefined, 'secret')).toBe(false)
    expect(feishuConnectorSecretMatches('secret', '')).toBe(false)
    expect(feishuConnectorSecretMatches('wrong', 'secret')).toBe(false)
    expect(feishuConnectorSecretMatches('secret', 'secret')).toBe(true)
  })

  it('applies allowlists and blocklists without reconnecting the bridge', () => {
    expect(feishuUserAllowed({ userAccessMode: 'allowlist', allowedUserIds: ['ou_ok'] }, 'ou_ok')).toBe(true)
    expect(feishuUserAllowed({ userAccessMode: 'allowlist', allowedUserIds: ['ou_ok'] }, 'ou_no')).toBe(false)
    expect(feishuUserAllowed({ userAccessMode: 'blocklist', blockedUserIds: ['ou_no'] }, 'ou_no')).toBe(false)
    expect(feishuUserAllowed({ userAccessMode: 'allow_all' }, 'ou_any')).toBe(true)
  })
})
