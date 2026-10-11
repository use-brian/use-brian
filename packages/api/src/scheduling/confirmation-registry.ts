/** Single process-local registry shared by scheduled producers, web and channels. */
import type { ConfirmationDecision, ConfirmationResolver } from '@use-brian/core'
import { isInboxSentinel } from '../session-kind.js'

export const SHARED_TELEGRAM_CONFIRMATION_INTEGRATION = 'system:telegram'
export const SYSTEM_WHATSAPP_CONFIRMATION_INTEGRATION = 'system:whatsapp'
export type SchedulerChannelScope = {
  workspaceId: string
  assistantId: string
  userId: string
  integrationId: string
  channelType: string
  channelId: string
  threadId?: string
}
export type SchedulerConfirmationDelivery = SchedulerChannelScope & { messageId?: string }
type Owner = { userId?: string | null; channelType?: string | null; channelId?: string | null;
  workspaceId?: string; assistantId?: string; allowPersistentApproval?: boolean }
type Entry = {
  resolver: ConfirmationResolver
  owner: Owner
  expiresAt: number
  delivery?: SchedulerConfirmationDelivery
}
const registry = new Map<string, Entry>()

export function registerSchedulerResolver(toolCallId: string, resolver: ConfirmationResolver, owner: Owner = {}): void {
  for (const [id, entry] of registry) if (entry.expiresAt <= Date.now()) registry.delete(id)
  registry.set(toolCallId, { resolver, owner: { ...owner }, expiresAt: Date.now() + 300_000 })
}

/** Called ONLY by the outbound producer with its actually selected credentials.
 * The actor always comes from the parked resolver, never the delivery/webhook.
 * Attach before sending; clear on failure and add the posted message ID after.
 */
export function bindSchedulerConfirmationDelivery(toolCallId: string,
  delivery: Omit<SchedulerConfirmationDelivery, 'userId'>, allowPersistentApproval: boolean,
): boolean {
  const entry = registry.get(toolCallId)
  if (!entry || !entry.owner.userId || entry.expiresAt <= Date.now()
    || entry.owner.channelType !== delivery.channelType
    || (entry.owner.channelId !== delivery.channelId && !isInboxSentinel(entry.owner.channelId))
    || (entry.owner.workspaceId && entry.owner.workspaceId !== delivery.workspaceId)
    || (entry.owner.assistantId && entry.owner.assistantId !== delivery.assistantId)) return false
  entry.delivery = { ...delivery, userId: entry.owner.userId }
  entry.owner.allowPersistentApproval = allowPersistentApproval
  return true
}
export function clearSchedulerConfirmationDelivery(toolCallId: string): void {
  const entry = registry.get(toolCallId)
  if (entry) entry.delivery = undefined
}
export function getSchedulerConfirmationActor(toolCallId: string): string | undefined {
  return registry.get(toolCallId)?.owner.userId ?? undefined
}

function matchesAddress(delivery: SchedulerConfirmationDelivery, scope: SchedulerChannelScope): boolean {
  return delivery.workspaceId === scope.workspaceId && delivery.assistantId === scope.assistantId
    && delivery.userId === scope.userId && delivery.integrationId === scope.integrationId
    && delivery.channelType === scope.channelType && delivery.channelId === scope.channelId
}
function matches(delivery: SchedulerConfirmationDelivery, scope: SchedulerChannelScope): boolean {
  return matchesAddress(delivery, scope) && (delivery.threadId === scope.threadId
      || (!delivery.threadId && !!delivery.messageId && scope.threadId === delivery.messageId))
}
/** Explicit native callbacks may report the card message as their thread root.
 * Recover the actual delivery thread ONLY from an exact source-message match,
 * after checking every non-thread address dimension. Never use for typed text.
 */
export function schedulerCallbackDeliveryScope(
  toolCallId: string, scope: SchedulerChannelScope, sourceMessageId: string,
): SchedulerChannelScope | undefined {
  const entry = registry.get(toolCallId)
  const delivery = entry?.delivery
  if (!entry || entry.expiresAt <= Date.now() || !delivery || !sourceMessageId
    || delivery.messageId !== sourceMessageId || !matchesAddress(delivery, scope)) return undefined
  return { ...scope, threadId: delivery.threadId }
}

export function findSchedulerChannelConfirmations(scope: SchedulerChannelScope, toolCallId?: string) {
  return [...registry.entries()].flatMap(([id, entry]) => entry.delivery
    && entry.expiresAt > Date.now() && matches(entry.delivery, scope) && (!toolCallId || id === toolCallId)
    ? [{ toolCallId: id, delivery: { ...entry.delivery }, expiresAt: entry.expiresAt,
        allowPersistentApproval: entry.owner.allowPersistentApproval === true }] : [])
}

/** Channel callers MUST supply complete outbound provenance. User-only guards
 * remain the authenticated web UI path; unguarded/channel-only legacy routes
 * cannot resolve a provenance-bound entry. */
export function tryResolveSchedulerConfirmation(toolCallId: string, decision: ConfirmationDecision,
  guard?: { userId?: string; channelType?: string; channelId?: string } & Partial<SchedulerChannelScope>,
): boolean {
  const entry = registry.get(toolCallId)
  if (!entry || entry.expiresAt <= Date.now() || !guard?.userId || guard.userId !== entry.owner.userId) return false
  if (guard.channelType !== undefined && !entry.delivery) return false
  if (entry.delivery) {
    if (!guard?.userId) return false
    if (guard.channelType !== undefined && !matches(entry.delivery, guard as SchedulerChannelScope)) return false
  }
  if (guard) {
    if (guard.userId !== undefined && guard.userId !== entry.owner.userId) return false
    if (guard.channelType !== undefined && guard.channelType !== entry.owner.channelType) return false
    if (guard.channelId !== undefined && guard.channelId !== (entry.delivery?.channelId ?? entry.owner.channelId)) return false
  }
  if ((decision === 'always_allow' || decision === 'always_deny') && entry.owner.allowPersistentApproval !== true) return false
  registry.delete(toolCallId) // claim before resuming (including synchronous re-entrancy)
  entry.resolver.resolve(toolCallId, decision)
  return true
}
export function unregisterSchedulerResolver(toolCallId: string): void { registry.delete(toolCallId) }
