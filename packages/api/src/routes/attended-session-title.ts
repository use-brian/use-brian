import { hasWorkspaceMcpRetainedAuthority } from '../db/session-context-revisions.js'
/** Admitted native title model and publication. [COMP:api/application-persistence] */
import {sanitizeTitle} from '@use-brian/core/doc/auto-title.js'
import type {SessionContextAuthority} from '@use-brian/core/memory/session-state-types.js'
import type {LLMProvider, Message, TokenUsage} from '@use-brian/agent-runtime/providers/types.js'
import {DerivedScopeError} from '@use-brian/agent-runtime/security/derived-scope.js'
import {executionToolContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {bindScopeSources, boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {getAppPool,getPool,rlsGucSettings,runWithAgentAccess} from '../db/client.js'
import {z} from 'zod'
import type {AuthTokenClaims} from '../db/auth-session-store.js'
import {parseConversationRecord} from '../db/conversation-record.js'
import {readAdmittedSessionQuery} from '../db/conversation-store.js'
import {publishSessionTitle,readSessionTitle,sessionTitleHead} from '../db/session-title-store.js'
import {admitModelInput,admitModelOutput} from '../context-scope/admission.js'

function extractPlainText(content:unknown):string {
 if(typeof content==='string')return content
 if(!Array.isArray(content))return ''
 return content.flatMap(block=>typeof block==='object'&&block!==null&&block.type==='text'&&typeof block.text==='string'?[block.text]:[]).join('')
}

export type GenerateTitleResult = { title: string | null; usage: TokenUsage | null; model: string | null }

export async function generateTitle(provider: LLMProvider, messages: readonly {role:Message['role'];content:unknown}[], model: string, assertInputAuthority: () => Promise<void>, formatTitle:(title:string)=>string=title=>title): Promise<GenerateTitleResult> {
  await assertInputAuthority()
  const filteredMessages = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, text: extractPlainText(m.content) }))
    .filter((m) => m.text.trim().length > 0)

  const excerpt = filteredMessages
    .slice(0, 6)
    .map((m) => `${m.role}: ${m.text.slice(0, 200)}`)
    .join('\n')

  // Return `title: null` on the fallback paths so callers can choose to
  // keep the existing placeholder rather than overwrite it with the
  // generic "New Chat". Especially load-bearing for sessions whose host
  // gave them a context-carrying placeholder (e.g. a bracketed channel
  // prefix) that "New Chat" would erase — see the auto-title call site.
  if (!excerpt) return { title: null, usage: null, model: null }

  let rawTitle = ''
  let carriesToolUse = false
  let usage: TokenUsage | null = null
  let servedModel = model
  await assertInputAuthority()
  for await (const chunk of provider.stream({
    model,
    systemPrompt:
      'Summarize this conversation into a short descriptive title (3-6 words). The title should capture the specific topic being discussed. Output ONLY the title text — no markdown, quotes, or punctuation.\n\nRules:\n- Always 3-6 words\n- Rephrase questions into topic form (e.g. "what do you think about oil prices" → "Oil Price Analysis Today")\n- Include the specific subject, not just the category\n\nExamples:\nuser: what do you think about oil price today? → Oil Price Analysis Today\nuser: help me plan a trip to Japan → Planning a Trip to Japan\nuser: tell me about the latest crypto news → Latest Crypto Market News',
    messages: [{ role: 'user', content: excerpt }],
    maxTokens: 32,
    temperature: 0.2,
  })) {
    if (chunk.type === 'tool_use_start' || chunk.type === 'message_end' && chunk.stopReason === 'tool_use') carriesToolUse = true
    if (chunk.type === 'text_delta') rawTitle += chunk.text
    if (chunk.type === 'message_start') servedModel = chunk.model
    if (chunk.type === 'message_end') usage = chunk.usage
  }

  await assertInputAuthority()
  if (carriesToolUse) return { title: null, usage, model: servedModel }
  const cleaned = sanitizeTitle(rawTitle)
  // If the model returned fewer than 3 words, derive a title from the first
  // user message instead — let sanitizeTitle handle the length cap (48 chars)
  // so we don't awkwardly truncate mid-phrase.
  if (cleaned.split(/\s+/).length < 3) {
    const firstUserText = filteredMessages.find((m) => m.role === 'user')?.text ?? ''
    const fallback = sanitizeTitle(firstUserText)
    if (fallback.split(/\s+/).length >= 2) {
      return { title: formatTitle(fallback.charAt(0).toUpperCase() + fallback.slice(1)), usage, model: servedModel }
    }
  }
  return {
    title: cleaned.length > 0 ? formatTitle(cleaned) : null,
    usage,
    model: servedModel,
  }
}

const recordTitleSeed=z.object({sessionId:z.string().uuid(),workspaceId:z.string().uuid(),headId:z.string().uuid().nullable(),
 previous:z.object({title:z.string(),manual:z.boolean()}).strict().nullable(),turnCount:z.number().int().nonnegative(),
 throughSequence:z.number().int().nonnegative().nullable(),record:z.unknown()}).strict()
const recordTitleResult=z.object({title:z.string(),titleRevisionId:z.string().uuid()}).strict()

/** Title work begins after commit. Its SQL receipt is bound to the current
 * credential, assistant and head, and remains independent of the turn pin. */
export async function prepareAttendedRecordTitle(authority:SessionContextAuthority,claims:Readonly<AuthTokenClaims>|null){
 const {execution}=authority,{assistant,identity}=execution,sessionId=execution.lifecycle.sessionId
 const userId=execution.security.access.userId
 if(!claims?.sessionId||claims.authVersion===undefined||claims.userId!==userId||!sessionId
  ||identity.kind!=='attended'||identity.principal.kind!=='workspace_member'||identity.principal.authenticationKind!=='native_session'
  ||identity.principal.userId!==userId||execution.surface.readOnly)throw new DerivedScopeError('scope_evidence_missing')
 const original=[sessionId,claims.sessionId,claims.authVersion,assistant.id] as const
 const query=async (expression:string,values:readonly unknown[])=>runWithAgentAccess(execution.security.access,async()=>{
  const settings=rlsGucSettings(userId,assistant.id),offset=values.length
  const {rows}=await getAppPool().query<{value:unknown}>(`WITH settings AS MATERIALIZED (
   SELECT count(set_config(setting.name,setting.value,true)) FROM unnest($${offset+1}::text[],$${offset+2}::text[]) setting(name,value)
  ) SELECT ${expression} AS value FROM settings`,[...values,settings.map(([name])=>name),settings.map(([,value])=>value)])
  if(rows.length!==1)throw new Error('conversation_title_unavailable')
  return rows[0].value
 })
 const seed=recordTitleSeed.parse(await query('public.prepare_native_conversation_title($1,$2,$3,$4)',original))
 if(seed.sessionId!==sessionId||seed.workspaceId!==execution.security.access.workspaceId)throw new DerivedScopeError('scope_source_changed')
 const record=seed.throughSequence===null?null:parseConversationRecord(seed.record,{workspaceId:seed.workspaceId,sessionId,
  afterSequence:0,throughSequence:seed.throughSequence,topicThroughSequence:0})
 return Object.freeze({
  previous:seed.previous,turnCount:seed.turnCount,
  async generate(provider:LLMProvider,model:string,channelPrefix?:(title:string|null|undefined)=>string|null){
   if(!record||seed.previous?.manual)return {title:null,usage:null,model:null,written:false}
   const capture=[...original,record.source.resourceId,seed.headId]
   const assertInput=async()=>{
    if(await query('public.check_native_conversation_title($1,$2,$3,$4,$5,$6)',capture)!==true)
     throw new DerivedScopeError('scope_source_changed')
   }
   const generated=await generateTitle(provider,record.rows.map(row=>({role:row.role as Message['role'],content:row.content})),model,assertInput,value=>{
    const prefix=channelPrefix?.(seed.previous?.title)
    return prefix&&!value.startsWith('[')?prefix+' '+value:value
   })
   if(generated.title===null)return {...generated,written:false}
   const written=await query('public.publish_native_conversation_title($1,$2,$3,$4,$5,$6,$7)',[...capture,generated.title])
   if(written===null)return {...generated,title:null,written:false}
   const published=recordTitleResult.parse(written)
   const current=await query('public.read_native_conversation_title_result($1,$2,$3,$4,$5)',[...original,published.titleRevisionId])
   if(current===null)return {...generated,title:null,written:false}
   const final=recordTitleResult.parse(current)
   if(final.titleRevisionId!==published.titleRevisionId||final.title!==published.title)throw new DerivedScopeError('scope_source_changed')
   return {...generated,title:final.title,written:true}
  },
 })
}

/** Native selection is defined by original sequence keys, never held text or a caller allow flag. */
export async function generateAttendedSessionTitle(input:{authority:SessionContextAuthority;provider:LLMProvider;model:string;
 channelPrefix?:(title:string|null|undefined)=>string|null}):Promise<GenerateTitleResult&{written:boolean}>{
 const {authority,provider,model,channelPrefix}=input,{execution}=authority,sessionId=execution.lifecycle.sessionId
 if(!sessionId||execution.lifecycle.sessionPersisted===false||execution.surface.readOnly||execution.ownership.kind!=='workspace'
  ||!hasWorkspaceMcpRetainedAuthority(execution)&&(execution.identity.kind!=='attended'||execution.identity.principal.kind!=='workspace_member'
  ||execution.identity.principal.userId!==execution.security.access.userId))throw new DerivedScopeError('scope_evidence_missing')
 await execution.security.authority.assertCurrent()
 const expectedRevision=await sessionTitleHead(sessionId,authority),previous=await readSessionTitle(sessionId,authority)
 if(previous?.manual)return{title:null,usage:null,model:null,written:false}
 // Metadata only fixes the first ten physical sequence keys. The actual
 // non-owner field/query projection admits the whole selected cohort below.
 const through=(await getPool().query<{sequence:number}>(`SELECT coalesce(max(sequence_num),0)::int AS sequence FROM
  (SELECT sequence_num FROM session_messages WHERE workspace_id=$1 AND session_id=$2 ORDER BY sequence_num LIMIT 10) original`,
  [execution.security.access.workspaceId,sessionId])).rows[0].sequence
 const query=await readAdmittedSessionQuery({sessionId,throughSequence:through,topicThroughSequence:0,authority})
 const context={...executionToolContext(execution,{appId:'native-session-title'}),scopeAccumulator:authority.accumulator}
 const assertInput=()=>admitModelInput(context)
 // Copy original values without text predicates. The generator's first
 // guard precedes extraction; its post-provider guard also owns synchronous
 // sanitization and prefix formatting, with no intervening await.
 const messages=query.history.map(row=>({role:row.role as Message['role'],content:row.content}))
 bindScopeSources(messages,boundScopeSources(query))
 const generated=await generateTitle(provider,messages,model,assertInput,value=>{
  const prefix=channelPrefix?.(previous?.title)
  return prefix&&!value.startsWith('[')?prefix+' '+value:value
 })
 if(generated.title===null)return{...generated,written:false}
 const title=generated.title
 const published=await publishSessionTitle({sessionId,title,manual:false,expectedRevision,authority,
  derivation:{producer:'turn:session-title',sources:authority.accumulator.evidence.sources??[]}})
 if(!published)return{...generated,title:null,written:false}
 authority.accumulator.note({sources:boundScopeSources(published)})
 await admitModelOutput(context)
 return bindScopeSources({...generated,title:published.title,written:true},boundScopeSources(published))
}
