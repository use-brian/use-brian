import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, query } from '../../db/client.js'
import { findAssistantById } from '../../db/users.js'
import { resolveTurnScopeSystem } from '../resolve-turn-scope.js'
import { listUsableWorkspaceConnectors } from '../../connectors/usable-connectors.js'
import { connectorExposureAllowed } from '../connector-exposure.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe('[COMP:api/connector-context] real viewer and assistant department authority', () => {
  it('requires both principals, without an owner/admin bypass, and honors removal and expiry', async () => {
    const workspace=randomUUID(), owner=randomUUID(), admin=randomUUID(), member=randomUUID(), custodian=randomUUID()
    const assistant=randomUUID(), weak=randomUUID(), department=randomUUID(), other=randomUUID()
    for (const user of [owner,admin,member,custodian]) await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)",[user])
    await query("INSERT INTO workspaces(id,name,purpose,owner_user_id,department_read_v2) VALUES($1,'Connector fixture','test',$2,true)",[workspace,owner])
    for(const [user,role] of [[owner,'owner'],[admin,'admin'],[member,'member'],[custodian,'member']]) await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')",[workspace,user,role])
    for(const [id,kind] of [[assistant,'primary'],[weak,'standard']]) await query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance,compartments) VALUES($1,'Fixture assistant',$2,$3,$4,'confidential',NULL)",[id,workspace,owner,kind])
    for(const id of [department,other]) await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,$1::text,$3,'team',$1::text,$4)",[id,workspace,custodian,`team:${id}`])
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[workspace,department,member])
    const canUse=async(userId:string,assistantId=assistant,required=[department])=>{
      const acting=await findAssistantById(assistantId)
      if(!acting) throw new Error('Fixture assistant missing')
      const scope=await resolveTurnScopeSystem({workspaceId:workspace,userId,assistant:acting})
      return connectorExposureAllowed(scope,{compartments:required.map(id=>`team:${id}`),projectIds:[]})
    }
    // Display/config surfaces must admit department clearance above base clearance.
    await query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[workspace,member])
    const visible = async(userId=member) => (await listUsableWorkspaceConnectors({
      workspaceId: workspace, userId,
      connectorInstanceStore: { listByUser: async()=>[], listByWorkspace: async()=>[
        {id:'department-connector',sensitivity:'confidential',compartments:[`team:${department}`]},
        {id:'general-connector',sensitivity:'confidential',compartments:[]},
      ] } as never,
      connectorGrantStore: { listForTargetSystem: async()=>[{ grantedByUserId: custodian, compartments:[`team:${department}`],
        instance:{id:'granted-connector',sensitivity:'confidential'} }] } as never,
    })).map(row=>row.instance.id)
    expect(await visible()).toEqual(['department-connector','granted-connector'])
    expect(await visible(owner)).toEqual(['general-connector'])
    expect(await visible(admin)).toEqual(['general-connector'])
    expect(await canUse(member)).toBe(true)
    expect(await canUse(owner)).toBe(false)
    expect(await canUse(admin)).toBe(false)
    expect(await canUse(member,weak)).toBe(false)
    expect(await canUse(member,assistant,[other])).toBe(false)
    expect(await canUse(member,assistant,[department,other])).toBe(false)
    await query("UPDATE department_edges SET expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2",[workspace,member])
    expect(await canUse(member)).toBe(false)
    expect(await visible()).toEqual([])
    await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[workspace,member])
    expect(await canUse(member)).toBe(false)
    expect(await visible()).toEqual([])
  })
})
