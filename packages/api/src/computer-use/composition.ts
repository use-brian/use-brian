import { z } from 'zod'
import { createNativeComputerTools, NativeComputerOrchestrator, NativeRunTrace, type NativeRunObserver, type NativeLlmAdapter, type NativeSafetyPolicy, type NativeDecisionRuntime, type NativeInferenceBudget, type ToolContext, type Tool } from '@use-brian/core'
import type { NativeGrant } from '@use-brian/computer-control/protocol.js'
import { NativeComputerService } from './service.js'
import { createRelayNativeComputerProvider } from './provider.js'
/** Model-runtime child/host seam. Runtime resolves models and meters by trusted
 * context; policy must be a trusted supported-app cohort, never a model output. */
export type NativeRuntimeFactory = (context: ToolContext, grant: NativeGrant, trace?: NativeRunTrace) => Promise<{
  llm: NativeLlmAdapter
  policy?: NativeSafetyPolicy
  decisionRuntime?: NativeDecisionRuntime
  inferenceBudget?: NativeInferenceBudget
  /** Trusted run-local infrastructure status, not model/relay-provided metadata. */
  accountingStatus?: () => 'ready' | 'unavailable'
} | null>
/** Trusted synchronous host seam only. No model/UI option enables observation.
 * Called only after a successful durable claim; receives only a validated session UUID and epoch, no context, grant or authority.
 * Observers receive metadata only. */
export const NativeObserverBindingSchema = z.object({ sessionId: z.string().uuid(), epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()
export type NativeObserverBinding = Readonly<z.infer<typeof NativeObserverBindingSchema>>
export type NativeRunObserverFactory = (binding: NativeObserverBinding) => NativeRunObserver | undefined
export function composeNativeComputerTool(service: NativeComputerService, runtimeFactory?: NativeRuntimeFactory, observerFactory?: NativeRunObserverFactory): Tool {
  // No cross-run model cache: wiring lives only for the single durably claimed run.
  const unavailable=createNativeComputerTools({resolve:async()=>null}).nativeComputerTask
  return {...unavailable,async execute(input:unknown,context:ToolContext) {
    if(!context.workspaceId || !context.activeCapabilities?.has('native_computer') || !runtimeFactory || context.abortSignal.aborted) return {data:'Native computer unavailable',isError:true}
    await context.authority?.assertCurrent()
    const binding=await service.binding({userId:context.userId,workspaceId:context.workspaceId,assistantId:context.assistantId,conversationId:context.sessionId},context.taskAuthority?.taskIds)
    if(!binding || (input as {goal?:unknown})?.goal!==binding.grant.goal) return {data:'Native task must match the locally approved goal',isError:true}
    const {scope,grant}=binding; const id=grant.identity.sessionId
    if(!await service.claimRun(scope,grant)) return {data:{sessionId:id,duplicate:true,runState:'claimed'},isError:false}
    let trace: NativeRunTrace | undefined
    if (observerFactory) {
      try {
        const binding = NativeObserverBindingSchema.safeParse({ sessionId: id, epoch: grant.epoch })
        if (!binding.success) { trace = new NativeRunTrace(); trace.invalidate('invalid_metadata') }
        const observer = binding.success ? observerFactory(Object.freeze(binding.data)) : undefined
        if (typeof observer === 'function') trace = new NativeRunTrace(observer)
        else if (observer !== undefined) {
          // Do not await an incorrectly async/hung factory or leak its rejection.
          void Promise.resolve(observer).catch(() => {})
          trace = new NativeRunTrace(); trace.invalidate('invalid_metadata')
        }
      } catch { trace = new NativeRunTrace(); trace.invalidate('observer_failed') }
      trace?.startRun()
    }
    let unknown=true
    try {
      const runtime=await runtimeFactory(context,grant,trace)
      if(!runtime) { unknown=false; trace?.terminal('unavailable',0); return {data:'Native runtime unavailable',isError:true} }
      const orchestrator=new NativeComputerOrchestrator({...runtime,trace,provider:createRelayNativeComputerProvider(service,scope,id)})
      const tool=createNativeComputerTools({resolve:async()=>({authority:{grant,target:grant.targets[0],assertCurrent:()=>service.assertCurrent(scope,id)},orchestrator})}).nativeComputerTask
      const result=await tool.execute(input,context)
      unknown=(result.data as {outcome?:string})?.outcome==='execution_unknown'
      if (runtime.accountingStatus?.() === 'unavailable') {
        // Core may conservatively turn inference errors into abstention. Keep
        // accounting denial explicit at the task boundary; never call it semantic
        // uncertainty, success, or permission to retry an effect.
        trace?.terminal(unknown ? 'execution_unknown' : 'paused',0)
        return { ...result,isError:true,data:{ ...(result.data as Record<string,unknown>),
          outcome:unknown ? 'execution_unknown' : 'paused',reason:'Native accounting unavailable' } }
      }
      trace?.terminal(unknown ? 'execution_unknown' : result.isError ? 'paused' : 'completed',0)
      return result
    } catch (error) { trace?.terminal('execution_unknown',0); throw error } finally { await service.finishRun(id,context.userId,unknown) }
  }}
}
