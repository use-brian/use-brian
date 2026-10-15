import { describe, expect, it } from 'vitest'
import { assessDelivery, classifyDeliveryRecognition, DeliveryCommandSchema, deliveryQuoteMatches, deliveryObservationSupported,
  type DeliveryCommitment, type DeliveryObservation, type DeliveryProposal, type DeliverySource } from '../delivery-oversight.js'
const id = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const quote = 'Agreed: deliver the accepted report on 2026-10-20.'
const ref = { kind: 'session_message' as const, id, revision: '1', quote, start: 0, end: quote.length }
const source: DeliverySource = { ...ref, workspaceId: id, text: quote, authorUserId: id, role: 'human',
  occurredAt: '2026-10-15T00:00:00Z', readAt: '2026-10-15T01:00:00Z', archive: false, governedAccepted: false,
  userId: id, assistantId: null, sensitivity: 'internal', compartments: [], projectIds: [], originChatId: id }
const proposal: DeliveryProposal = { candidateKey: 'report', source: ref, outcome: 'Deliver accepted report',
  dueDate: '2026-10-20', companyId: id, dealId: null, taskIds: [], goalIds: [], basis: 'explicit_agreement', agreeingUserId: id }
const commitment: DeliveryCommitment = { id,workspaceId:id,...proposal, agreeingUserId:id,recognitionState:'recognised',recognitionReason:'authenticated',
 version:1,originChatId:id,createdAt:source.occurredAt,updatedAt:source.occurredAt }
function observation(overrides: Partial<DeliveryObservation> = {}): DeliveryObservation {
 return { id,commitmentId:id,source:ref,kind:'human_report',claim:'progress',statement:'Report drafted',workId:null,
 reporterUserId:id,occurredAt:source.occurredAt,readAt:source.readAt,...overrides }
}
describe('[COMP:crm/delivery-oversight] evidence policy', () => {
 it('CO01/CO02 recognises an authenticated existing agreement without creating or requiring work', () => {
  expect(classifyDeliveryRecognition(proposal,source)).toMatchObject({state:'recognised',agreeingUserId:id})
  expect(proposal.taskIds).toEqual([])
 })
 it.each(['assistant','unknown','document'] as const)('CO02 keeps %s provenance in review', role => {
  expect(classifyDeliveryRecognition(proposal,{...source,role})).toMatchObject({state:'needs_review'})
 })
 it('CO02 refuses spoofed actors, absent acceptance and unresolved clients', () => {
  for (const change of [{agreeingUserId:other},{basis:'ambiguous' as const},{companyId:null}]) {
   expect(classifyDeliveryRecognition({...proposal,...change},source).state).toBe('needs_review')
  }
  for(const text of ['We should deliver a report.','Maybe I agree.','Draft: Agreed to deliver.','“Agreed to deliver,” they said.']) {
   const r={...ref,quote:text,end:text.length}
   expect(classifyDeliveryRecognition({...proposal,source:r},{...source,...r,text}).state).toBe('needs_review')
  }
 })
 it('CO02/CO09 binds exact quote selectors and revision', () => {
  expect(deliveryQuoteMatches({...ref,start:1},source)).toBe(false)
  expect(deliveryQuoteMatches({...ref,revision:'2'},source)).toBe(false)
 })
 it('CO03 due dates, absent updates and a gap do not diagnose failure or recommend work', () => {
  const value=assessDelivery({...commitment,dueDate:'2000-01-01'},[observation({kind:'coverage_gap',claim:'unknown'})],source.readAt)
  expect(value).toMatchObject({coverage:'unobserved',outcome:'unknown',issue:null,nextAction:null,lastKnownAt:null})
 })
 it('CO04 preserves attributable, dated reported completion', () => {
  expect(assessDelivery(commitment,[observation({claim:'completed'})],source.readAt)).toMatchObject({coverage:'reported',outcome:'reported_completion',lastKnownAt:source.occurredAt})
 })
 it('CO04 verified delivery requires actual outcome evidence', () => {
  expect(assessDelivery(commitment,[observation({kind:'observed_fact',claim:'progress'})],source.readAt).outcome).toBe('unknown')
  expect(assessDelivery(commitment,[observation({kind:'observed_fact',claim:'outcome_delivered'})],source.readAt).outcome).toBe('verified_delivery')
 })
 it('CO05 narrow reported issue permits only one linked inspect action', () => {
  const value=assessDelivery(commitment,[observation({claim:'delay',workId:other}),observation({id:other,claim:'blocker',workId:id})],source.readAt,true)
  expect(value.issue).toMatchObject({kind:'delay',reported:true,occurredAt:source.occurredAt})
  expect(value.nextAction).toEqual({kind:'inspect_work',workId:other,observationId:id})
  expect(value.outcome).toBe('unknown')
 })
 it('CO05 conflicts and candidate recognition suppress persuasive outcome/advice', () => {
  const evidence=[observation({claim:'delay'}),observation({kind:'conflict',claim:'unknown'})]
  expect(assessDelivery(commitment,evidence,source.readAt)).toMatchObject({coverage:'conflicting',outcome:'unknown',issue:null,nextAction:null})
  expect(assessDelivery({...commitment,recognitionState:'needs_review'},[observation({claim:'delay',workId:id})],source.readAt)).toMatchObject({issue:null,nextAction:null})
 })
 it('CO06 bounds evidence at 20 and discloses incomplete outcome coverage', () => {
  const evidence=Array.from({length:21},()=>observation({kind:'observed_fact',claim:'outcome_delivered'}))
  expect(assessDelivery(commitment,evidence,source.readAt)).toMatchObject({partial:true,outcome:'unknown'})
 })
 it('CO07 commands reject actors, clearance, verified flags and recipients', () => {
  const command={kind:'record_delivery_recognition',operationId:id,proposal}
  for(const field of ['actor','clearance','recipient','verifiedDelivery']) expect(DeliveryCommandSchema.safeParse({...command,[field]:id}).success).toBe(false)
 })
 it('CO03/CO05 dates and absent updates cannot be relabelled as supported delay',()=>{
  expect(deliveryObservationSupported({source:ref,kind:'human_report',claim:'delay',statement:quote,workId:null},source)).toBe(false)
  expect(deliveryObservationSupported({source:ref,kind:'observed_fact',claim:'outcome_delivered',statement:quote,workId:null},{...source,role:'governed',governedAccepted:true})).toBe(false)
  expect(deliveryObservationSupported({source:ref,kind:'human_report',claim:'blocker',statement:'Invented blocker',workId:null},source)).toBe(false)
 })
 it('CO04/CO05 newer outcome evidence supersedes dated issues and newer issues withhold old completion',()=>{
  const old=observation({claim:'blocker',workId:other}),newer=observation({id:other,claim:'completed',occurredAt:'2026-10-16T00:00:00Z'})
  expect(assessDelivery(commitment,[old,newer],newer.readAt)).toMatchObject({outcome:'reported_completion',issue:null,nextAction:null})
  expect(assessDelivery(commitment,[{...old,occurredAt:'2026-10-17T00:00:00Z'},newer],newer.readAt)).toMatchObject({outcome:'unknown',issue:{kind:'blocker'}})
  expect(assessDelivery(commitment,[old,{...newer,occurredAt:old.occurredAt}],source.readAt)).toMatchObject({coverage:'conflicting',issue:null,outcome:'unknown'})
 })
 it('CO04 unrelated outcome evidence cannot verify this commitment',()=>{
  const text='The unrelated package was delivered.',r={...ref,quote:text,end:text.length}
  expect(deliveryObservationSupported({source:r,kind:'observed_fact',claim:'outcome_delivered',statement:text,workId:null},{...source,...r,text,role:'document'},commitment.outcome)).toBe(false)
 })
 it('CO10 archive descendants cannot match agreement evidence', () => {
  expect(deliveryQuoteMatches(ref,{...source,archive:true})).toBe(false)
  expect(classifyDeliveryRecognition(proposal,{...source,archive:true}).state).toBe('needs_review')
 })
})

import { vi } from 'vitest'
import { homeAppToolRequirements } from '@use-brian/shared'
import { createCrmDeliveryOversightTools } from '../delivery-oversight-tools.js'
import type { ToolContext } from '../../tools/types.js'
describe('[COMP:crm/delivery-oversight] Brian adapter parity',()=>{
 function setup(){
  const reads={list:vi.fn(async()=>({commitments:[],nextCursor:null})),get:vi.fn(async()=>null),locateChatSource:vi.fn(async()=>ref)}
  const service={execute:vi.fn(async()=>({command:'record_delivery_recognition' as const,record:{id,version:1},created:true,duplicate:false,emittedEventIds:[]}))}
  const tools=createCrmDeliveryOversightTools({reads,service})
  const context={workspaceId:id,userId:id,assistantId:other,sessionId:id,appId:'fixture',channelType:'web',channelId:'fixture',abortSignal:new AbortController().signal,userMessageText:quote,
   activeCapabilities:new Set(['crm',...Object.values(tools).flatMap(homeAppToolRequirements)])} as ToolContext
  return {reads,service,tools,context}
 }
 it('CO12 direct invocation and discovery share the CRM capability gate',async()=>{
  const f=setup()
  expect((await f.tools.listCrmDeliveryCommitments.execute({}, {...f.context,activeCapabilities:new Set()})).isError).toBe(true)
  expect(f.reads.list).not.toHaveBeenCalled()
  await f.tools.listCrmDeliveryCommitments.execute({scope:'personal'},f.context)
  expect(f.reads.list).toHaveBeenCalledWith({userId:id,chatId:id},id,expect.objectContaining({limit:50,scope:'personal'}))
 })
 it('CO02/CO12 attended current input resolves native source, never a fabricated Episode',async()=>{
  const f=setup(),{source:ignored,...candidate}=proposal
  await f.tools.recordCrmDeliveryRecognition.execute({operationId:id,proposal:candidate,quote},f.context)
  expect(f.reads.locateChatSource).toHaveBeenCalledWith({userId:id,chatId:id},id,id,quote,quote)
  expect(f.service.execute).toHaveBeenCalledWith(expect.objectContaining({actor:{kind:'assistant',assistantId:other,userId:id,sessionId:id}}),
   {kind:'record_delivery_recognition',operationId:id,proposal})
 })
 it('CO07/CO12 recognition review uses exact attended approval metadata without converting the assistant into a human',async()=>{
  const f=setup(),input={operationId:id,commitmentId:id,expectedVersion:1,decision:'dismiss',reason:'Existing evidence review'}
  expect(f.tools.reviewCrmDeliveryRecognition).toMatchObject({requiresConfirmation:true,confirmationMode:'durable_attended',allowPersistentApproval:false})
  await f.tools.reviewCrmDeliveryRecognition.execute(input,{...f.context,approvedToolInvocation:{approvalId:id,approverUserId:id,toolName:'reviewCrmDeliveryRecognition'}})
  expect(f.service.execute).toHaveBeenCalledWith(expect.objectContaining({actor:{kind:'assistant',assistantId:other,userId:id,sessionId:id},authority:expect.objectContaining({deliveryReviewApproval:{approvalId:id,approverUserId:id,toolName:'reviewCrmDeliveryRecognition'}})}),{...input,kind:'review_delivery_recognition'})
 })
})
