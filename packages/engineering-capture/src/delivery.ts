/** Deterministic MCP delivery; no model forwarding. */
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {CaptureConfigurationSchema,EngineeringCaptureReceiptSchema} from '@use-brian/shared'
import {createHash,randomUUID} from 'node:crypto'
import {CaptureSpool,CaptureLocalError} from './spool.js'
import type {CollectorConfig} from './setup.js'
export type CaptureTransport={configuration():Promise<unknown>;deliver(payload:Record<string,unknown>):Promise<unknown>;close():Promise<void>}
export async function connectCaptureTransport(config:CollectorConfig,environment:Record<string,string|undefined>=process.env):Promise<CaptureTransport>{
 const credential=environment[config.credentialEnv]
 if(!credential)throw new CaptureLocalError('credential_reference_unavailable')
 const client=new Client({name:'brian-engineering-capture',version:'0.1.0'})
 await client.connect(new StreamableHTTPClientTransport(new URL(config.endpoint),{requestInit:{headers:{Authorization:`Bearer ${credential}`}}}))
 const call=async(name:string,args:Record<string,unknown>)=>{
  const result=await client.callTool({name,arguments:args},undefined,{timeout:10000})
  if(result.isError){const code=(result.structuredContent as {failureCode?:unknown}|undefined)?.failureCode
   const safe=typeof code==='string'&&/^[a-z_]+$/.test(code)?code:'capture_contract_unavailable'
   throw new CaptureLocalError(safe,['archive_publication_uncertain','archive_storage_unavailable','archive_quota_exceeded','capture_unavailable'].includes(safe))}
  return result.structuredContent
 }
 return {configuration:()=>call('getCaptureConfiguration',{}),deliver:payload=>call('ingestToBrain',payload),close:()=>client.close()}
}
export async function flushCapture(config:CollectorConfig,spool:CaptureSpool,connect:()=>Promise<CaptureTransport>=()=>connectCaptureTransport(config),maxEvents=100,leaseToken?:string){
 const token=leaseToken??randomUUID()
 if(!spool.acquireLease(token))return {leased:false,delivered:0}
 let transport:CaptureTransport|undefined,delivered=0
 try{
  if(spool.status().suspended)return {leased:true,delivered:0,suspended:true}
  if(!spool.next())return {leased:true,delivered:0}
  transport=await connect()
  const parsed=CaptureConfigurationSchema.safeParse(await transport.configuration())
  if(!parsed.success)throw new CaptureLocalError('capture_contract_unavailable')
  const c=parsed.data
  if(!c.ready||c.processingPurpose!=='archive_only')throw new CaptureLocalError(c.failureCode??'capture_configuration_unavailable')
  const fingerprint=createHash('sha256').update(JSON.stringify({connection:c.connectionId,purpose:c.processingPurpose,profile:c.profileId,revision:c.profileRevision,audience:c.audience})).digest('hex')
  spool.configurationFingerprint(fingerprint)
  for(let i=0;i<maxEvents;i++){
   if(!spool.acquireLease(token))break
   const event=spool.next();if(!event)break
   if(!c.permittedEventKinds.includes(event.payload.role as 'user'|'assistant'))throw new CaptureLocalError('capture_event_unsupported')
   if(Buffer.byteLength(String(event.payload.content))>c.limits.maxEventBytes)throw new CaptureLocalError('capture_event_limit_exceeded')
   const receipt=EngineeringCaptureReceiptSchema.safeParse(await transport.deliver(event.payload))
   if(!receipt.success)throw new CaptureLocalError('capture_contract_unavailable')
   if(receipt.data.deliveryStatus==='archived'&&(receipt.data.indexStatus!=='ready'||!receipt.data.fileId||!receipt.data.archiveId))throw new CaptureLocalError('capture_receipt_incomplete')
   spool.accept(event.id,receipt.data)
   if(receipt.data.deliveryStatus==='archived')delivered++
   else if(receipt.data.deliveryStatus==='pending')break
  }
  return {leased:true,delivered}
 }catch(error){
  const event=spool.next(Number.MAX_SAFE_INTEGER)
  const code=error instanceof CaptureLocalError?error.code:'capture_transport_unavailable'
  const status=typeof error==='object'&&error!==null?(error as {code?:unknown;status?:unknown}).code??(error as {status?:unknown}).status:undefined
  const permanent=error instanceof CaptureLocalError&&!error.retryable||status===401||status===403
  if(event)spool.fail(event.id,code,permanent)
  else spool.updateState({lastFailure:code,...(permanent?{suspended:true}:{})})
  return {leased:true,delivered,failureCode:code,suspended:permanent}
 }finally{await transport?.close().catch(()=>{});if(!leaseToken)spool.releaseLease(token)}
}
