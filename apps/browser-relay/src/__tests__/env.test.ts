import { describe, expect, it } from 'vitest'
import { parseEnv } from '../env.js'

const required = {
  BROWSER_RELAY_SECRET: 'relay-secret',
  JWT_SECRET: 'jwt-secret',
}

describe('[COMP:ext/relay] browser relay environment', () => {
  it('keeps the container-compatible default bind address and port', () => {
    const env = parseEnv(required)

    expect(env.HOST).toBe('0.0.0.0')
    expect(env.PORT).toBe(8080)
  })

  it('accepts a loopback bind for single-machine self-hosting', () => {
    const env = parseEnv({ ...required, HOST: '127.0.0.1', PORT: '8092' })

    expect(env.HOST).toBe('127.0.0.1')
    expect(env.PORT).toBe(8092)
  })
})
