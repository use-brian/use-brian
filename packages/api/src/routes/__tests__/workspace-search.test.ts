import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import { WORKSPACE_SEARCH_FAMILIES } from '@use-brian/shared'
import { createTestApp } from './helpers.js'
import { workspaceSearchRoutes } from '../workspace-search.js'
import { createWorkspaceSearchService, type SearchAdapters, type SearchCandidate } from '../../workspace-search/service.js'

const workspaceId='00000000-0000-4000-8000-000000000001'
const path=`/api/workspace-search/${workspaceId}`
function fixture(userId:string|undefined='viewer',member=true) {
  const adapters=Object.fromEntries(WORKSPACE_SEARCH_FAMILIES.map(kind=>[kind,vi.fn(async()=>[])])) as unknown as SearchAdapters
  const search=createWorkspaceSearchService(adapters,{key:Buffer.from('fixture-key')})
  const isMember=vi.fn(async()=>member)
  const app=createTestApp('/api',workspaceSearchRoutes({search,isMember}),{userId})
  return {app,adapters,search,isMember}
}
const candidate:SearchCandidate={key:'task:one',id:'one',kind:'tasks',title:'needle',snippet:'safe text',source:'tasks',match:'exact',relevance:1,target:{type:'brain',id:'one',primitive:'tasks'}}

describe('[COMP:search/workspace-http] authenticated workspace search',()=>{
  it('requires authentication and current membership before running source queries',async()=>{
    const unauth=fixture(''),denied=fixture('viewer',false)
    expect((await request(unauth.app).get(path).query({q:'needle'})).status).toBe(401)
    expect((await request(denied.app).get(path).query({q:'needle'})).status).toBe(403)
    expect(denied.adapters.tasks).not.toHaveBeenCalled()
  })
  it.each([{q:''},{q:'x'.repeat(501)},{q:'x',kind:'admin'},{q:'x',limit:'51'},{q:'x',limit:'0'},{q:'x',extra:'bad'},{q:['x','y']}])('rejects malformed query %j',async query=>{
    expect((await request(fixture().app).get(path).query(query)).status).toBe(400)
  })
  it('returns bounded typed destinations and private no-store responses',async()=>{
    const f=fixture();vi.mocked(f.adapters.tasks).mockResolvedValue([candidate])
    const response=await request(f.app).get(path).query({q:'needle'})
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.body).toEqual({items:[{...candidate,relevance:undefined}],nextCursor:null,completeness:'complete',unavailableFamilies:[]})
    expect(f.isMember).toHaveBeenCalledWith('viewer',workspaceId)
  })
  it('reports failed public families without exposing adapter errors',async()=>{
    const f=fixture();vi.mocked(f.adapters.office).mockRejectedValue(new Error('private fixture detail'))
    const response=await request(f.app).get(path).query({q:'needle'})
    expect(response.body).toMatchObject({completeness:'partial',unavailableFamilies:['office']})
    expect(JSON.stringify(response.body)).not.toContain('private fixture')
  })
  it('rejects forged and cross-viewer cursors at the HTTP boundary',async()=>{
    const f=fixture();vi.mocked(f.adapters.tasks).mockResolvedValue([candidate,{...candidate,key:'task:two',id:'two'}])
    const response=await request(f.app).get(path).query({q:'needle',limit:1})
    expect(response.body.nextCursor).toBeTruthy()
    const second=createTestApp('/api',workspaceSearchRoutes({search:f.search,isMember:f.isMember}),{userId:'another'})
    expect((await request(second).get(path).query({q:'needle',cursor:response.body.nextCursor})).status).toBe(400)
    expect((await request(f.app).get(path).query({q:'needle',cursor:'forged'})).status).toBe(400)
  })
  it('mounts the authenticated router and bounded projection lifecycle in common OSS boot',()=>{
    const source=readFileSync(new URL('../../boot.ts',import.meta.url),'utf8')
    expect(source).toContain("app.use('/api', requireAuth(env.JWT_SECRET), workspaceSearchRoutes({")
    expect(source).toContain('if (runWorkers) officeSearchProjector.start()')
    expect(source).toContain('await officeSearchProjector.stop()')
  })
})
