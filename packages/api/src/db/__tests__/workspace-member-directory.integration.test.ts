import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {getAppPool,getPool} from '../client.js'
import {readWorkspaceMemberDirectory} from '../workspace-member-directory.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()

describe('[COMP:api/workspace-member-directory] real membership projection',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})

  it('returns current workspace people to a member and nothing to an outsider',async()=>{
    const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID()
    for(const [id,name,email,avatarUrl] of [
      [owner,'Fixture owner','owner@example.com','https://cdn.example/owner.png'],
      [member,'Fixture member','member@example.com',null],
      [outsider,'Fixture outsider','outsider@example.com',null],
    ] as const)await pool.query('INSERT INTO users(id,auth_provider_id,name,email,avatar_url) VALUES($1,$2,$3,$4,$5)',[id,`fixture-${id}`,name,email,avatarUrl])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Directory fixture',$2)",[workspaceId,owner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,'owner','assigned'),($1,$3,'member','assigned')",[workspaceId,owner,member])

    const first=await readWorkspaceMemberDirectory(member,workspaceId)
    expect(first.status).toBe(200)
    if(first.status!==200)throw new Error('expected member directory')
    expect(first.body).toMatchObject({workspaceId,viewerId:member})
    expect(first.body.members).toHaveLength(2)
    expect(first.body.members).toEqual(expect.arrayContaining([
      {userId:owner,name:'Fixture owner',email:'owner@example.com',avatarUrl:'https://cdn.example/owner.png'},
      {userId:member,name:'Fixture member',email:'member@example.com',avatarUrl:null},
    ]))
    expect(first.body.validForMs).toBeGreaterThan(0)
    expect(first.body.validForMs).toBeLessThanOrEqual(30_000)
    await expect(readWorkspaceMemberDirectory(outsider,workspaceId)).resolves.toEqual({status:404,body:{error:'member_directory_unavailable'}})

    await pool.query("UPDATE users SET name='Renamed member' WHERE id=$1",[member])
    const renamed=await readWorkspaceMemberDirectory(owner,workspaceId)
    expect(renamed.status===200&&renamed.body.members).toContainEqual(expect.objectContaining({userId:member,name:'Renamed member'}))
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,member])
    await expect(readWorkspaceMemberDirectory(member,workspaceId)).resolves.toEqual({status:404,body:{error:'member_directory_unavailable'}})
    const remaining=await readWorkspaceMemberDirectory(owner,workspaceId)
    expect(remaining.status===200&&remaining.body.members.map(row=>row.userId)).toEqual([owner])
  })
})
