import { describe,it,expect,vi } from 'vitest'
import { createComputerProfileTools,ComputerProfileToolSchemas } from './profile-tools.js'
import type { ToolContext } from '../tools/types.js'
const context=():ToolContext=>({userId:'owner',workspaceId:'workspace',assistantId:'assistant',sessionId:'chat',appId:'chat',channelType:'web',channelId:'chat',abortSignal:new AbortController().signal,activeCapabilities:new Set(['native_computer'])})
describe('owner-private computer chat tools',()=>{
  it('registers only five single-command tools, without task or goal inputs',()=>{
    const tools=createComputerProfileTools({execute:vi.fn()})
    expect(Object.keys(tools)).toEqual(['listComputerProfiles','computerObserve','computerAct','computerCapture','computerRelease'])
    for(const tool of Object.values(tools)) {
      expect(tool.requiresCapability).toBe('native_computer')
      for(const field of ['goal','taskId','userId','workspaceId','assistantId','conversationId','target','deadlineAt'])
        expect(tool.inputSchema.safeParse({[field]:'forged'}).success).toBe(false)
    }
  })
  it('strictly excludes targets, identities, arbitrary keys and extra action fields',()=>{
    const schema=ComputerProfileToolSchemas.computerAct
    const input={profile:'Mac',observationId:'obs',action:{kind:'invoke',ref:'button'}}
    expect(schema.safeParse(input).success).toBe(true)
    for(const extra of [{target:{}},{identity:{}},{text:'extra'},{deadlineAt:123}]) expect(schema.safeParse({...input,action:{...input.action,...extra}}).success).toBe(false)
    expect(schema.safeParse({...input,action:{kind:'key',key:'Enter'}}).success).toBe(false)
    expect(schema.safeParse({...input,action:{kind:'scroll',ref:'r',deltaY:601}}).success).toBe(false)
  })
  it('uses trusted context and actual tool name, rejects missing capability/aborted contexts',async()=>{
    const execute=vi.fn().mockResolvedValue({data:{code:'local_consent_required',requestId:'request'}})
    const tools=createComputerProfileTools({execute}),ctx=context()
    expect(await tools.computerObserve.execute({},ctx)).toEqual({data:{code:'local_consent_required',requestId:'request'}})
    expect(execute).toHaveBeenCalledWith('computerObserve',{},ctx)
    execute.mockClear()
    await tools.computerObserve.execute({userId:'forged'},ctx)
    await tools.computerObserve.execute({}, {...ctx,activeCapabilities:new Set()})
    await tools.computerObserve.execute({}, {...ctx,abortSignal:AbortSignal.abort()})
    expect(execute).not.toHaveBeenCalled()
  })
})
