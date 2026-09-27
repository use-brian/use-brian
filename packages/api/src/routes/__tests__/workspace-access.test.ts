import express from 'express'
import request from 'supertest'
import {beforeEach,describe,expect,it,vi} from 'vitest'
import {workspaceAccessRoutes} from '../workspace-access.js'
import {WorkspaceAccessError} from '../../workspace-access/policy.js'
const reads=vi.hoisted(()=>({explain:vi.fn(),events:vi.fn()}))
vi.mock('../../workspace-access/access-inspection.js',()=>({explainWorkspaceAccess:reads.explain,getWorkspaceAccessEvents:reads.events}))
const workspace='10000000-0000-4000-8000-000000000001'
function app(userId?:string){const server=express();server.use((req,_res,next)=>{req.userId=userId;next()});server.use('/api',workspaceAccessRoutes());return server}
beforeEach(()=>{vi.resetAllMocks();reads.explain.mockResolvedValue({example:{matchesScope:false}});reads.events.mockResolvedValue({events:[]})})
describe('[COMP:api/workspace-access] inspection HTTP adapters',()=>{
  it('passes authenticated identity and untrusted selection to the canonical readers',async()=>{
    const response=await request(app('verified')).get(`/api/workspaces/${workspace}/access/explain?memberId=selected&action=edit`)
    expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('no-store')
    expect(reads.explain).toHaveBeenCalledWith(workspace,'verified',{memberId:'selected',action:'edit'})
    const audit=await request(app('verified')).get(`/api/workspaces/${workspace}/access/events?after=cursor&expectedPolicyRevision=8`)
    expect(audit.status).toBe(200);expect(reads.events).toHaveBeenCalledWith(workspace,'verified',{after:'cursor',expectedPolicyRevision:'8'})
  })
  it('keeps anonymous, unavailable and policy-conflict behavior typed',async()=>{
    expect((await request(app()).get(`/api/workspaces/${workspace}/access/explain`)).status).toBe(401)
    expect(reads.explain).not.toHaveBeenCalled()
    reads.explain.mockRejectedValueOnce(new WorkspaceAccessError('not_found',404))
    expect((await request(app('verified')).get(`/api/workspaces/${workspace}/access/explain`)).body).toEqual({error:'not_found'})
    reads.events.mockRejectedValueOnce(new WorkspaceAccessError('access_history_changed',409))
    expect((await request(app('verified')).get(`/api/workspaces/${workspace}/access/events`)).status).toBe(409)
  })
})
