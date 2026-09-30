import { createHmac, timingSafeEqual } from 'node:crypto'
import { verifyUploadFormat } from './uploads.js'
import { z } from 'zod'
import type { FilesApi, FilesContext } from '@use-brian/core'
import { Binding, RenderInput, ExportInput, canonical, renderDocument, renderExport, sha256, templateRegistry, type Template } from './render.js'

export class DocumentError extends Error { constructor(readonly code:string,readonly status=409){super(code)} }
const Upload = z.object({binding:Binding, filename:z.string().min(1).max(200), mimeType:z.enum(['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv','image/png','image/jpeg','application/json']), sha256:z.string().regex(/^[a-f0-9]{64}$/), base64:z.string().min(1).max(12_000_000)}).strict()
export type DocumentPrincipal = {userId:string;workspaceId:string}
export type DocumentDependencies = {
  files:FilesApi
  /** Must re-resolve human membership and Team/Project ceilings on every call. */
  authorize(principal:DocumentPrincipal):Promise<FilesContext>
  /** External uploads are never clean merely because their hash matches. */
  scan(bytes:Uint8Array,mimeType:string):Promise<'clean'|'rejected'>
  templates:Template[]
  /** Dedicated server-side locator MAC, not a credential embedded in a URL. */
  locatorSecret:string
  now?:()=>number
}
export function createDocumentService(deps:DocumentDependencies) {
  if(deps.locatorSecret.length<32)throw new Error('document_locator_secret_too_short')
  const resolve=templateRegistry(deps.templates), now=deps.now??Date.now
  const scoped=(p:DocumentPrincipal)=>(id:string,version:number)=>{const template=resolve(id,version);if(template.snapshot.workspaceId!==p.workspaceId)throw new DocumentError('document_template_not_found',404);return template}
  const bindingHash=(binding:unknown)=>sha256(canonical(Binding.parse(binding)))
  const mac=(p:DocumentPrincipal,id:string,hash:string,sha:string,expires:number)=>createHmac('sha256',deps.locatorSecret).update(canonical([p.workspaceId,p.userId,id,hash,sha,expires])).digest('hex')
  const ctx=async(p:DocumentPrincipal)=>{const c=await deps.authorize(p);if(c.userId!==p.userId||c.workspaceId!==p.workspaceId||c.assistantId||!c.clearance)throw new DocumentError('document_forbidden',403);return c}
  function receipt(p:DocumentPrincipal,id:string,binding:unknown,bytes:Uint8Array,mimeType:string) {
    const hash=bindingHash(binding),sha=sha256(bytes),expires=now()+30_000
    const query=new URLSearchParams({bindingHash:hash,sha256:sha,expires:String(expires),proof:mac(p,id,hash,sha,expires)})
    return {brianFileId:id,sha256:sha,sizeBytes:bytes.length,mimeType,bindingHash:hash,expiresAt:new Date(expires).toISOString(),downloadUrl:`/api/external-app/workspaces/${encodeURIComponent(p.workspaceId)}/documents/files/${encodeURIComponent(id)}?${query}`,requiresAuth:true as const}
  }
  const pathFor=(p:DocumentPrincipal,binding:unknown)=>`/office/sessions/external-app-documents/${p.userId}/${bindingHash(binding)}`
  async function find(p:DocumentPrincipal,binding:unknown,requestHash:string) {
    const current=await deps.files.stat(await ctx(p),pathFor(p,binding))
    if(!current.ok){if(current.error.kind==='not_found')return null;throw new DocumentError('document_lookup_unavailable',503)}
    if(!current.value.tags.includes(`request:${requestHash}`))throw new DocumentError('document_binding_conflict')
    const result=await read(p,current.value.id,binding);const {bytes,...receipt}=result;return receipt
  }
  async function save(p:DocumentPrincipal,binding:unknown,bytes:Uint8Array,mimeType:string,requestHash:string) {
    const c=await ctx(p),hash=bindingHash(binding)
    const stored=await deps.files.writeBytes(c,{path:pathFor(p,binding),bytes,mime:mimeType,sensitivity:'confidential',sessionOwned:true,tags:['external-app-document',`binding:${hash}`,`request:${requestHash}`]})
    if(!stored.ok){if(stored.error.kind==='conflict'){const cached=await find(p,binding,requestHash);if(cached)return cached;}throw new DocumentError('document_storage_failed',503)}
    return receipt(p,stored.value.id,binding,bytes,mimeType)
  }
  async function read(p:DocumentPrincipal,id:string,binding:unknown) {
    const hash=bindingHash(binding),c=await ctx(p),r=await deps.files.readBytes(c,id)
    if(!r.ok||r.value.file.userId!==p.userId||r.value.file.workspaceId!==p.workspaceId||!r.value.file.path.startsWith('/office/sessions/external-app-documents/')||!r.value.file.tags.includes(`binding:${hash}`))throw new DocumentError('document_not_found',404)
    const current=await deps.files.stat(await ctx(p),id)
    if(!current.ok||current.value.scopeVersion!==r.value.file.scopeVersion||current.value.validTo||current.value.retractedAt)throw new DocumentError('document_changed')
    return {...receipt(p,id,binding,r.value.bytes,r.value.file.mime),bytes:r.value.bytes}
  }
  return {
    async template(p:DocumentPrincipal,id:string,version:number){await ctx(p);const t=scoped(p)(id,version);return {...t,contentHash:sha256(canonical(t))}},
    async render(p:DocumentPrincipal,raw:unknown){await ctx(p);const input=RenderInput.parse(raw);const template=scoped(p)(input.templateId,input.templateVersion);if(sha256(canonical(template))!==input.templateHash)throw new DocumentError('template_hash_mismatch');const hash=sha256(canonical(input));const cached=await find(p,input.binding,hash);if(cached)return {...cached,templateHash:input.templateHash};const rendered=await renderDocument(input,scoped(p));return {...await save(p,rendered.binding,rendered.bytes,rendered.mimeType,hash),templateHash:rendered.templateHash}},
    async export(p:DocumentPrincipal,raw:unknown){await ctx(p);const input=ExportInput.parse(raw),hash=sha256(canonical(input));const cached=await find(p,input.binding,hash);if(cached)return cached;const rendered=await renderExport(input,p.workspaceId);return save(p,rendered.binding,rendered.bytes,rendered.mimeType,hash)},
    async reconcile(p:DocumentPrincipal,raw:unknown){const input=z.object({binding:Binding,requestHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(raw);await ctx(p);return {file:await find(p,input.binding,input.requestHash)}}, 
    async upload(p:DocumentPrincipal,raw:unknown){await ctx(p);const input=Upload.parse(raw);if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64))throw new DocumentError('document_invalid_bytes',400);const bytes=Buffer.from(input.base64,'base64');if(bytes.length>8*1024*1024||sha256(bytes)!==input.sha256)throw new DocumentError('document_hash_mismatch',400);await verifyUploadFormat(bytes,input.mimeType);if(await deps.scan(bytes,input.mimeType)!=='clean')throw new DocumentError('document_scan_rejected',422);return save(p,input.binding,bytes,input.mimeType,sha256(canonical(input)))}, 
    read,
    async download(p:DocumentPrincipal,id:string,raw:unknown){
      const q=z.object({bindingHash:z.string().regex(/^[a-f0-9]{64}$/),sha256:z.string().regex(/^[a-f0-9]{64}$/),expires:z.coerce.number().int(),proof:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(raw)
      if(q.expires<=now()||q.expires>now()+30_000||!timingSafeEqual(Buffer.from(q.proof,'hex'),Buffer.from(mac(p,id,q.bindingHash,q.sha256,q.expires),'hex')))throw new DocumentError('document_locator_expired',403)
      const r=await deps.files.readBytes(await ctx(p),id)
      if(!r.ok||r.value.file.userId!==p.userId||r.value.file.workspaceId!==p.workspaceId||!r.value.file.path.startsWith('/office/sessions/external-app-documents/')||!r.value.file.tags.includes(`binding:${q.bindingHash}`)||sha256(r.value.bytes)!==q.sha256)throw new DocumentError('document_not_found',404)
      const current=await deps.files.stat(await ctx(p),id)
      if(!current.ok||current.value.scopeVersion!==r.value.file.scopeVersion||current.value.validTo||current.value.retractedAt||now()>=q.expires)throw new DocumentError('document_changed')
      return {bytes:r.value.bytes,mimeType:r.value.file.mime,sha256:q.sha256,expiresAt:new Date(q.expires).toISOString()}
    },
  }
}
