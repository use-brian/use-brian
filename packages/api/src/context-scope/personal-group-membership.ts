/**
 * Live proof that a Telegram group is personal to one workspace member.
 *
 * A personal group binding lets that member's personal context reach a group,
 * which is only safe while every human in it is that member. Telegram lets a
 * bot count members and look up one account at a time, so the proof is:
 *
 *   humans = getChatMemberCount - bots Brian knows are present (each verified)
 *   allowed iff humans >= 1 and every human is one of the member's linked
 *   Telegram accounts (each verified present)
 *
 * Every failure is "not verified": an API error, a bot Brian does not know
 * (it inflates the human count), a linked account that left, or no linked
 * account at all. Only successes are cached, briefly, so a join is seen within
 * seconds and a long turn's final delivery re-proves membership.
 *
 * Spec: docs/architecture/context-engine/scoped-context.md
 *   -> "Destination-bound delivery authority" -> "Personal groups".
 * [COMP:api/personal-group-membership]
 */

import { createTelegramApi } from '@use-brian/channels'
import {
  listLinkedTelegramIdsSystem,
  listTelegramBotUserIdsSeenInChatSystem,
} from '../db/telegram-group-membership.js'

export type PersonalGroupInput = {
  channelType: string
  /** Bare provider chat id (no `:topic:` suffix). */
  chatId: string
  recipientUserId: string
  /** Token of a bot in the chat, used for the membership calls. */
  botToken: string | null
}

export type VerifyPersonalGroup = (input: PersonalGroupInput) => Promise<boolean>

type MembershipApi = {
  getChatMemberCount(chatId: string): Promise<number>
  getChatMember(chatId: string, userId: string): Promise<{ status: string; is_member?: boolean }>
}

type Dependencies = {
  api?: (botToken: string) => MembershipApi
  listBots?: (chatId: string) => Promise<string[]>
  listLinked?: (userId: string) => Promise<string[]>
  now?: () => number
  cacheTtlMs?: number
}

const DEFAULT_CACHE_TTL_MS = 10_000

function isPresent(member: { status: string; is_member?: boolean }): boolean {
  if (member.status === 'restricted') return member.is_member === true
  return member.status === 'creator' || member.status === 'administrator' || member.status === 'member'
}

export function createPersonalGroupVerifier(dependencies: Dependencies = {}): VerifyPersonalGroup {
  const api = dependencies.api ?? ((token: string) => createTelegramApi({ token }))
  const listBots = dependencies.listBots ?? listTelegramBotUserIdsSeenInChatSystem
  const listLinked = dependencies.listLinked ?? listLinkedTelegramIdsSystem
  const now = dependencies.now ?? Date.now
  const ttl = dependencies.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const verifiedUntil = new Map<string, number>()

  async function verify(input: PersonalGroupInput): Promise<boolean> {
    if (input.channelType !== 'telegram' || !input.botToken) return false
    const client = api(input.botToken)
    const [linked, bots, count] = await Promise.all([
      listLinked(input.recipientUserId),
      listBots(input.chatId),
      client.getChatMemberCount(input.chatId),
    ])
    if (linked.length === 0) return false
    const presence = async (userId: string) =>
      isPresent(await client.getChatMember(input.chatId, userId))
    const [botsPresent, linkedPresent] = await Promise.all([
      Promise.all(bots.map(presence)),
      Promise.all(linked.map(presence)),
    ])
    const humans = count - botsPresent.filter(Boolean).length
    return humans >= 1 && humans === linkedPresent.filter(Boolean).length
  }

  return async (input) => {
    const key = `${input.chatId}\x00${input.recipientUserId}`
    const cached = verifiedUntil.get(key)
    if (cached !== undefined && cached > now()) return true
    let ok = false
    try {
      ok = await verify(input)
    } catch {
      ok = false
    }
    if (ok) verifiedUntil.set(key, now() + ttl)
    else verifiedUntil.delete(key)
    return ok
  }
}
