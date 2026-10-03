import { expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { nativeReadinessHandler } from './native-readiness.js'
import { relaySecretMatches } from './auth.js'
it('returns enabled/protocol only, without claiming JWT compatibility', () => {
  for (const enabled of [false,true]) {
    const response = { setHeader:vi.fn(),json:vi.fn() }
    nativeReadinessHandler(enabled)({} as never,response as never,vi.fn())
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control','no-store')
    expect(response.json).toHaveBeenCalledWith({enabled,protocol:'native-computer-v1'})
  }
})
it('mounts after shared-secret authentication and before disabled guard', () => {
  const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8')
  const auth=source.indexOf("app.use('/internal',")
  const readiness=source.indexOf("app.get('/internal/native-computer/readiness', nativeReadinessHandler(nativeEnabled))")
  const guard=source.indexOf("app.use('/internal/native-computer',")
  expect(auth).toBeGreaterThan(-1);expect(readiness).toBeGreaterThan(auth);expect(guard).toBeGreaterThan(readiness)
  expect(relaySecretMatches(undefined,'private')).toBe(false)
  expect(relaySecretMatches('wrong','private')).toBe(false)
})
