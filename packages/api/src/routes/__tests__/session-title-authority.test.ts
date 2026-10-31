import {beforeEach,describe,expect,it,vi} from 'vitest'

const mocks=vi.hoisted(()=>({query:vi.fn(),validateAccess:vi.fn(),readSession:vi.fn(),resolveExecution:vi.fn()}))
vi.mock('../../db/client.js',()=>({getPool:()=>({query:mocks.query})}))
vi.mock('../../db/auth-session-store.js',()=>({authSessionStore:{validateAccess:mocks.validateAccess}}))
vi.mock('../../db/sessions.js',()=>({readSessionById:mocks.readSession}))
vi.mock('../../db/users.js',()=>({getUserAssistant:vi.fn()}))
vi.mock('../../db/session-query-reader.js',()=>({readAdmittedSessionQuery:vi.fn()}))
vi.mock('../../db/session-title-store.js',()=>({publishSessionTitle:vi.fn(),readSessionTitle:vi.fn(),sessionTitleHead:vi.fn()}))
vi.mock('../../context-scope/execution-context.js',()=>({resolveExecutionContextSystem:mocks.resolveExecution}))
vi.mock('../../session-read-authority.js',()=>({gateSessionRead:vi.fn()}))
vi.mock('../../application-platform/model-source-authority.js',()=>({assertSourceModelOutputAuthority:vi.fn()}))
import {sessionTitleProjections} from '../session-title-authority.js'

const first='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002'
const claims={userId:'00000000-0000-4000-8000-000000000003'}
beforeEach(()=>{vi.resetAllMocks();mocks.query.mockResolvedValue({rows:[]});mocks.validateAccess.mockResolvedValue(true);mocks.readSession.mockResolvedValue(null)})
describe('[COMP:api/application-persistence] batched title presence withholding',()=>{
 it('withholds a large placeholder-only page without opening per-row authority frames',async()=>{
  const ids=Array.from({length:200},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`)
  const result=await sessionTitleProjections({claims,sessionIds:ids})
  expect(result.size).toBe(200)
  expect([...result.values()].every(row=>row.title===null&&row.titleRevisionId===null)).toBe(true)
  expect(mocks.query).toHaveBeenCalledTimes(1)
  expect(mocks.query.mock.calls[0][1]).toEqual([ids])
  expect(mocks.validateAccess).not.toHaveBeenCalled()
  expect(mocks.readSession).not.toHaveBeenCalled()
  expect(mocks.resolveExecution).not.toHaveBeenCalled()
 })
 it('opens the normal current-authority path only for metadata candidates and preserves its denial',async()=>{
  mocks.query.mockResolvedValue({rows:[{id:second}]})
  const result=await sessionTitleProjections({claims,sessionIds:[first,second]})
  expect(mocks.validateAccess).toHaveBeenCalledExactlyOnceWith(claims)
  expect(mocks.readSession).toHaveBeenCalledExactlyOnceWith(second)
  expect([...result.values()]).toEqual([{title:null,titleRevisionId:null},{title:null,titleRevisionId:null}])
 })
 it('does not turn an unexpected candidate authority failure into a placeholder',async()=>{
  mocks.query.mockResolvedValue({rows:[{id:second}]})
  const failure=new Error('Fictional credential store unavailable')
  mocks.validateAccess.mockRejectedValue(failure)
  await expect(sessionTitleProjections({claims,sessionIds:[first,second]})).rejects.toBe(failure)
 })
 it('does not reuse candidate metadata between requests',async()=>{
  await sessionTitleProjections({claims,sessionIds:[first]})
  mocks.query.mockResolvedValue({rows:[{id:first}]})
  await sessionTitleProjections({claims,sessionIds:[first]})
  expect(mocks.query).toHaveBeenCalledTimes(2)
  expect(mocks.readSession).toHaveBeenCalledExactlyOnceWith(first)
 })
 it('withholds unsigned projections before metadata discovery',async()=>{
  expect(await sessionTitleProjections({claims:null,sessionIds:[first]})).toEqual(new Map([[first,{title:null,titleRevisionId:null}]]))
  expect(mocks.query).not.toHaveBeenCalled()
  expect(mocks.validateAccess).not.toHaveBeenCalled()
 })
 it('does not issue a database request for an empty collection',async()=>{
  expect(await sessionTitleProjections({claims,sessionIds:[]})).toEqual(new Map())
  expect(mocks.query).not.toHaveBeenCalled()
 })
})
