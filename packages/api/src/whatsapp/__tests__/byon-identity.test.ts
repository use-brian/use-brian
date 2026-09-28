import { describe, expect, it, vi } from 'vitest'
import { resolveWhatsappByonTurnIdentity, whatsappByonSender, type WhatsappByonIdentityDeps } from '../byon-identity.js'

const input = {
  channelId: 'connection', chatJid: 'group@g.us', senderJid: '12345678@lid',
  senderPnJid: '15551234567:2@s.whatsapp.net', senderName: 'Sender',
}
function deps() {
  return {
    findLinkedAccount: vi.fn(async (_provider: string, _providerId: string) => ({ userId: 'verified-user' } as { userId: string } | null)),
    findUser: vi.fn(async () => ({ id: 'verified-user' } as { id: string } | null)),
    // A stale shadow cache's identified flag must never authorize approvals.
    resolveShadow: vi.fn(async () => ({ user: { id: 'shadow-user' }, isIdentified: true })),
  } satisfies WhatsappByonIdentityDeps
}

describe('BYON production turn identity', () => {
  it('composes the linked sender, not the owner, while preserving the provider JID in scope', async () => {
    const d = deps()
    const identity = await resolveWhatsappByonTurnIdentity(input, 'assistant', d)
    expect(identity).toEqual({
      userId: 'verified-user', isIdentified: true, actorChannelId: input.senderPnJid,
      interactionScope: { channelType: 'whatsapp', integrationId: 'connection', conversationId: 'group@g.us', senderId: input.senderPnJid },
    })
    expect(d.findLinkedAccount).toHaveBeenCalledExactlyOnceWith('whatsapp', '15551234567')
    expect(d.findUser).toHaveBeenCalledExactlyOnceWith('verified-user')
    expect(d.resolveShadow).not.toHaveBeenCalled()
  })

  it.each(['missing', 'deleted', 'lookup-error', 'user-error', 'mismatched-user'])(
    'uses only an unidentified shadow for a %s verified link', async failure => {
      const d = deps()
      if (failure === 'missing') d.findLinkedAccount.mockResolvedValue(null)
      if (failure === 'deleted') d.findUser.mockResolvedValue(null)
      if (failure === 'lookup-error') d.findLinkedAccount.mockRejectedValue(new Error('lookup failed'))
      if (failure === 'user-error') d.findUser.mockRejectedValue(new Error('lookup failed'))
      if (failure === 'mismatched-user') d.findUser.mockResolvedValue({ id: 'someone-else' })
      const result = await resolveWhatsappByonTurnIdentity(input, 'assistant', d)
      expect(result).toMatchObject({ userId: 'shadow-user', isIdentified: false })
      expect(d.resolveShadow).toHaveBeenCalledExactlyOnceWith('15551234567', 'assistant', 'Sender')
    },
  )

  it('fails closed if shadow resolution fails, rather than impersonating the owner', async () => {
    const d = deps()
    d.findLinkedAccount.mockResolvedValue(null)
    d.resolveShadow.mockRejectedValue(new Error('shadow unavailable'))
    await expect(resolveWhatsappByonTurnIdentity(input, 'assistant', d)).rejects.toThrow('shadow unavailable')
  })

  it('does not turn a LID into a phone-number linked account or shadow key', async () => {
    const d = deps()
    d.findLinkedAccount.mockImplementation(async (_provider, id) => id === '15551234567' ? { userId: 'phone-owner' } : null)
    const lid = await resolveWhatsappByonTurnIdentity({ ...input, senderJid: '15551234567@lid', senderPnJid: undefined }, 'assistant', d)
    expect(lid).toMatchObject({ userId: 'shadow-user', isIdentified: false, actorChannelId: '15551234567@lid',
      interactionScope: { senderId: '15551234567@lid' } })
    expect(d.findLinkedAccount).toHaveBeenCalledWith('whatsapp', '15551234567@lid')
    expect(d.findUser).not.toHaveBeenCalled()
    expect(d.resolveShadow).toHaveBeenCalledWith('15551234567@lid', 'assistant', 'Sender')
  })

  it.each(['+1 (555) 123-4567', '15551234567@s.whatsapp.net', '15551234567:9@c.us'])(
    'normalizes only the identity lookup key for %s', senderJid => {
      expect(whatsappByonSender({ senderJid })).toEqual({ senderId: senderJid, providerUserId: '15551234567' })
    },
  )

  it.each(['', '123@g.us', 'phone15551234567@s.whatsapp.net', '123@lid@other', 'abc@lid'])(
    'rejects invalid sender %s before looking up identity', async senderJid => {
      const d = deps()
      await expect(resolveWhatsappByonTurnIdentity({ ...input, senderJid, senderPnJid: undefined }, 'assistant', d)).rejects.toThrow()
      expect(d.findLinkedAccount).not.toHaveBeenCalled()
      expect(d.resolveShadow).not.toHaveBeenCalled()
    },
  )
})
