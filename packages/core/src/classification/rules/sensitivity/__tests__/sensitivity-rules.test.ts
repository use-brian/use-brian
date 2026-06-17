import { describe, expect, it } from 'vitest'

import { applySensitivityRules } from '../index.js'

describe('[COMP:classification/sensitivity] applySensitivityRules', () => {
  it('forces confidential on private key', () => {
    const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----'
    expect(applySensitivityRules(content)).toBe('confidential')
  })

  it('forces confidential on API token shape', () => {
    const content = 'API_KEY=sk_live_abcdefghijklmnopqrstuvwxyz1234567890'
    expect(applySensitivityRules(content)).toBe('confidential')
  })

  it('returns null for benign content (falls back to LLM)', () => {
    expect(applySensitivityRules('Just a normal message about the weather.')).toBeNull()
  })

  it('returns null for empty content', () => {
    expect(applySensitivityRules('')).toBeNull()
  })
})
