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
  it('accepts canonical personal and legacy owner source facts but refuses workspace audience',()=>{
    const source={...invocation,kind:'session',id:'session',assistantId:'assistant',userId:'member',executingAssistantId:'assistant',authorityUserId:'member',workspaceId:'workspace',contextGroupId:null,contextProjectId:null,contextLockedAt:'2026-10-24T00:00:00.000Z',visibility:'personal',mode:null,effectiveClearance:null,contextCompartments:[],memberMode:'member',ignoreSessionBinding:false,systemRead:false}
    for(const visibility of ['personal','owner'])expect(AuthoritySourceSchema.safeParse({...source,visibility}).success).toBe(true)
    expect(AuthoritySourceSchema.safeParse({...source,visibility:'workspace'}).success).toBe(false)
    const nativeCredential={userId:'10000000-0000-4000-8000-000000000002',sessionId:'10000000-0000-4000-8000-000000000003',authVersion:2}
    expect(AuthoritySourceSchema.parse({...source,nativeCredential})).toMatchObject({nativeCredential})
    for(const invalid of [{...nativeCredential,authVersion:-1},{...nativeCredential,sessionId:''},{...nativeCredential,token:'fictional-forbidden-token'}])expect(AuthoritySourceSchema.safeParse({...source,nativeCredential:invalid}).success).toBe(false)

  })

})
