import { describe,it,expect } from 'vitest'
import { syntheticTemplate } from '../synthetic-template.js'
import { renderDocument,renderExport,templateRegistry,templateHash } from '../render.js'
import JSZip from 'jszip'
import { createDocumentService } from '../service.js'
import { externalAppConfiguration } from '../configuration.js'
import { verifyUploadFormat } from '../uploads.js'
const template=syntheticTemplate('a0000000-0000-4000-8000-000000000020')
const binding={recordType:'example',recordId:'synthetic',recordVersion:1,submittedVersion:1,purpose:'test:v1'}
const request={templateId:template.id,templateVersion:1,templateHash:templateHash(template),binding,values:{name:'测试 Synthetic',amount:'123.45'},format:'docx'}
describe('[COMP:api/external-app-documents] pinned Office render',()=>{
 it('renders real bilingual DOCX bytes and rejects stale snapshots and untyped fields',async()=>{
  const resolve=templateRegistry([template]);const r=await renderDocument(request,resolve)
  const zip=await JSZip.loadAsync(r.bytes);expect(await zip.file('word/document.xml')!.async('string')).toContain('测试 Synthetic')
  await expect(verifyUploadFormat(r.bytes,'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).resolves.toBeUndefined()
  await expect(verifyUploadFormat(r.bytes,'application/pdf')).rejects.toThrow('document_media_type_mismatch')
  await expect(verifyUploadFormat(Buffer.from('not a Word file'),'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).rejects.toThrow('document_media_type_mismatch')
  await expect(renderDocument({...request,templateHash:'0'.repeat(64)},resolve)).rejects.toThrow('template_hash_mismatch')
  await expect(renderDocument({...request,values:{name:7,amount:'1'}},resolve)).rejects.toThrow('template_field_type')
  await expect(renderDocument({...request,values:{...request.values,actorId:'forged'}},resolve)).rejects.toThrow('template_fields_mismatch')
 })
 it('exports complete CSV and real XLSX with formula strings inert',async()=>{
  const input={binding,title:'Export',columns:['姓名','Amount'],rows:[['=HYPERLINK("bad")',12],['测试',23]],format:'csv'}
  const csv=await renderExport(input,template.snapshot.workspaceId);expect(Buffer.from(csv.bytes).toString()).toContain("'=HYPERLINK")
  const xlsx=await renderExport({...input,format:'xlsx'},template.snapshot.workspaceId)
  const zip=await JSZip.loadAsync(xlsx.bytes);expect(await zip.file('xl/worksheets/sheet1.xml')!.async('string')).not.toContain('<f>')
  const json=await renderExport({...input,format:'json'},template.snapshot.workspaceId);expect(JSON.parse(Buffer.from(json.bytes).toString()).rows).toEqual(input.rows)
 })
 it('never exposes a template from another workspace and fails closed without scanner configuration',async()=>{
  const config=externalAppConfiguration({})
  expect(config.sources).toEqual([])
  await expect(config.documents.scan(new Uint8Array([1]),'application/pdf')).rejects.toThrow('document_scanner_unconfigured')
  expect(()=>externalAppConfiguration({EXTERNAL_APP_SCAN_URL:'http://scanner.example'})).toThrow()
  const service=createDocumentService({files:{} as never,templates:[template],locatorSecret:'x'.repeat(32),scan:config.documents.scan,authorize:async p=>({...p,assistantKind:'standard',clearance:'confidential'})})
  await expect(service.template({userId:'synthetic',workspaceId:'other-workspace'},template.id,1)).rejects.toThrow('document_template_not_found')
  await expect(service.template({userId:'synthetic',workspaceId:template.snapshot.workspaceId},template.id,1)).resolves.toMatchObject({id:template.id})
 })
})
