/** [COMP:api/delivery-authority] Current recipients for a verified Telegram room. */
import type {PoolClient} from 'pg'
import {z} from 'zod'
import {accessCeilingContains, type AccessCeiling} from '@use-brian/agent-runtime/security/access-ceiling.js'
import {DerivedScopeError,resourceScopeKey, type ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {nativeSessionCurrentScopeSchema} from '../application-platform/conversation-evidence.js'
import {resolveGroupAudienceSystem, type DeliveryAudienceInput} from './delivery-authority.js'
import {hasVerifiedTelegramGroupEvidence} from './native-invocation-evidence.js'

/** Captured by the signed ingress and the running turn owner. */
export type TelegramKnowledgeGroup = Readonly<{
  sessionId: string
  address: string
  integrationId: string
  botId: string
  generation: number
  envelopeVersion: string
  lease: string
  speakerId: string
  incomingId: string
}>

const source = nativeSessionCurrentScopeSchema.extend({resourceKind: z.enum(['application_field','knowledge_entry'])}).strict()
const proof = z.object({current: z.array(source).max(4096), immutable: z.array(source).max(4096)}).strict()
const queryFloor = z.object({floor:source.omit({resourceKind:true,resourceId:true,version:true}).extend({userId:z.null(),assistantId:z.null()})}).strict()
const verified = new WeakMap<ExecutionContext,TelegramKnowledgeGroup>()
const knowledgeUsed = new WeakSet<ExecutionContext>()

export function bindTelegramKnowledgeGroup(execution: ExecutionContext, group: TelegramKnowledgeGroup): void {
  if (verified.has(execution) || !hasVerifiedTelegramGroupEvidence(execution)
    || execution.lifecycle.sessionId !== group.sessionId || execution.lifecycle.channelId !== group.address) throw new DerivedScopeError('scope_source_changed')
  verified.set(execution,Object.freeze({...group}))
}

export function telegramKnowledgeGroup(execution: ExecutionContext): TelegramKnowledgeGroup|undefined {
  return hasVerifiedTelegramGroupEvidence(execution) ? verified.get(execution) : undefined
}

export function noteTelegramKnowledgeUse(execution:ExecutionContext):void {
  if (telegramKnowledgeGroup(execution)) knowledgeUsed.add(execution)
}

export function telegramKnowledgeUsed(execution:ExecutionContext):boolean {
  return knowledgeUsed.has(execution)
}

type GroupActor = Pick<DeliveryAudienceInput,'workspaceId'|'userId'|'assistantId'>
async function readGroupEvidence(client:Pick<PoolClient,'query'>, input:GroupActor, group:TelegramKnowledgeGroup, identities:unknown) {
  return (await client.query<{value:unknown}>(`SELECT public.capture_verified_telegram_knowledge_evidence(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS value`,
    [input.workspaceId, group.sessionId, input.userId, input.assistantId, group.address, group.integrationId,
      group.botId, group.generation, group.envelopeVersion, group.lease, group.speakerId, group.incomingId,
      identities===null?null:JSON.stringify(identities)])).rows[0]?.value
}

/** The recorded room and live group binding each cap corpus selection before text matching. */
export async function readTelegramKnowledgeQueryFloor(client:Pick<PoolClient,'query'>, execution:ExecutionContext) {
  const group = telegramKnowledgeGroup(execution)
  if (!group) return undefined
  const {workspaceId,userId} = execution.security.access
  const packet = queryFloor.safeParse(await readGroupEvidence(client,{workspaceId,userId,assistantId:execution.assistant.id},group,null))
  if (!packet.success || packet.data.floor.workspaceId!==workspaceId) throw new DerivedScopeError('scope_source_changed')
  return packet.data.floor
}

/** Require the live approved binding. An unbound audience also has an empty user ID. */
export async function telegramKnowledgeBindingCurrent(input: DeliveryAudienceInput, group: TelegramKnowledgeGroup, original: AccessCeiling) {
  const current = await resolveGroupAudienceSystem({...input, channelId: group.address})
  return current.allowed && current.source === 'binding' && current.ceiling.userId === ''
    && accessCeilingContains(current.ceiling, original)
}

/** The room authority proves exact field and native row receipts without taking ownership of them. */
export async function readTelegramKnowledgeAudienceProof(
  client: Pick<PoolClient,'query'>, input: DeliveryAudienceInput, group: TelegramKnowledgeGroup, roots: readonly ScopeSource[],
): Promise<boolean> {
  if (roots.length > 4096 || roots.some(root => root.workspaceId !== input.workspaceId || root.userId !== null || root.assistantId !== null)) return false
  const identities = roots.map(root => ({kind: root.resourceKind, id: root.resourceId, version: root.version}))
  const value = await readGroupEvidence(client,input,group,identities)
  if (value == null) return false
  const checked = proof.parse(value)
  const key = (value: ScopeSource) => JSON.stringify([value.resourceKind,value.resourceId,value.version,resourceScopeKey(value)])
  const original = new Set(roots.map(key))
  const current = new Set(checked.current.map(key))
  const fields = new Set(roots.filter(value => value.resourceKind === 'application_field').map(key))
  const immutable = new Set(checked.immutable.map(key))
  return current.size === original.size && [...original].every(value => current.has(value))
    && immutable.size === fields.size && [...fields].every(value => immutable.has(value))
}
