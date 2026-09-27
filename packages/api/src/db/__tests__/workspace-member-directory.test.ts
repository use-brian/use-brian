import {beforeEach,describe,expect,it,vi} from 'vitest'

const state=vi.hoisted(()=>({connect:vi.fn(),rollback:vi.fn()}))
vi.mock('../client.js',()=>({
  getPool:()=>({connect:state.connect}),
  rollbackAndRelease:(client:unknown)=>state.rollback(client),
}))

import {readWorkspaceMemberDirectory} from '../workspace-member-directory.js'

const member={userId:'00000000-0000-4000-8000-000000000001',name:'Ari Example',email:'ari@example.com',avatarUrl:null}

function clientWith(rows:Array<{rows:unknown[]}>) {
  const snapshots=[...rows]
  const query=vi.fn(async(sql:string)=>sql.includes('SELECT COALESCE')?(snapshots.shift()??{rows:[]}):{rows:[]})
  return {query,release:vi.fn()}
}

describe('[COMP:api/workspace-member-directory] coherent publication',()=>{
  beforeEach(()=>vi.clearAllMocks())

  it('publishes only an identical second membership-bound snapshot',async()=>{
    const client=clientWith([{rows:[{members:[member]}]},{rows:[{members:[member]}]}])
    state.connect.mockResolvedValue(client)
    const reply=await readWorkspaceMemberDirectory(member.userId,'00000000-0000-4000-8000-000000000010')
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({viewerId:member.userId,members:[member]})
    expect(reply.status===200&&reply.body.validForMs).toBeGreaterThan(0)
    const sql=String(client.query.mock.calls.find(([statement])=>String(statement).includes('SELECT COALESCE'))?.[0])
    expect(sql).toContain('workspace_members caller')
    expect(sql).toContain('member.workspace_id=caller.workspace_id')
    expect(state.rollback).toHaveBeenCalledWith(client)
  })

  it('returns the same unavailable shape when the caller has no membership row',async()=>{
    const client=clientWith([{rows:[]}])
    state.connect.mockResolvedValue(client)
    await expect(readWorkspaceMemberDirectory(member.userId,'00000000-0000-4000-8000-000000000010')).resolves.toEqual({status:404,body:{error:'member_directory_unavailable'}})
    expect(client.query).toHaveBeenCalledTimes(3)
  })

  it('refuses publication when membership or profile rows change between snapshots',async()=>{
    const client=clientWith([{rows:[{members:[member]}]},{rows:[{members:[{...member,name:'Changed'}]}]}])
    state.connect.mockResolvedValue(client)
    await expect(readWorkspaceMemberDirectory(member.userId,'00000000-0000-4000-8000-000000000010')).resolves.toEqual({status:409,body:{error:'member_directory_changed'}})
  })

  it('refuses an exhausted publication lifetime',async()=>{
    const now=vi.spyOn(performance,'now').mockReturnValueOnce(0).mockReturnValueOnce(30_001)
    const client=clientWith([{rows:[{members:[member]}]},{rows:[{members:[member]}]}])
    state.connect.mockResolvedValue(client)
    await expect(readWorkspaceMemberDirectory(member.userId,'00000000-0000-4000-8000-000000000010')).resolves.toEqual({status:404,body:{error:'member_directory_unavailable'}})
    now.mockRestore()
  })
})
