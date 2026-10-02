import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@use-brian/core'
import { createOrganizationTools, createWorkspaceAccessTools } from '../tools.js'
import { WorkspaceAccessError } from '../policy.js'
import { SCOPE_REVIEW_KINDS, sourceAdapter } from '../scope-review-registry.js'

const mocks=vi.hoisted(()=>({read:vi.fn(),write:vi.fn(),orgPrepare:vi.fn(),access:vi.fn(),history:vi.fn(),selectedRequest:vi.fn(),prepare:vi.fn(),command:vi.fn(),scopeInventory:vi.fn(),scopeReview:vi.fn(),scopeCommand:vi.fn()}))
vi.mock('../../db/org-chart-store.js',()=>({getOrganizationChart:mocks.read,executeOrganizationCommand:mocks.write,OrganizationError:class extends Error{constructor(readonly code:string,readonly status:number){super(code)}}}))
vi.mock('../organization-command-review.js',()=>({prepareOrganizationCommand:mocks.orgPrepare,applyOrganizationCommandIntent:mocks.write}))
vi.mock('../service.js',()=>({getWorkspaceAccess:mocks.access,getWorkspaceAccessHistory:mocks.history,getWorkspaceAccessRequest:mocks.selectedRequest}))
vi.mock('../command-review.js',()=>({prepareDepartmentCommand:mocks.prepare,applyDepartmentCommandIntent:mocks.command}))
vi.mock('../scope-review.js',async importOriginal=>({...await importOriginal<typeof import('../scope-review.js')>(),getWorkspaceScopeInventory:mocks.scopeInventory,getWorkspaceScopeReview:mocks.scopeReview,executeWorkspaceScopeReview:mocks.scopeCommand}))
const context:ToolContext={userId:'billing-owner',workspaceActorUserId:'verified-member',workspaceId:'workspace',assistantId:'assistant',sessionId:'session',appId:'app',channelType:'web',channelId:'web',abortSignal:new AbortController().signal}
const command={type:'org.unit.save' as const,name:'Research',parentId:null,teamId:null,directoryVisibility:'members' as const,position:0}
beforeEach(()=>{mocks.read.mockReset().mockResolvedValue({canManage:true,units:[],subjects:[],teams:[]});mocks.write.mockReset().mockResolvedValue({revision:'2'});mocks.orgPrepare.mockReset().mockImplementation(async(_w,_u,input)=>({command:input.command,effects:[{kind:'unit',name:'Research',changes:[{field:'name',before:[{value:'none'}],after:[{value:'Research'}]}]}],expiresAt:'2030-01-01T00:00:00Z'}))})
const orgIntent=(value:unknown)=>({command:value,expectedRevision:'2',expectedPolicyRevision:'8',idempotencyKey:'10000000-0000-4000-8000-000000000003'})
describe('[COMP:api/organization-chart] native operation parity and acting identity',()=>{
  it('prepares the exact reviewed organization intent and consumes it on execution',async()=>{
    const input=orgIntent(command),tool=createOrganizationTools()[1]
    expect(tool.inputSchema.safeParse(input).success).toBe(true)
    expect(tool.inputSchema.safeParse(command).success).toBe(false)
    expect((await tool.describeConfirmation!(input,context))?.join(' ')).toContain('Research')
    expect(mocks.orgPrepare).toHaveBeenCalledWith('workspace','verified-member',input)
    await tool.execute(input,context)
    expect(mocks.write).toHaveBeenCalledWith('workspace','verified-member',input)
    mocks.orgPrepare.mockRejectedValueOnce(new WorkspaceAccessError('access_policy_conflict',409))
    await expect(tool.describeConfirmation!(input,context)).rejects.toThrow('access_policy_conflict')
  })
  it('uses the authenticated actor and retains per-call confirmation',async()=>{
    const [read,write]=createOrganizationTools(),input=orgIntent(command)
    await read.execute({},context);expect(mocks.read).toHaveBeenCalledWith('workspace','verified-member')
    await write.execute(input,context);expect(mocks.write).toHaveBeenCalledWith('workspace','verified-member',input)
    expect(write.requiresConfirmation).toBe(true);expect(write.allowPersistentApproval).toBe(false)
  })
  it('refuses billing-only, external and unbound programmatic principals',async()=>{
    for(const patch of [{workspaceActorUserId:undefined},{systemRead:true},{programmaticPrincipal:{kind:'brain_key' as const,credentialId:'key'}}]){
      for(const tool of createOrganizationTools())expect((await tool.execute(tool.isReadOnly?{}:orgIntent(command),{...context,...patch})).isError).toBe(true)
    }
    expect(mocks.read).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();expect(mocks.orgPrepare).not.toHaveBeenCalled()
  })
  it('uses canonical labels for confirmation and never replays an old preview after commit',async()=>{
    const write=createOrganizationTools()[1],input=orgIntent(command)
    const lines=await write.describeConfirmation!(input,context)
    expect(lines?.join(' ')).toContain('Research');expect(lines?.join(' ')).toContain('Department memberships, clearance and content access are unchanged.')
    mocks.orgPrepare.mockResolvedValueOnce({alreadyApplied:true})
    expect((await write.describeConfirmation!(input,context))?.join(' ')).not.toContain('Research')
    mocks.orgPrepare.mockRejectedValueOnce(new WorkspaceAccessError('admin_required'))
    await expect(write.describeConfirmation!(input,context)).rejects.toThrow('admin_required')
  })
})

describe('[COMP:api/workspace-access] native operation parity',()=>{
  beforeEach(()=>{mocks.access.mockReset().mockResolvedValue({teams:[],people:[],requests:[],policyRevision:'1'});mocks.command.mockReset().mockResolvedValue({policyRevision:'2'});mocks.prepare.mockReset().mockResolvedValue({changes:[],expiresAt:'2030-01-01T00:00:00Z'})})
  it('binds the person review to current policy and describes before/after permission values',async()=>{
    const id='10000000-0000-4000-8000-000000000001'
    mocks.access.mockResolvedValue({canAdminister:true,teams:[],people:[{id,name:'Riley',role:'member',access:{clearance:'internal',teamScopeMode:'legacy'}}],policyRevision:'2',requests:[]})
    const input={type:'member.access.set',userId:id,clearance:'public',teamScopeMode:'assigned',expectedPolicyRevision:'2'},tool=createWorkspaceAccessTools()[2]
    const intent={command:input,expectedPolicyRevision:'2',idempotencyKey:'20000000-0000-4000-8000-000000000001'}
    const lines=(await tool.describeConfirmation!(intent,context))?.join(' ')
    expect(lines).toContain('internal → public');expect(lines).toContain('legacy → assigned')
    await expect(tool.describeConfirmation!({...intent,command:{...input,expectedPolicyRevision:'1'}},context)).rejects.toThrow('access_policy_conflict')
    await tool.execute(intent,context);expect(mocks.command).toHaveBeenCalledWith('workspace','verified-member',intent);expect(mocks.prepare).toHaveBeenCalledWith('workspace','verified-member',intent)
  })
  it('lets a retried confirmation describe a committed receipt without exposing old privileged effects',async()=>{
    const id='10000000-0000-4000-8000-000000000001',input={command:{type:'department.archive',teamId:id},expectedPolicyRevision:'1',idempotencyKey:id}
    mocks.prepare.mockResolvedValue({alreadyApplied:true,changes:[]})
    const lines=await createWorkspaceAccessTools()[2].describeConfirmation!(input,context)
    expect(lines?.join(' ')).toContain('does not repeat the change')
    expect(mocks.access).not.toHaveBeenCalled()
  })
  it('routes all access operations through the verified human actor and requires nonpersistent write confirmation',async()=>{
    const [inspect,request,manage]=createWorkspaceAccessTools()
    await inspect.execute({},context)
    expect(mocks.access).toHaveBeenCalledWith('workspace','verified-member')
    const id='10000000-0000-4000-8000-000000000001'
    const input={command:{type:'department.member.set',teamId:id,userId:id,enabled:true},expectedPolicyRevision:'1',idempotencyKey:id}
    expect(manage.inputSchema.safeParse(input).success).toBe(true)
    expect(manage.inputSchema.safeParse(input.command).success).toBe(false)
    await manage.execute(input,context)
    expect(mocks.command).toHaveBeenCalledWith('workspace','verified-member',input)
    for(const tool of [request,manage]){expect(tool.requiresConfirmation).toBe(true);expect(tool.allowPersistentApproval).toBe(false)}
  })
  it('uses the same history service and requires a paired continuation revision',async()=>{
    const tool=createWorkspaceAccessTools()[0],after='10000000-0000-4000-8000-000000000001'
    mocks.history.mockResolvedValue({requests:[],grants:[],nextCursor:null})
    await tool.execute({history:'requests',after,expectedPolicyRevision:'5'},context)
    expect(mocks.history).toHaveBeenCalledWith('workspace','verified-member','requests',{after,expectedPolicyRevision:'5'})
    for(const input of [{after},{history:'requests',after},{after,expectedPolicyRevision:'5'},{history:'events',explain:{}},{registry:true,explain:{}},{registry:true,history:'events'},{registry:false}])expect(tool.inputSchema.safeParse(input).success).toBe(false)
    expect(tool.inputSchema.safeParse({history:'grants'}).success).toBe(true)
    expect(tool.inputSchema.safeParse({history:'events'}).success).toBe(true)
    expect(tool.inputSchema.safeParse({explain:{action:'edit'}}).success).toBe(true)
    expect(tool.inputSchema.safeParse({registry:true}).success).toBe(true)
  })
  it('refuses an unbound or unattended actor before calling the shared access service',async()=>{
    for(const patch of [{workspaceActorUserId:undefined},{systemRead:true},{programmaticPrincipal:{kind:'brain_key' as const,credentialId:'key'}}]){
      for(const tool of createWorkspaceAccessTools())expect((await tool.execute({}, {...context,...patch})).isError).toBe(true)
    }
    expect(mocks.access).not.toHaveBeenCalled();expect(mocks.command).not.toHaveBeenCalled()
  })
  it('requires a current, authorized review and includes the beneficiary and interval in confirmation',async()=>{
    const id='10000000-0000-4000-8000-000000000001',hash='a'.repeat(64)
    mocks.access.mockResolvedValue({teams:[],people:[],policyRevision:'2',requests:[{id,canDecide:true,version:'1',payloadHash:hash,targetTeamName:'Research',beneficiaryName:'Riley',reason:'Review requirements',startsAt:'2030-01-01',expiresAt:'2030-01-31'}]})
    mocks.selectedRequest.mockResolvedValue({policyRevision:'2',request:(await mocks.access()).requests[0]})
    mocks.access.mockResolvedValue({teams:[],people:[],policyRevision:'2',requests:[]})
    const tool=createWorkspaceAccessTools()[2],input={type:'access.request.decide',requestId:id,expectedVersion:'1',payloadHash:hash,policyRevision:'2',decision:'approved'}
    const intent={command:input,expectedPolicyRevision:'2',idempotencyKey:'20000000-0000-4000-8000-000000000001'}
    expect((await tool.describeConfirmation!(intent,context))?.join(' ')).toContain('Riley')
    expect((await tool.describeConfirmation!(intent,context))?.join(' ')).toContain('2030-01-31')
    await expect(tool.describeConfirmation!({...intent,command:{...input,policyRevision:'1'}},context)).rejects.toThrow('request_review_stale')
  })
})

describe('[COMP:api/workspace-scope-review] attended tool parity',()=>{
  it('lets Brian inspect every registered family without inventing new classification actions',async()=>{
    const inspect=createWorkspaceAccessTools().find(tool=>tool.name==='inspectScopeReview')!
    for(const kind of SCOPE_REVIEW_KINDS){
      expect(inspect.inputSchema.safeParse({kind}).success).toBe(true)
      await inspect.execute({kind},context)
      expect(mocks.scopeInventory).toHaveBeenLastCalledWith('workspace','verified-member',kind,undefined,undefined,undefined)
    }
    expect(inspect.inputSchema.safeParse({kind:'unknown_table'}).success).toBe(false)
    expect(sourceAdapter('session_message').actions).toEqual(['hold'])
    expect(sourceAdapter('office_artifact').actions).toEqual(['confirm_general','hold'])
  })
  it.each(['scope_review_impact_too_large','scope_review_impact_missing'])('explains recovery for %s without recommending a blind retry',async(code)=>{
    const manage=createWorkspaceAccessTools().find(tool=>tool.name==='manageScopeReview')!
    mocks.scopeCommand.mockRejectedValueOnce(new WorkspaceAccessError(code,409))
    expect(await manage.execute({},context)).toMatchObject({isError:true,data:{error:code,retrySafe:false,message:expect.stringContaining('new preview')}})
  })
  it('binds inventory and mutation to the verified actor and displays the exact saved batch',async()=>{
    const tools=createWorkspaceAccessTools(),inspect=tools.find(t=>t.name==='inspectScopeReview')!,manage=tools.find(t=>t.name==='manageScopeReview')!
    const id='10000000-0000-4000-8000-000000000001',payloadHash='a'.repeat(64)
    mocks.scopeReview.mockResolvedValue({id,version:'2',payloadHash,action:'assign_team',resourceKind:'memory',targetCompartment:'research',reason:'Review source',items:[{resourceId:id,status:'pending',impact:{version:1,descendants:[{resourceId:'derived-reference',version:'1',held:false}]},source:{sensitivity:'confidential'}}]})
    await inspect.execute({kind:'memory'},context)
    expect(mocks.scopeInventory).toHaveBeenCalledWith('workspace','verified-member','memory',undefined,undefined,undefined)
    await inspect.execute({kind:'memory',reviewAfter:id},context)
    expect(mocks.scopeInventory).toHaveBeenLastCalledWith('workspace','verified-member','memory',undefined,undefined,id)
    const input={type:'scope.review.apply',reviewId:id,expectedVersion:'2',payloadHash}
    expect((await manage.describeConfirmation!(input,context))?.join(' ')).toContain('research')
    expect((await manage.describeConfirmation!(input,context))?.join(' ')).toContain('confidential')
    expect((await manage.describeConfirmation!(input,context))?.join(' ')).toContain('derived-reference')
    await expect(manage.describeConfirmation!({...input,expectedVersion:'1'},context)).rejects.toThrow('scope_review_changed')
    await manage.execute(input,context)
    expect(mocks.scopeCommand).toHaveBeenCalledWith('workspace','verified-member',input)
    expect(manage.requiresConfirmation).toBe(true);expect(manage.allowPersistentApproval).toBe(false)
  })
})
