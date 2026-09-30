import JSZip from 'jszip'
import { DocumentError } from './service.js'
/** Format validation complements, and never replaces, the configured malware scanner. */
export async function verifyUploadFormat(bytes:Uint8Array,mime:string):Promise<void> {
 const b=Buffer.from(bytes)
 const bad=()=>{throw new DocumentError('document_media_type_mismatch',422)}
 if(mime==='application/pdf'){if(b.subarray(0,5).toString()!=='%PDF-')bad();return}
 if(mime==='image/png'){if(!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))bad();return}
 if(mime==='image/jpeg'){if(b.length<4||b[0]!==255||b[1]!==216||b[b.length-2]!==255||b[b.length-1]!==217)bad();return}
 if(mime.includes('officedocument')){
  let zip:JSZip;try{zip=await JSZip.loadAsync(b)}catch{return bad()}
  const files=Object.keys(zip.files)
  if(files.length>10000||files.some(name=>/vbaproject|activex|\.exe$/i.test(name))||!zip.file('[Content_Types].xml'))bad()
  if(!zip.file(mime.includes('wordprocessingml')?'word/document.xml':'xl/workbook.xml'))bad()
  return
 }
 try{const text=new TextDecoder('utf-8',{fatal:true}).decode(b);if(text.includes('\0'))bad();if(mime==='application/json')JSON.parse(text)}catch{return bad()}
}
