import {beforeEach,describe,expect,it,vi} from 'vitest'
import request from 'supertest'
import {fileRoutes} from '../files.js'
import {createTestApp} from './helpers.js'
import type {FileCachePreviewProjection} from '../../db/file-store.js'
import {LibreOfficeError} from '@use-brian/core'

const DOCX='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const read=vi.fn(),convert=vi.fn()
const store={get:vi.fn(),getOriginalContent:vi.fn()}
const source=(mime='image/png',content='data:image/png;base64,aW1hZ2U=',originalContent:string|null=null):FileCachePreviewProjection=>({
 file:{id:'file',sessionId:'session',fileName:mime===DOCX?'fixture.docx':'fixture.png',mimeType:mime,content,summary:null,sizeBytes:5,artifactFileId:null,artifactSegmentCount:null,sensitivity:'internal',compartments:[],projectIds:[]},
 originalContent,revision:'source-1',validForMs:30000,
})
const app=(userId:string|null='viewer',secret:string|null=null)=>createTestApp('/api/files',fileRoutes(store as never,null,null,secret,null,convert,read),userId?{userId}:undefined)
const path=(kind='preview')=>`/api/files/file/${kind}?workspaceId=workspace`
beforeEach(()=>{vi.resetAllMocks();read.mockResolvedValue(source());convert.mockResolvedValue(Buffer.from('%PDF-converted'))})

describe('[COMP:api/files-route] authenticated temporary previews',()=>{
 it.each(['preview','preview-pdf','preview-url'])('requires authentication for %s even with an old signature',async kind=>{
  const res=await request(app(null,'configured')).get(path(kind)+'&sig=retained.signature')
  expect(res.status).toBe(401);expect(res.headers['cache-control']).toBe('private, no-store');expect(read).not.toHaveBeenCalled();expect(store.get).not.toHaveBeenCalled()
 })
 it.each(['preview','preview-pdf','preview-url'])('requires a workspace for %s',async kind=>{
  expect((await request(app()).get('/api/files/file/'+kind)).status).toBe(400);expect(read).not.toHaveBeenCalled()
 })
 it.each([null,'configured'])('does not allow unsigned anonymous preview with secret %s',async secret=>{
  expect((await request(app(null,secret)).get(path())).status).toBe(401)
 })
 it('returns only an authenticated locator, not a reusable capability',async()=>{
  const res=await request(app()).get(path('preview-url'))
  expect(res.status).toBe(200);expect(res.body).toEqual({url:path(),requiresAuth:true})
  expect(read).toHaveBeenCalledWith({workspaceId:'workspace',userId:'viewer',assistantId:'viewer',assistantKind:'standard'},'file')
  expect((await request(app(null)).get(res.body.url)).status).toBe(401)
 })
 it('streams authorized image bytes after a second current projection',async()=>{
  const res=await request(app()).get(path())
  expect(res.status).toBe(200);expect(res.body.toString()).toBe('image')
  expect(res.headers['content-type']).toContain('image/png');expect(res.headers['cache-control']).toBe('private, no-store')
  expect(Number(res.headers['x-brian-media-valid-for-ms'])).toBeGreaterThan(0)
  expect(res.headers['access-control-expose-headers']).toContain('X-Brian-Media-Valid-For-Ms')
  expect(read).toHaveBeenCalledTimes(2);expect(store.get).not.toHaveBeenCalled()
 })
 it('serves JSON file bytes as content instead of URL instructions',async()=>{
  read.mockResolvedValue(source('application/json','{"url":"https://storage.example/unused"}'))
  const res=await request(app()).get(path())
  expect(res.status).toBe(200);expect(res.text).toBe('{"url":"https://storage.example/unused"}')
 })
 it.each(['preview','preview-pdf','preview-url'])('hides missing or inaccessible %s sources',async kind=>{
  read.mockResolvedValue(null);const res=await request(app()).get(path(kind));expect(res.status).toBe(404);expect(res.text).not.toContain('source-1')
 })
 it.each(['revoked','changed','expired'] as const)('refuses image delivery after the source is %s',async change=>{
  read.mockResolvedValueOnce(source()).mockResolvedValue(change==='revoked'?null:{...source(),revision:change==='changed'?'source-2':'source-1',validForMs:change==='expired'?0:30000})
  const res=await request(app()).get(path());expect(res.status).toBe(404);expect(res.text).not.toContain('image')
 })
 it('converts original bytes with a server-selected extension and rechecks afterward',async()=>{
  read.mockResolvedValue(source(DOCX,'Extracted text','data:'+DOCX+';base64,ZG9jeA=='))
  const res=await request(app()).get(path('preview-pdf'))
  expect(res.status).toBe(200);expect(res.body.toString()).toBe('%PDF-converted');expect(res.headers['content-disposition']).toBe('inline')
  expect(convert).toHaveBeenCalledWith(Buffer.from('docx'),{inputName:'attachment.docx',tempPrefix:'brian-attachment-pdf-'})
  expect(read).toHaveBeenCalledTimes(2);expect(store.getOriginalContent).not.toHaveBeenCalled()
 })
 it.each(['revoked','changed'] as const)('withholds converted PDF after %s source admission',async change=>{
  const original=source(DOCX,'Extracted text','data:'+DOCX+';base64,ZG9jeA==')
  read.mockResolvedValueOnce(original).mockResolvedValue(change==='revoked'?null:{...original,revision:'new'})
  const res=await request(app()).get(path('preview-pdf'))
  expect(convert).toHaveBeenCalledOnce();expect(res.status).toBe(404);expect(res.text).not.toContain('%PDF')
 })
 it('streams inline PDFs without conversion',async()=>{
  read.mockResolvedValue(source('application/pdf','data:application/pdf;base64,JVBERi1vcmlnaW5hbA=='))
  const res=await request(app()).get(path('preview-pdf'));expect(res.status).toBe(200);expect(res.body.toString()).toBe('%PDF-original');expect(convert).not.toHaveBeenCalled()
 })
 it('serves exact original structured-document bytes for a file download',async()=>{
  read.mockResolvedValue(source(DOCX,'Extracted text','data:'+DOCX+';base64,ZG9jeA=='))
  const res=await request(app()).get(path()).buffer(true).parse((response,done)=>{const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>chunks.push(chunk));response.on('end',()=>done(null,Buffer.concat(chunks)));});expect(res.status).toBe(200);expect(res.body.toString()).toBe('docx');expect(convert).not.toHaveBeenCalled()
 })
 it.each([['application/pdf','parsed text'],[DOCX,'Extracted text']])('refuses unavailable bytes for %s',async(mime,content)=>{
  read.mockResolvedValue(source(mime,content));const res=await request(app()).get(path('preview-pdf'));expect(res.status).toBe(404);expect(convert).not.toHaveBeenCalled()
 })
 it('refuses unsupported PDF conversion',async()=>{
  read.mockResolvedValue(source('text/plain','notes'));expect((await request(app()).get(path('preview-pdf'))).status).toBe(415)
 })
 it.each([['timeout',504],['converter_unavailable',503]] as const)('maps converter %s without returning source bytes',async(code,status)=>{
  read.mockResolvedValue(source(DOCX,'Extracted text','data:'+DOCX+';base64,ZG9jeA=='));convert.mockRejectedValue(new LibreOfficeError(code))
  const res=await request(app()).get(path('preview-pdf'));expect(res.status).toBe(status);expect(res.body.code).toBe('pdf_unavailable')
 })
})
