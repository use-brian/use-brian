import {randomUUID} from 'node:crypto'
import {beforeEach,describe,it,expect,vi} from 'vitest'
import JSZip from 'jszip'
import {feedParagraph,projectFeedLinkedIn} from '@use-brian/doc-model'
import type {StructuredFeedContent} from '../../db/feed-collaboration-store.js'
import type {FilesApi} from '@use-brian/core'
const state=vi.hoisted(()=>({content:null as unknown,revision:3,authorized:true,release:3,receipt:null as unknown,query:vi.fn()}))
vi.mock('../../db/feed-collaboration-store.js',async()=>{const actual=await vi.importActual<typeof import('../../db/feed-collaboration-store.js')>('../../db/feed-collaboration-store.js');return {...actual,withFeedTransaction:async(_actor:unknown,fn:Function)=>fn({query:state.query},{workspaceId:'fixture',memberClearance:'internal',memberCompartments:[]}),readFeedCopy:async()=>({content:state.content,revision:state.revision}),assertFeedFiles:vi.fn(async()=>{if(!state.authorized)throw new Error('file_unavailable')})}})
vi.mock('../confirmation.js',()=>({readFeedConfirmation:async()=>({id:'confirmation',revision:3,content:state.content}),isFeedConfirmationRevoked:async()=>false}))
vi.mock('../../db/decision-event-store.js',()=>({appendDecisionEvent:vi.fn(async()=>({inserted:true}))}))
vi.mock('../../brain-stream/notify.js',()=>({notifyWorkspaceChange:vi.fn()}))
import {exportFeedArticle} from '../projection.js'
import {completeLinkedInManual,linkedInPublishedUrl} from '../linkedin-newsletter.js'
const actor={userId:randomUUID(),assistantId:randomUUID(),sessionId:randomUUID(),kind:'user' as const}
function content():StructuredFeedContent{return {schemaVersion:2,title:'Edition',text:'',privateBrief:'PRIVATE',postFormat:'article',threadSegments:[],media:[],article:{sourceUrl:'',title:'',description:''},linkedin:{version:1,mode:'newsletter_edition',destinationId:null,authorKind:'organization',authorDisplay:'Orchard fixture',newsletter:{name:'Field notes',url:'https://www.linkedin.com/newsletters/123',editionTitle:'Edition one',coverCaption:'Cover'}},composition:{version:1,segments:[{id:randomUUID(),content:[feedParagraph('Long story '.repeat(500)),feedParagraph('<script>alert("x")</script>')]}]}}}
beforeEach(()=>{state.content=content();state.revision=3;state.authorized=true;state.release=3;state.receipt=null;state.query.mockReset();state.query.mockImplementation(async(sql:string,params:unknown[])=>{if(sql.includes('SELECT public_release'))return {rows:[{public_release:{revision:state.release,audience:'public'}}]};if(sql.startsWith('SELECT receipt'))return {rows:state.receipt?[{receipt:state.receipt}]:[]};if(sql.startsWith('INSERT INTO feed_linkedin_manual_receipts'))state.receipt=JSON.parse(params[7] as string);return {rows:[]}})})
describe('[COMP:feed/linkedin-newsletter] manual edition preparation and receipt',()=>{
 it('accepts a long text-only edition, safely exports deterministic files, and never marks it posted',async()=>{
  const value=state.content as StructuredFeedContent;expect(projectFeedLinkedIn(value.composition,value.linkedin,value).blockers).toEqual([])
  const bytes=await exportFeedArticle(actor,3,false);expect(bytes.equals(await exportFeedArticle(actor,3,false))).toBe(true)
  const zip=await JSZip.loadAsync(bytes);const html=await zip.file('article.html')!.async('string'),text=await zip.file('article.txt')!.async('string')
  expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('PRIVATE');expect(text.length).toBeGreaterThan(3000)
  const manifest=JSON.parse(await zip.file('manifest.json')!.async('string'));expect(manifest.author.kind).toBe('organization');expect(manifest.title).toBe('Edition one');expect(state.receipt).toBeNull();expect(state.query.mock.calls.some(([sql])=>String(sql).includes("status='posted'"))).toBe(false)
 })
 it('preserves cover and inline order with local paths and authorizes every source',async()=>{
  const value=state.content as StructuredFeedContent,cover=randomUUID(),first=randomUUID(),second=randomUUID();value.linkedin!.newsletter!.coverFileId=cover
  for(const fileId of [first,second])value.composition.segments[0]!.content.push({type:'image',attrs:{id:randomUUID(),fileId,mimeType:'image/png',alt:'Orchard "map"',placement:'inline'}})
  const files={readBytes:vi.fn(async(_context:unknown,id:string)=>({ok:true,value:{bytes:Buffer.from('fixture image'),file:{id,mime:'image/png'}}}))} as unknown as FilesApi
  const zip=await JSZip.loadAsync(await exportFeedArticle(actor,3,false,files)),manifest=JSON.parse(await zip.file('manifest.json')!.async('string'))
  expect(manifest.assets.map((a:any)=>a.fileId)).toEqual([cover,first,second]);expect(manifest.assets[1].alt).toBe('Orchard "map"');expect(manifest.assets[1].blockId).toBeTruthy();expect(zip.file(`assets/${cover}.png`)).toBeTruthy()
  const html=await zip.file('article.html')!.async('string');expect(html).toContain(`assets/${first}.png`);expect(html).not.toMatch(/https:|data:|javascript:/)
  state.authorized=false;await expect(exportFeedArticle(actor,3,false,files)).rejects.toThrow('file_unavailable')
 })
 it('refuses unresolved slots even when an omission acknowledgement is supplied',async()=>{const value=state.content as StructuredFeedContent;value.composition.segments[0]!.content.push({type:'generationPlaceholder',attrs:{id:randomUUID(),kind:'text',brief:'PRIVATE SLOT',briefRevision:0,references:[]}});await expect(exportFeedArticle(actor,3,true)).rejects.toMatchObject({code:'newsletter_not_ready'})})
 it('requires revision, public release and an actual edition URL; repeated completion is idempotent',async()=>{
  const input={mutationId:randomUUID(),expectedRevision:3,confirmationId:randomUUID(),url:'https://www.linkedin.com/pulse/orchard-edition/?tracking=removed'}
  await expect(completeLinkedInManual(actor,{...input,expectedRevision:2})).rejects.toMatchObject({code:'revision_conflict'})
  state.release=2;await expect(completeLinkedInManual(actor,input)).rejects.toMatchObject({code:'public_release_required'});state.release=3
  for(const url of ['https://example.com/pulse/story','https://www.linkedin.com/newsletters/123','https://www.linkedin.com.evil.example/pulse/story','javascript:alert(1)'])await expect(completeLinkedInManual(actor,{...input,url})).rejects.toThrow()
  const receipt=await completeLinkedInManual(actor,input);expect(receipt.verification).toBe('operator_confirmed');expect(receipt.url).toBe('https://www.linkedin.com/pulse/orchard-edition/');expect(receipt.author).toEqual((state.content as StructuredFeedContent).linkedin)
  expect(await completeLinkedInManual(actor,{...input,mutationId:randomUUID()})).toEqual(receipt)
  await expect(completeLinkedInManual(actor,{...input,url:'https://www.linkedin.com/pulse/another'})).rejects.toMatchObject({code:'manual_receipt_conflict'})
 })
 it('accepts only HTTPS LinkedIn observed-post URLs without credentials or foreign ports',()=>{expect(linkedInPublishedUrl('https://www.linkedin.com/feed/update/urn:li:share:123/')).toContain('urn:li:share:123');for(const value of ['http://www.linkedin.com/pulse/story','https://user@www.linkedin.com/pulse/story','https://www.linkedin.com:444/pulse/story'])expect(()=>linkedInPublishedUrl(value)).toThrow()})
})
