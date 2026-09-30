/** Version-pinned, scalar-only external document rendering. [COMP:api/external-app-documents] */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DocumentSnapshotSchema, SpreadsheetSnapshotSchema, type DocumentSnapshot } from '@use-brian/office-model'
import { exportOfficeDocument, exportOfficeSpreadsheet, convertToPdfWithLibreOffice } from '@use-brian/core'

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
export const Binding = z.object({ recordType:z.string().min(1).max(80), recordId:z.string().min(1).max(200), recordVersion:z.number().int().positive(), submittedVersion:z.number().int().positive().nullable(), purpose:z.string().min(1).max(200) }).strict()
const scalar = z.union([z.string().max(20000),z.number().finite(),z.boolean(),z.null()])
export const RenderInput = z.object({ templateId:z.string().min(1), templateVersion:z.number().int().positive(), templateHash:z.string().regex(/^[a-f0-9]{64}$/), binding:Binding, values:z.record(scalar), format:z.enum(['docx','pdf']) }).strict()
export const ExportInput = z.object({ binding:Binding, title:z.string().min(1).max(200), columns:z.array(z.string().min(1).max(200)).min(1).max(100), rows:z.array(z.array(scalar).max(100)).max(10000), format:z.enum(['csv','xlsx','pdf','json']) }).strict()
export type Template = { id:string; version:number; snapshot:DocumentSnapshot; fields:Record<string,{ runId:string; type:'string'|'number'|'boolean' }> }
export const templateHash = (template:Template) => sha256(canonical(template))
const mime = { docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf:'application/pdf', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv:'text/csv', json:'application/json' }
export function templateRegistry(templates:Template[]) {
  const pinned = templates.map(t => ({...structuredClone(t),snapshot:DocumentSnapshotSchema.parse(t.snapshot)}))
  return (id:string, version:number) => { const t=pinned.find(t=>t.id===id&&t.version===version); if(!t) throw new Error('template_unavailable'); return structuredClone(t) }
}
export async function renderDocument(raw:unknown, resolve:ReturnType<typeof templateRegistry>) {
  const input=RenderInput.parse(raw), template=resolve(input.templateId,input.templateVersion)
  if(templateHash(template)!==input.templateHash) throw new Error('template_hash_mismatch')
  if(Object.keys(input.values).sort().join('\0')!==Object.keys(template.fields).sort().join('\0')) throw new Error('template_fields_mismatch')
  // No HTML/XML evaluation, links, arbitrary property paths, or caller-supplied snapshots.
  for(const [key,field] of Object.entries(template.fields)) {
    if(typeof input.values[key]!==field.type) throw new Error('template_field_type')
    let count=0
    const visit=(node:unknown):void=>{ if(!node || typeof node!=='object') return; if(Array.isArray(node)){node.forEach(visit);return} const obj=node as Record<string,unknown>; if(obj.id===field.runId&&typeof obj.text==='string'){obj.text=String(input.values[key]);count++} else Object.values(obj).forEach(visit) }
    visit(template.snapshot)
    if(count!==1) throw new Error('template_target_invalid')
  }
  const docx=await exportOfficeDocument(template.snapshot)
  const bytes=input.format==='pdf'?await convertToPdfWithLibreOffice(docx.bytes,{inputName:'document.docx'}):docx.bytes
  return {bytes,mimeType:mime[input.format],sha256:sha256(bytes),sizeBytes:bytes.length,binding:input.binding,templateHash:input.templateHash}
}
export async function renderExport(raw:unknown, workspaceId:string) {
  const input=ExportInput.parse(raw)
  if(input.rows.some(row=>row.length!==input.columns.length)) throw new Error('export_row_width')
  const grid=[input.columns,...input.rows]
  let bytes:Uint8Array
  if(input.format==='json') {
    bytes=Buffer.from(JSON.stringify({title:input.title,columns:input.columns,rows:input.rows}))
  } else if(input.format==='csv') {
    // Prevent spreadsheet formula execution, including whitespace-prefixed formulae.
    const quote=(v:unknown)=>{let s=v===null?'':String(v);if(/^\s*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'}
    bytes=Buffer.from('\uFEFF'+grid.map(row=>row.map(quote).join(',')).join('\r\n')+'\r\n')
  } else {
    const sheetId=randomUUID()
    const col=(n:number):string=>{let s='';for(n++;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s}
    const snapshot=SpreadsheetSnapshotSchema.parse({schemaVersion:1,capabilityVersion:1,artifactId:randomUUID(),templateVersionId:randomUUID(),workspaceId,family:'spreadsheet',locale:'en-US',defaultLanguage:'en-US',rootId:randomUUID(),title:input.title,resources:[],accessibility:{title:input.title},activeSheetId:sheetId,calculationMode:'automatic',worksheets:[{id:sheetId,name:'Export',visibility:'visible',cells:grid.flatMap((row,r)=>row.map((value,c)=>({id:randomUUID(),address:`${col(c)}${r+1}`,valueType:value===null?'blank':typeof value==='number'?'number':typeof value==='boolean'?'boolean':'string',value,style:{},locked:false}))),merges:[],rowDimensions:[],columnDimensions:[],freeze:{rows:1,columns:0},images:[],validations:[],conditionalFormats:[],print:{paperSize:'A4',orientation:'landscape',fitToWidth:1,fitToHeight:0,margins:{leftIn:0.3,rightIn:0.3,topIn:0.3,bottomIn:0.3,headerIn:0,footerIn:0},horizontalCentered:false,verticalCentered:false,showGridLines:false,showHeadings:false}}]})
    const xlsx=await exportOfficeSpreadsheet(snapshot)
    bytes=input.format==='pdf'?await convertToPdfWithLibreOffice(xlsx.bytes,{inputName:'export.xlsx'}):xlsx.bytes
  }
  return {bytes,mimeType:mime[input.format],sha256:sha256(bytes),sizeBytes:bytes.length,binding:input.binding}
}
