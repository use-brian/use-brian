import {describe,it,expect,vi} from 'vitest'
import type {ToolContext} from '@use-brian/core'
import {withOfficeClassificationActor} from '../classification.js'
import {currentAgentAccess,runWithAgentAccess} from '../../db/agent-access-context.js'
const department={workspaceId:'workspace',userId:'viewer',assistantId:'assistant',base:'internal' as const,departments:{planning:'internal' as const},contextDepartment:null,binding:null,cap:null}
const ceiling={workspaceId:'workspace',userId:'viewer',clearance:'internal' as const,compartments:['team:planning'],projectIds:[]}
const actor={userId:'viewer',workspaceId:'workspace',assistantId:'assistant',executionContext:{security:{ceiling,access:{departmentRead:department}}}} as unknown as ToolContext
describe('[COMP:api/office-classification] assistant classification authority',()=>{
  it('refuses absent or mismatched bound assistant authority before calling the store',()=>{
    const write=vi.fn()
    expect(()=>withOfficeClassificationActor({...actor,executionContext:undefined},write)).toThrow()
    expect(()=>withOfficeClassificationActor({...actor,assistantId:'different'},write)).toThrow()
    expect(()=>withOfficeClassificationActor({...actor,workspaceId:'different'},write)).toThrow()
    expect(write).not.toHaveBeenCalled()
  })
  it('preserves the bound department and narrows an outer execution cap',async()=>{
    const result=await runWithAgentAccess({...ceiling,clearance:'public',departmentRead:{...department,cap:'public',base:'public',departments:{planning:'public'}}},()=>
      withOfficeClassificationActor(actor,async()=>currentAgentAccess()))
    expect(result).toMatchObject({clearance:'public',departmentRead:{assistantId:'assistant',cap:'public',departments:{planning:'public'}}})
  })
})
