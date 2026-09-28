import type { ChannelInteractionScope } from '../routes/channel-interactions.js'
import type { WhatsappBotInput } from '../routes/whatsapp-bot-handler.js'

export type WhatsappByonIdentityDeps = {
  findLinkedAccount: (provider: string, providerId: string) => Promise<{ userId: string } | null>
  findUser: (userId: string) => Promise<{ id: string } | null>
  resolveShadow: (providerUserId: string, assistantId: string, displayName: string | null) => Promise<{ user: { id: string } }>
}

/** The connector supplies the PN twin when available. Keep that exact provider
 * identity on interaction/archive metadata; normalization is only for account
 * lookup. A LID without a PN twin must never resolve as a phone-number account.
 */
export function whatsappByonSender(input: Pick<WhatsappBotInput, 'senderJid' | 'senderPnJid'>) {
  const senderId = input.senderPnJid ?? input.senderJid
  const [local, domain, extra] = senderId.split('@')
  if (!local || extra !== undefined) throw new Error('Invalid WhatsApp sender identity')
  if (domain === 'lid') {
    if (!/^\d+(?::\d+)?$/.test(local)) throw new Error('Invalid WhatsApp LID identity')
    return { senderId, providerUserId: `${local.split(':')[0]}@lid` }
  }
  if (domain !== undefined && domain !== 's.whatsapp.net' && domain !== 'c.us') {
    throw new Error('Unsupported WhatsApp sender identity')
  }
  const number = local.split(':')[0]!
  if (!/^\+?[\d\s().-]+$/.test(number)) throw new Error('Invalid WhatsApp phone identity')
  const digits = number.replace(/\D/g, '')
  if (digits.length < 5) throw new Error('Invalid WhatsApp phone identity')
  return { senderId, providerUserId: digits }
}

/** Boot spreads this result into processChannelMessage. Only a current verified
 * provider link plus a live user record grants identified status. A cached
 * shadow/email resolution alone is not evidence for workflow approval authority.
 * No owner identity is accepted as a fallback argument.
 */
export async function resolveWhatsappByonTurnIdentity(
  input: Pick<WhatsappBotInput, 'channelId' | 'chatJid' | 'senderJid' | 'senderPnJid' | 'senderName'>,
  assistantId: string,
  deps: WhatsappByonIdentityDeps,
): Promise<{ userId: string; isIdentified: boolean; actorChannelId: string; interactionScope: ChannelInteractionScope }> {
  const { senderId, providerUserId } = whatsappByonSender(input)
  const scope = {
    actorChannelId: senderId,
    interactionScope: { channelType: 'whatsapp', integrationId: input.channelId, conversationId: input.chatJid, senderId },
  }
  // A failed identity lookup must not fall back to a previously cached claim of
  // verified identity. Anonymous shadow chat is still safe; approvals are not.
  try {
    const linked = await deps.findLinkedAccount('whatsapp', providerUserId)
    if (linked) {
      const user = await deps.findUser(linked.userId)
      if (user && user.id === linked.userId) return { ...scope, userId: user.id, isIdentified: true }
    }
  } catch (error) {
    console.error('[whatsapp-byon] verified sender lookup failed; using unidentified shadow:', error)
  }
  const shadow = await deps.resolveShadow(providerUserId, assistantId, input.senderName ?? null)
  // Shadow resolution failure deliberately propagates; never substitute owner.
  return { ...scope, userId: shadow.user.id, isIdentified: false }
}
