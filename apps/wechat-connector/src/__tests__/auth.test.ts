/**
 * [COMP:app/wechat-connector] — X-Connector-Secret auth helper.
 * Constant-time compare; fails closed on an empty configured secret.
 */

import { describe, it, expect } from 'vitest'
import { connectorSecretMatches } from '../auth.js'

describe('[COMP:app/wechat-connector] connectorSecretMatches', () => {
  it('accepts the exact secret', () => {
    expect(connectorSecretMatches('s3cret', 's3cret')).toBe(true)
  })

  it('rejects a wrong secret and a missing header', () => {
    expect(connectorSecretMatches('nope', 's3cret')).toBe(false)
    expect(connectorSecretMatches(undefined, 's3cret')).toBe(false)
  })

  it('rejects a repeated header (string[])', () => {
    expect(connectorSecretMatches(['s3cret', 's3cret'], 's3cret')).toBe(false)
  })

  it('fails closed when the configured secret is empty', () => {
    expect(connectorSecretMatches('', '')).toBe(false)
    expect(connectorSecretMatches(undefined, '')).toBe(false)
  })
})
