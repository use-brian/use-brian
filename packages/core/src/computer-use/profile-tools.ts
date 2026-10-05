import { z } from 'zod'
import { buildTool, type Tool, type ToolContext, type ToolResult } from '../tools/types.js'

const id = z.string().min(1).max(256)
const selection = z.object({ profile: id.optional() }).strict()
/** No target, identity, scope, task, goal, key sequence or deadline is model-controlled. */
export const ComputerProfileActionSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('focus')}).strict(),
  z.object({kind:z.literal('invoke'),ref:id}).strict(),
  z.object({kind:z.literal('select'),ref:id}).strict(),
  z.object({kind:z.literal('setValue'),ref:id,text:z.string().max(4096)}).strict(),
  z.object({kind:z.literal('scroll'),ref:id,deltaY:z.number().int().min(-600).max(600)}).strict(),
  z.object({kind:z.literal('visualInvoke'),frameId:id,x:z.number().finite().nonnegative(),y:z.number().finite().nonnegative()}).strict(),
])
export const ComputerProfileToolSchemas = {
  listComputerProfiles:z.object({}).strict(),
  computerObserve:selection,
  computerAct:selection.extend({observationId:id,action:ComputerProfileActionSchema}).strict(),
  computerCapture:selection.extend({observationId:id}).strict(),
  computerRelease:selection,
}
export type ComputerProfileToolName = keyof typeof ComputerProfileToolSchemas
export type ComputerProfileToolInput = {profile?:string;observationId?:string;action?:z.infer<typeof ComputerProfileActionSchema>}
export function createComputerProfileTools(deps:{
  execute(name:ComputerProfileToolName,input:ComputerProfileToolInput,context:ToolContext):Promise<ToolResult>
}): Record<ComputerProfileToolName,Tool> {
  const descriptions:Record<ComputerProfileToolName,string>={
    listComputerProfiles:'List your owner-private computer profiles enabled for this assistant. Profiles are not shared with other users.',
    computerObserve:'Observe the single locally approved window. Select a profile by ID or unique name; omission requires one eligible profile. If consent is required, wait for local approval then call observe again. Never resumes a previous action.',
    computerAct:'Propose one action against a fresh observation from this chat and lease. Every side effect requires local approval. Never retry an uncertain action automatically.',
    computerCapture:'Capture the approved window only when local capture consent and model image policy are supported. Requires a fresh observation.',
    computerRelease:'Release this chat’s computer lease. Another chat needs new local consent. Does not clear uncertain execution.',
  }
  return Object.fromEntries(Object.entries(ComputerProfileToolSchemas).map(([name,schema])=>[name,buildTool({
    name,description:descriptions[name as ComputerProfileToolName],inputSchema:schema,
    requiresCapability:'native_computer',isReadOnly:name==='listComputerProfiles',isConcurrencySafe:false,
    async execute(input,context) {
      if(!context.userId || !context.workspaceId || !context.assistantId || !context.sessionId
        || !context.activeCapabilities?.has('native_computer') || context.abortSignal.aborted)
        return {data:{code:'unavailable'},isError:true}
      await context.authority?.assertCurrent()
      // Validate again for direct callers that do not use the engine executor.
      const parsed=schema.safeParse(input)
      if(!parsed.success) return {data:{code:'invalid_input'},isError:true}
      return deps.execute(name as ComputerProfileToolName,parsed.data,context)
    },
  })])) as unknown as Record<ComputerProfileToolName,Tool>
}
