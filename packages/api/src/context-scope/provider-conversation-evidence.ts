import { AsyncLocalStorage } from 'node:async_hooks'
import type { AccessCeiling } from '@use-brian/agent-runtime/security/access-ceiling.js'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { resourceScopeKey, type ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { nativeSessionCurrentScopeSchema } from '../application-platform/conversation-evidence.js'
import { rlsGucSettings, runWithAgentAccess } from '../db/client.js'

type ProviderConversationOwner = Readonly<{
  workspaceId: string
  actorId: string
  sessionId: string
  assistantId: string
  address: string
  integrationId: string
  botId: string
  epoch: number
  speakerId: string
  incomingId: string
  assertCurrent: () => Promise<void>
}>

type Invocation = {
  owner: ProviderConversationOwner
  turn?: { token: string; envelopeVersion: string; settings: ReturnType<typeof rlsGucSettings> }
  live: boolean
}

const providerConversation = new AsyncLocalStorage<Invocation>()
const proofSchema = z.object({
  current: z.array(nativeSessionCurrentScopeSchema),
  immutable: z.array(nativeSessionCurrentScopeSchema),
}).strict()

export async function withProviderConversationEvidence<T>(owner: ProviderConversationOwner, run: () => Promise<T>) {
  const invocation: Invocation = { owner: Object.freeze(owner), live: true }
  try {
    return await providerConversation.run(invocation, run)
  } finally {
    invocation.live = false
  }
}

/** Only the established turn with a current record and group audience may use the adapter. */
export function bindProviderConversationTurn(execution: ExecutionContext, token: string, envelopeVersion: string) {
  const invocation = providerConversation.getStore()
  if (!invocation?.live) return
  const { owner } = invocation
  if (invocation.turn || execution.identity.kind !== 'attended' || execution.identity.principal.kind !== 'workspace_member'
    || execution.identity.principal.authenticationKind !== 'verified_channel'
    || execution.identity.principal.userId !== owner.actorId
    || execution.security.access.userId !== owner.actorId || !execution.security.access.sharedAudience
    || execution.security.access.workspaceId !== owner.workspaceId || execution.lifecycle.sessionId !== owner.sessionId
    || execution.assistant.id !== owner.assistantId || execution.lifecycle.channelType !== 'telegram'
    || execution.lifecycle.channelId !== owner.address) throw new Error('Provider conversation turn changed')
  const settings = runWithAgentAccess(execution.security.access, () => rlsGucSettings(owner.actorId, owner.assistantId))
  invocation.turn = { token, envelopeVersion, settings }
}

/** Acquire current labels through the original verified room under the same transaction as the caller.
 * Delivery still checks each returned label against its independent recipient ceiling. */
export async function captureProviderConversationEvidence(
  client: Pick<PoolClient, 'query'>, ceiling: AccessCeiling, kind: 'caller' | 'audience', roots: readonly ScopeSource[],
) {
  const invocation = providerConversation.getStore()
  if (!invocation?.live || !invocation.turn || !roots.length
    || roots.some(root => !['application_field','session_message','session_context_revision'].includes(root.resourceKind))) return null
  const { owner, turn } = invocation
  if (ceiling.workspaceId !== owner.workspaceId || (ceiling.userId !== owner.actorId && (kind !== 'audience' || ceiling.userId !== ''))) {
    return null
  }
  const actor = (await client.query<{ id: string | null }>(
    "SELECT nullif(current_setting('app.current_user_id',true),'') AS id")).rows[0]?.id
  if (actor !== owner.actorId) throw new Error('Provider conversation source actor changed')
  await owner.assertCurrent()

  const names = turn.settings.map(([name]) => name)
  const previous = (await client.query<{ settings: (string | null)[] }>(
    'SELECT ARRAY(SELECT current_setting(name,true) FROM unnest($1::text[]) name) AS settings',[names])).rows[0]!.settings
  const setScope = (values: (string | null)[]) => client.query(
    "SELECT set_config(setting.name,coalesce(setting.value,''),true) FROM unnest($1::text[],$2::text[]) AS setting(name,value)",
    [names,values])
  if (kind === 'audience' || !previous[names.indexOf('app.v2_assistant_id')]) {
    await setScope(turn.settings.map(([,value]) => value))
  }
  const identities = roots.map(root => ({kind:root.resourceKind,id:root.resourceId,version:root.version}))
  const result = await client.query<{ value: unknown }>(
    'SELECT public.capture_verified_telegram_conversation_evidence($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS value',
    [owner.workspaceId,owner.sessionId,owner.actorId,owner.assistantId,owner.address,owner.integrationId,owner.botId,owner.epoch,
      turn.envelopeVersion,turn.token,owner.speakerId,owner.incomingId,JSON.stringify(identities)])
  if (kind === 'audience' || !previous[names.indexOf('app.v2_assistant_id')]) await setScope(previous)
  if (result.rows[0]?.value === null) return null
  const { current, immutable } = proofSchema.parse(result.rows[0]?.value)
  if (current.some(source => source.workspaceId !== owner.workspaceId) || roots.some(root => !current.some(source =>
    source.resourceKind === root.resourceKind && source.resourceId === root.resourceId && source.version === root.version
    && resourceScopeKey(source) === resourceScopeKey(root)))) throw new Error('Provider conversation source changed')
  await owner.assertCurrent()
  return {
    kind: 'complete' as const,
    current,
    evidence: new ContextScopeAccumulator({sources:[...roots,...immutable]}).evidence,
  }
}
