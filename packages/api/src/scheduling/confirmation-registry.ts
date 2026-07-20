/**
 * Shared in-memory registry for scheduler confirmation resolvers.
 *
 * When a scheduled job hits an 'ask'-policy tool, the job executor
 * creates a ConfirmationResolver and registers it here. Channel webhook
 * handlers (Telegram callback, Slack message, WhatsApp keyword, web POST)
 * look up the resolver by toolCallId and call resolve() to unblock the
 * suspended query loop.
 *
 * This works because the scheduler and all route handlers run in the
 * same Node process (packages/api/src/index.ts).
 */

import type { ConfirmationDecision, ConfirmationResolver } from '@use-brian/core'

/**
 * Each entry carries its OWNER (the deliver-target user + channel the
 * confirmation was issued to). The registry is a process-global map keyed by
 * toolCallId alone across every user and channel; without the owner, any
 * channel handler that resolves an arbitrary toolCallId could approve another
 * user's parked job action (cross-tenant — 2026-06-02 audit). Resolution is
 * therefore guardable: a caller passes the identity it can prove (e.g. the
 * Telegram chat id of the click), and the resolve only fires when it matches.
 */
type SchedulerResolverEntry = {
  resolver: ConfirmationResolver
  userId: string | null
  channelType: string | null
  channelId: string | null
}

const registry = new Map<string, SchedulerResolverEntry>()

/** Register a resolver (with its deliver-target owner) so channel handlers can find it. */
export function registerSchedulerResolver(
  toolCallId: string,
  resolver: ConfirmationResolver,
  owner?: { userId?: string | null; channelType?: string | null; channelId?: string | null },
): void {
  registry.set(toolCallId, {
    resolver,
    userId: owner?.userId ?? null,
    channelType: owner?.channelType ?? null,
    channelId: owner?.channelId ?? null,
  })
}

/**
 * Try to resolve a scheduler confirmation. Returns true if the resolver was
 * found, passed the ownership guard, and the decision was delivered.
 *
 * When `guard` is supplied, every provided field MUST equal the entry's
 * recorded owner — and a guarded field that the entry left null fails closed
 * (the executor always records the deliver-target, so a null owner field means
 * "unknown owner", which a guarded caller must not resolve). Callers that have
 * already scoped the toolCallId to a tenant by other means (e.g. Slack/WhatsApp
 * `findPendingByChannel`, or the web route's deferred-row owner check) may omit
 * the guard.
 */
export function tryResolveSchedulerConfirmation(
  toolCallId: string,
  decision: ConfirmationDecision,
  guard?: { userId?: string; channelType?: string; channelId?: string },
): boolean {
  const entry = registry.get(toolCallId)
  if (!entry) return false
  if (guard) {
    if (guard.userId !== undefined && guard.userId !== entry.userId) return false
    if (guard.channelType !== undefined && guard.channelType !== entry.channelType) return false
    if (guard.channelId !== undefined && guard.channelId !== entry.channelId) return false
  }
  entry.resolver.resolve(toolCallId, decision)
  registry.delete(toolCallId)
  return true
}

/** Remove a resolver (e.g. after timeout or job completion). */
export function unregisterSchedulerResolver(toolCallId: string): void {
  registry.delete(toolCallId)
}
