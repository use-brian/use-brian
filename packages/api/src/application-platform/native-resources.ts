/** Fixed native field vocabulary shared by canonical entry points. [COMP:api/application-records] */
import type { ApplicationResourceDefinition } from '@use-brian/shared'
const commonCrmFields:ApplicationResourceDefinition['fields']=[
  {key:'aliases',label:'Aliases',kind:'json',shape:'array',items:'text',maxItemLength:200},
  {key:'tags',label:'Tags',kind:'json',shape:'array',items:'text',maxItems:64,maxItemLength:100},
  {key:'externalRef',label:'External reference',kind:'json',shape:'object'},
  {key:'ownerId',label:'Owner',kind:'person'},
  {key:'archivedAt',label:'Archived at',kind:'timestamp'},
  {key:'createdAt',label:'Created at',kind:'timestamp',immutable:true},
  {key:'updatedAt',label:'Updated at',kind:'timestamp',immutable:true},
]
const definitions:ApplicationResourceDefinition[]=[
  {typeKey:'company',origin:{kind:'native',moduleKey:'native'},schemaVersion:'2',fields:[
    {key:'name',label:'Name',kind:'text',required:true,maxLength:256},{key:'domain',label:'Domain',kind:'text',maxLength:320},...commonCrmFields]},
  {typeKey:'person',origin:{kind:'native',moduleKey:'native'},schemaVersion:'2',fields:[
    {key:'self',label:'Self identity',kind:'boolean',immutable:true},{key:'name',label:'Name',kind:'text',required:true,maxLength:256},{key:'email',label:'Email',kind:'text',maxLength:320},
    {key:'phone',label:'Phone',kind:'text',maxLength:100},{key:'companyId',label:'Company',kind:'reference',targetTypeKey:'company'},
    {key:'custom.organisation_name',label:'Organisation',kind:'text',maxLength:200},
    {key:'custom.position',label:'Position',kind:'text',maxLength:200},
    {key:'custom.mailing_address',label:'Mailing address',kind:'text',maxLength:600},...commonCrmFields]},
  {typeKey:'deal',origin:{kind:'native',moduleKey:'native'},schemaVersion:'2',fields:[
    {key:'name',label:'Name',kind:'text',required:true,maxLength:256},
    {key:'participants',label:'Participants',kind:'json',shape:'array',maxItems:256},
    {key:'stage',label:'Stage',kind:'enum',options:['lead','qualified','proposal','negotiation','won','lost']},
    {key:'amount',label:'Amount',kind:'decimal',scale:18},
    {key:'companyId',label:'Company',kind:'reference',targetTypeKey:'company'},
    {key:'contactId',label:'Contact',kind:'reference',targetTypeKey:'person'},
    {key:'closeDate',label:'Close date',kind:'text',maxLength:10},
    {key:'pipelineId',label:'Pipeline ID',kind:'text',maxLength:36},
    {key:'pipelineStageId',label:'Pipeline stage ID',kind:'text',maxLength:36},
    {key:'currencyCode',label:'Currency',kind:'text',maxLength:3},
    {key:'source',label:'Source',kind:'text',maxLength:100},
    {key:'winLossReason',label:'Win or loss reason',kind:'text',maxLength:2000},
    {key:'probability',label:'Probability',kind:'number',minimum:0,maximum:100},...commonCrmFields]},
  {typeKey:'task',origin:{kind:'native',moduleKey:'native'},schemaVersion:'2',fields:[
    {key:'title',label:'Title',kind:'text',required:true,maxLength:512},{key:'status',label:'Status',kind:'enum',options:['todo','in_progress','in_review','blocked','done','archived']},
    {key:'assigneeId',label:'Assignee',kind:'text',maxLength:36},{key:'executorAssistantId',label:'Assistant executor',kind:'text',maxLength:36},
    {key:'followUpMemberId',label:'Follow up member',kind:'text',maxLength:36},{key:'home',label:'Home',kind:'json',shape:'object'},
    {key:'due',label:'Due',kind:'timestamp'},{key:'tags',label:'Tags',kind:'json',shape:'array',items:'text'},
    {key:'parentId',label:'Parent',kind:'reference',targetTypeKey:'task'},{key:'externalRef',label:'External reference',kind:'json',shape:'object'},
    {key:'createdByUserId',label:'Creating user',kind:'text',maxLength:36,immutable:true},{key:'createdByAssistantId',label:'Creating assistant',kind:'text',maxLength:36,immutable:true},
    {key:'source',label:'Source',kind:'enum',options:['user','extracted'],immutable:true},{key:'sourceSessionId',label:'Source conversation',kind:'text',maxLength:36,immutable:true},
    {key:'sourceEpisodeId',label:'Source episode',kind:'text',maxLength:36,immutable:true},{key:'sourceStartMs',label:'Source offset',kind:'number',minimum:0,immutable:true},{key:'verified',label:'Verified',kind:'boolean',immutable:true},
    {key:'attributes',label:'Attributes',kind:'json',shape:'object'},{key:'createdAt',label:'Created at',kind:'timestamp',immutable:true},{key:'updatedAt',label:'Updated at',kind:'timestamp',immutable:true}]},
  {typeKey:'file',origin:{kind:'native',moduleKey:'native'},schemaVersion:'1',fields:[{key:'name',label:'Name',kind:'text'},{key:'mimeType',label:'MIME type',kind:'text'},{key:'sizeBytes',label:'Size',kind:'number'},{key:'storageRef',label:'Storage reference',kind:'text'}]},
  {typeKey:'workspace_member',origin:{kind:'native',moduleKey:'native'},schemaVersion:'1',fields:[{key:'id',label:'Member ID',kind:'text'}]},
]

/** Inert compiled descriptors only; current SQL authorizes discovery and values. */
export function canonicalNativeResourceDefinitions():ApplicationResourceDefinition[] {return structuredClone(definitions)}
