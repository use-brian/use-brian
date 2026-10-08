import { describe, expect, it } from 'vitest'
import { AuthoritySourceSchema } from '../authority-source.js'
const invocation = { version: 1, kind: 'invocation', invocationId: '10000000-0000-4000-8000-000000000001' }
describe('[COMP:security/authority-source] host source evidence', () => {
  it('round-trips an opaque invocation without adding a permission grant', () => {
    expect(AuthoritySourceSchema.parse(JSON.parse(JSON.stringify(invocation)))).toEqual(invocation)
  })
  it.each([null, {}, { ...invocation, invocationId: '' }, { ...invocation, extra: 'unreviewed' },
    { ...invocation, kind: 'session' }, { ...invocation, version: 0 }])('refuses incomplete or extended source evidence: %j', value => {
    expect(AuthoritySourceSchema.safeParse(value).success).toBe(false)
  })
})
