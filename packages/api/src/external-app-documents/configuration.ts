import { z } from 'zod'
import { DocumentSnapshotSchema } from '@use-brian/office-model'
import { DocumentError, type DocumentDependencies } from './service.js'
import type { Source } from '../external-app-records/contracts.js'
const SourceSchema=z.object({workspaceId:z.string().uuid(),sourceId:z.string().min(1).max(200),publisherUserIds:z.array(z.string().uuid()),observerUserIds:z.array(z.string().uuid()),appRoles:z.array(z.string().min(1)),signingSecret:z.string().min(32)}).strict()
const TemplateSchema=z.object({id:z.string().min(1),version:z.number().int().positive(),snapshot:DocumentSnapshotSchema,fields:z.record(z.object({runId:z.string(),type:z.enum(['string','number','boolean'])}).strict())}).strict()
/** One shared OSS/hosted configuration path; absent configuration never activates policies. */
export function externalAppConfiguration(env:NodeJS.ProcessEnv=process.env):{sources:Source[];documents:Pick<DocumentDependencies,'templates'|'scan'>} {
 const sources=z.array(SourceSchema).parse(JSON.parse(env.EXTERNAL_APP_RECORD_SOURCES??'[]'))
 const templates=z.array(TemplateSchema).parse(JSON.parse(env.EXTERNAL_APP_DOCUMENT_TEMPLATES??'[]'))
 const endpoint=env.EXTERNAL_APP_SCAN_URL
 let url:URL|undefined
 if(endpoint){url=new URL(endpoint);if(url.username||url.password||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('External document scanner requires a trusted HTTPS origin')}
 return {sources,documents:{templates,scan:async(bytes,mimeType)=>{
  if(!url)throw new DocumentError('document_scanner_unconfigured',503)
  const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':mimeType,...(env.EXTERNAL_APP_SCAN_TOKEN?{Authorization:`Bearer ${env.EXTERNAL_APP_SCAN_TOKEN}`}:{})},body:Buffer.from(bytes) as unknown as BodyInit})
  if(!response.ok)throw new DocumentError('document_scanner_unavailable',503)
  const result=await response.json() as {state?:string};if(result.state!=='clean'&&result.state!=='rejected')throw new DocumentError('document_scanner_invalid',503)
  return result.state
 }}}
}
