/** Source-free construction. Deliberately has no retrieval/template/brand ports. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { collectStream, exportOfficeDocument, reparseOfficeDocument, officeSemanticHash, type LLMProvider } from '@use-brian/core'
import { assertOfficeArtifactSnapshot, type DocumentSnapshot } from '@use-brian/office-model'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'

const Brief = z.object({workspaceId:z.string().uuid(),actingUserId:z.string().uuid(),assistantId:z.string().uuid(),
  family:z.literal('document'),outcome:z.string().min(1),audience:z.string(),sourceHandles:z.tuple([]),
  requestedSensitivityFloor:z.enum(['public','internal','confidential']),idempotencyKey:z.string()}).strict()
const Content = z.object({title:z.string().min(1).max(1000),paragraphs:z.array(z.string().min(1).max(4000)).min(1).max(30)}).strict()
export function promptOnlyBrief(job: OfficeGenerationJobRow) {
  const brief=Brief.parse(job.brief)
  if (brief.workspaceId!==job.workspaceId || brief.actingUserId!==job.initiatedByUserId || brief.assistantId!==job.assistantId) throw new Error('office_prompt_request_changed')
  return brief
}
export async function constructPromptOnlyDocument(job:OfficeGenerationJobRow,provider:LLMProvider,model:string):Promise<DocumentSnapshot> {
  const brief=promptOnlyBrief(job)
  const response=await collectStream(provider.stream({model,systemPrompt:'Draft a document only from the supplied prompt and audience. Do not fetch URLs or use external, company, brand or template context. Do not invent names, dates, amounts or commitments. Return JSON only: {"title":"...","paragraphs":["..."]}.',
    messages:[{role:'user',content:JSON.stringify({prompt:brief.outcome,audience:brief.audience})}],maxTokens:6000,responseFormat:'json',temperature:0.25}))
  const text=response.content.map(b=>b.type==='text'?b.text:'').join('').trim().replace(/^```(?:json)?\s*|\s*```$/g,'')
  const content=Content.parse(JSON.parse(text))
  const style={fontFamily:'Arial',fontSizePt:11,bold:false,italic:false,underline:false,strike:false,color:'#111111'}
  const snapshot:DocumentSnapshot={schemaVersion:1,capabilityVersion:1,artifactId:job.artifactId,workspaceId:job.workspaceId,
    family:'document',locale:'en-US',defaultLanguage:'en-US',templateVersionId:null,rootId:randomUUID(),title:content.title,resources:[],accessibility:{title:content.title},
    sections:[{id:randomUUID(),page:{widthPt:595.3,heightPt:841.9,marginTopPt:72,marginRightPt:62,marginBottomPt:68,marginLeftPt:62,orientation:'portrait'},
      header:[],footer:[],showPageNumber:false,nodes:content.paragraphs.map(text=>({id:randomUUID(),kind:'paragraph',runs:[{id:randomUUID(),text,style}],styleName:'Body',alignment:'start'}))}]}
  assertOfficeArtifactSnapshot(snapshot)
  // Native DOCX preflight/export/reopen verifies this canonical document without
  // admitting any external resources. Render compatibility is checked at boot.
  const exported=await exportOfficeDocument(snapshot)
  const reopened=await reparseOfficeDocument(exported.bytes)
  if(reopened.semanticHash!==officeSemanticHash(snapshot)) throw new Error('office_prompt_roundtrip_mismatch')
  return snapshot
}
