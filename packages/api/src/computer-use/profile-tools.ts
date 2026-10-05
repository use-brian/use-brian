import { randomUUID } from 'node:crypto'
import { createComputerProfileTools, protectNativeImage, type ComputerProfileToolInput, type ComputerProfileToolName, type ToolContext, type ToolResult } from '@use-brian/core'
import { NATIVE_PROTOCOL, MAX_OBSERVATION_AGE_MS, sameIdentity, sameTarget, framePoint, type NativeObservation, type NativeAction } from '@use-brian/computer-control/protocol.js'
import { query } from '../db/client.js'
import { profileChatAuthorization, type ProfileChatScope } from '../db/computer-profile-store.js'
import type { NativeComputerService } from './service.js'
import type { ProfileImageAccounting } from './profile-image-accounting.js'
import type { ProfileImagePolicy, ProfileImagePermit } from './profile-image-policy.js'

function fresh(observation: NativeObservation) {
  return observation.capturedAt <= Date.now() && Date.now() - observation.capturedAt < MAX_OBSERVATION_AGE_MS
}
function captureAllowed(observation: NativeObservation) {
  return fresh(observation) && observation.target.appId === 'com.usebrian.NativeComputerFixture'
    && observation.captureCohort === 'public-shapes-v1' && observation.foreground
    && observation.completeness === 'complete' && !observation.nodes.some(n => n.sensitive)
}
function frameBound(observation: NativeObservation) {
  const frame = observation.frame
  return captureAllowed(observation) && !!frame && frame.width <= 1024 && frame.height <= 1024
    && frame.displayLayoutVersion === observation.displayLayoutVersion
    && JSON.stringify(frame.bounds) === JSON.stringify(observation.bounds)
}

/** Normal chat owns the model call. Image accounting is attached to its upload
 * boundary, not charged by capture. One command only: no task records,
 * background runner or action replay. */
export function composeComputerProfileTools(service:NativeComputerService, imagePolicy?: ProfileImagePolicy, imageAccounting?: ProfileImageAccounting) {
  const observations=new Map<string,{observation: NativeObservation; permit?: ProfileImagePermit; uploaded: boolean}>()
  const result=(code:string,extra:Record<string,unknown>={}):ToolResult=>({data:{code,...extra},isError:code!=='released'})
  async function execute(name:ComputerProfileToolName,input:ComputerProfileToolInput,context:ToolContext):Promise<ToolResult> {
    const scope:ProfileChatScope={userId:context.userId,workspaceId:context.workspaceId!,assistantId:context.assistantId!,conversationId:context.sessionId,toolName:name}
    try {
      for(const [key,cached] of observations) if(!fresh(cached.observation)) observations.delete(key)
      await context.authority?.assertCurrent()
      await service.assertPolicy({...scope,taskId:null})
      const eligible=await query<{id:string}>(`SELECT p.id FROM computer_profiles p WHERE ${profileChatAuthorization}`,
        [scope.userId,scope.workspaceId,scope.assistantId,scope.conversationId])
      const ids=new Set(eligible.rows.map(p=>p.id))
      const profiles=(await service.profiles.list(scope.userId,scope.workspaceId)).filter(p=>ids.has(p.id))
      if(name==='listComputerProfiles') return {data:{profiles:profiles.map(p=>({id:p.id,name:p.name,connected:p.connected,
        routingNotes:p.assistantRoutingNotes[scope.assistantId]??'',scope:'owner-private'}))}}
      const matches=input.profile ? profiles.filter(p=>p.id===input.profile || p.name===input.profile) : profiles
      if(matches.length!==1) return result(matches.length?'profile_ambiguous':'profile_unavailable')
      const profile=matches[0]
      if(name==='computerRelease') {
        await service.releaseProfile(scope,profile.id)
        for(const [key,{observation:obs}] of observations) if('profileId' in obs.identity && obs.identity.profileId===profile.id && obs.identity.conversationId===scope.conversationId) observations.delete(key)
        return result('released')
      }
      const binding=await service.profileBinding(scope,profile.id)
      if(!binding) return {data:await service.profiles.request(scope,profile.id),isError:true}
      const {grant}=binding
      if(grant.targets.length!==1) return result('target_ambiguous')
      const key=grant.identity.sessionId
      let action:NativeAction
      let permit:ProfileImagePermit | undefined
      let source:NativeObservation | undefined
      if(name==='computerObserve') action={kind:'observe',target:grant.targets[0]}
      else {
        const cached=observations.get(key)
        const observed=cached?.observation
        if(!observed || observed.id!==input.observationId || observed.epoch!==grant.epoch || !fresh(observed)
          || !sameIdentity(observed.identity,grant.identity) || !sameTarget(observed.target,grant.targets[0])) return result('fresh_observation_required')
        source=observed
        if(name==='computerCapture') {
          if(!grant.allowCapture || !grant.allowControl || !captureAllowed(observed)) return result('capture_not_allowed')
          if(!imageAccounting) return result('image_accounting_unavailable')
          permit=await imagePolicy?.(context,{id:grant.grantId,expiresAt:grant.expiresAt}) ?? undefined
          if(!permit) return result('image_policy_unavailable')
          action={kind:'capture',observationId:observed.id,target:grant.targets[0]}
        } else {
          if(!input.action) return result('invalid_input')
          if(input.action.kind==='visualInvoke') {
            if(!grant.allowCapture || !cached?.uploaded || !cached.permit || !frameBound(observed)
              || observed.frame!.id!==input.action.frameId) return result('fresh_frame_required')
            framePoint(observed.frame!,input.action.x,input.action.y)
            await cached.permit.assertCurrent(context)
            await service.assertProfilePublication(binding.scope,grant)
          }
          action={...input.action,observationId:observed.id,target:grant.targets[0]}
        }
      }
      // Atomically consume the original entry after policy awaits: two chat
      // invocations cannot both dispatch against the same cached observation.
      if(source && observations.get(key)?.observation!==source) return result('fresh_observation_required')
      // A failed, denied, timed-out or uncertain attempt cannot reuse the cache.
      observations.delete(key)
      context.abortSignal.throwIfAborted()
      await context.authority?.assertCurrent()
      if(source && !fresh(source)) return result('fresh_observation_required')
      if((action.kind==='capture' || action.kind==='visualInvoke') && !grant.allowCapture) return result('capture_not_allowed')
      const abort=()=>{void service.revoke(key,scope.userId).catch(()=>{})}
      context.abortSignal.addEventListener('abort',abort,{once:true})
      try {
        const receipt=await service.dispatch(binding.scope,{protocol:NATIVE_PROTOCOL,identity:grant.identity,grantId:grant.grantId,
          epoch:grant.epoch,commandId:randomUUID(),deadlineAt:Date.now()+29_000,action})
        if(context.abortSignal.aborted) return result('cancelled')
        const observation='observation' in receipt ? receipt.observation : undefined
        if(receipt.outcome==='executed' && observation) {
          await permit?.assertCurrent(context)
          // A receipt is not continuing authority. Discard late content after
          // disconnect, grant/assistant/policy revocation or chat invalidation.
          await context.authority?.assertCurrent()
          await service.assertProfilePublication(binding.scope,grant)
          await context.authority?.assertCurrent()
          context.abortSignal.throwIfAborted()
          if(!fresh(observation) || observation.epoch!==grant.epoch || !sameIdentity(observation.identity,grant.identity)
            || !sameTarget(observation.target,grant.targets[0])) return result('fresh_observation_required')
          const frame=action.kind==='capture' ? observation.frame : undefined
          if(action.kind==='capture' && (!permit || !grant.allowCapture || !frameBound(observation) || !frame?.data
            || Buffer.byteLength(frame.data,'base64')>2_000_000)) return result('capture_not_allowed')
          // Cache ORIGINAL frame identity/time/epoch, not a refreshed timestamp.
          // Frame bytes live only in the bounded opaque-image vault, never metadata.
          const cached={observation:structuredClone({...observation,
            // Only the sensitive-presence bit is needed for later capture checks;
            // do not retain potentially large AX trees in the frame cache.
            nodes:observation.nodes.filter(n=>n.sensitive).slice(0,1),
            frame:frame ? {...frame,data:''} : undefined}),permit,uploaded:false}
          observations.set(key,cached)
          for(const [k,o] of observations) if(!fresh(o.observation)) observations.delete(k)
          if(observations.size>500) observations.delete(observations.keys().next().value!)
          const images=frame && permit ? [protectNativeImage({mimeType:frame.mimeType,data:frame.data},context,{
            expiresAt:Math.min(grant.expiresAt,observation.capturedAt+MAX_OBSERVATION_AGE_MS),
            async assertCurrent(current) {
              if(observations.get(key)!==cached || !grant.allowCapture || !frameBound(cached.observation)) throw new Error('Native frame unavailable')
              await permit!.assertCurrent(current)
              await service.assertProfilePublication(binding.scope,grant)
              if(observations.get(key)!==cached || !fresh(cached.observation)) throw new Error('Native frame expired')
            },
            async reserve(current,tokens) { await permit!.reserve(current,tokens) },
            observed() { cached.uploaded=true },
            beginAttempt(current) { return imageAccounting!(current,grant,binding.scope) },
          })] : undefined
          return {data:{outcome:receipt.outcome,code:receipt.code,observationId:observation.id,
            capturedAt:observation.capturedAt,completeness:observation.completeness,nodes:observation.nodes,
            ...(frame ? {frameId:frame.id,width:frame.width,height:frame.height} : {})},...(images ? {images} : {})}
        }
        return {data:{outcome:receipt.outcome,code:receipt.code},isError:receipt.outcome!=='executed'}
      } finally {context.abortSignal.removeEventListener('abort',abort)}
    } catch {return result('unavailable')}
  }
  return createComputerProfileTools({execute})
}
