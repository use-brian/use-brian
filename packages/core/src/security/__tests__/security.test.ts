import { describe, it, expect } from 'vitest'
import { sanitizeUnicode, sanitizeDeep, redactSecrets, containsSecrets } from '../sanitize.js'
import { createRateLimiter } from '../rate-limiter.js'

describe('[COMP:security/sanitize] sanitizeUnicode', () => {
  it('strips zero-width characters', () => {
    expect(sanitizeUnicode('hello\u200Bworld')).toBe('helloworld')
    expect(sanitizeUnicode('test\uFEFF')).toBe('test')
  })

  it('normalizes NFKC', () => {
    expect(sanitizeUnicode('\uff41\uff42\uff43')).toBe('abc') // fullwidth → ASCII
  })

  it('preserves normal text', () => {
    expect(sanitizeUnicode('Hello, world! 你好')).toBe('Hello, world! 你好')
  })
})

describe('[COMP:security/sanitize] sanitizeDeep', () => {
  it('sanitizes nested objects', () => {
    const input = { text: 'hello\u200Bworld', nested: { arr: ['test\uFEFF'] } }
    const result = sanitizeDeep(input) as typeof input
    expect(result.text).toBe('helloworld')
    expect(result.nested.arr[0]).toBe('test')
  })
})

describe('[COMP:security/sanitize] redactSecrets', () => {
  it('redacts AWS keys', () => {
    expect(redactSecrets('key is AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED:AWS]')
  })

  it('redacts Stripe keys', () => {
    expect(redactSecrets('sk_test_4eC39HqLyjWDarjtT1zdp7dc')).toContain('[REDACTED:Stripe]')
  })

  it('redacts Google API keys', () => {
    expect(redactSecrets('AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe')).toContain('[REDACTED:Google API]')
  })

  it('preserves normal text', () => {
    const text = 'The weather in Tokyo is 22°C.'
    expect(redactSecrets(text)).toBe(text)
  })
})

describe('[COMP:security/sanitize] containsSecrets', () => {
  it('detects secrets', () => {
    expect(containsSecrets('my key is sk_test_4eC39HqLyjWDarjtT1zdp7dc')).toBe(true)
  })

  it('returns false for clean text', () => {
    expect(containsSecrets('just a normal message')).toBe(false)
  })
})

describe('[COMP:security/rate-limiter] Rate limiter', () => {
  it('allows requests within limit', () => {
    const limiter = createRateLimiter({ maxRequests: 3, windowMs: 1000 })
    expect(limiter.check('1.2.3.4')).toBe(true)
    expect(limiter.check('1.2.3.4')).toBe(true)
    expect(limiter.check('1.2.3.4')).toBe(true)
    expect(limiter.check('1.2.3.4')).toBe(false) // 4th blocked
    limiter.destroy()
  })

  it('isolates per IP', () => {
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 1000 })
    expect(limiter.check('1.1.1.1')).toBe(true)
    expect(limiter.check('1.1.1.1')).toBe(true)
    expect(limiter.check('1.1.1.1')).toBe(false)
    expect(limiter.check('2.2.2.2')).toBe(true) // different IP, not limited
    limiter.destroy()
  })
})
