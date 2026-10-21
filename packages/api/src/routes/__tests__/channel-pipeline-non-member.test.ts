import { describe, it, expect } from 'vitest'
import { buildNonMemberSenderBlock, resolveChannelSpeakerAccount } from '../channel-pipeline.js'
import { speakerIdentityFromUser } from '../_prompt-builder.js'

// An email on a channel-only shadow is provider profile data, not proof of
// a registered sign-in account. Recovery guidance must preserve that
// distinction and the workspace access boundary. See channel-user-identity.md
// -> "Non-member senders".
describe('[COMP:api/channel-pipeline/non-member-sender] non-member sender block', () => {
  it.each(['email', 'google', 'oidc'])('names a registered %s account while requiring membership and linking first', (senderAuthProvider) => {
    const block = buildNonMemberSenderBlock({
      channelType: 'slack',
      senderAccount: resolveChannelSpeakerAccount({
        email: 'ken@company.example',
        name: 'Ken',
        authProvider: senderAuthProvider,
      }),
    })
    expect(block.startsWith('# Sender is not a workspace member')).toBe(true)
    expect(block).toContain('Ken <ken@company.example>')
    expect(block).toContain('resolves to the registered Use Brian account ken@company.example')
    expect(block).toContain('do NOT report "no workflows"')
    expect(block).toContain('Give verified linking as the primary remedy')
    expect(block).toContain('Settings -> Account -> Connected accounts')
    expect(block).toContain('linking does not itself grant membership')
    expect(block).toContain('invite their confirmed actual Use Brian sign-in email')
    expect(block.indexOf('Give verified linking')).toBeLessThan(block.indexOf('An alternative'))
    expect(block).not.toContain('connectors) will come back empty')
    expect(block).not.toContain('—')
  })

  it('withholds a shadow profile email and does not present it as a sign-in account', () => {
    const block = buildNonMemberSenderBlock({
      channelType: 'feishu',
      senderAccount: resolveChannelSpeakerAccount({
        email: 'profile-only@company.example',
        name: 'Guest',
        authProvider: 'channel',
      }),
    })
    expect(block).toContain('channel-only identity, not a verified Use Brian sign-in account')
    expect(block).not.toContain('profile-only@company.example')
    expect(block).not.toContain('resolves to the registered Use Brian account')
    expect(block).toContain('Do not disclose a channel profile email')
    expect(block).toContain('or tell an admin to invite it')
    expect(block).toContain('Give verified linking as the primary remedy')
    expect(block).toContain('confirmed actual Use Brian sign-in email')
  })

  it('handles an email-less shadow sender without inventing an address', () => {
    const block = buildNonMemberSenderBlock({
      channelType: 'telegram',
      senderAccount: resolveChannelSpeakerAccount({ email: null, name: null, authProvider: 'channel' }),
    })
    expect(block).toContain('this sender')
    expect(block).toContain('could not be matched to a member of this workspace')
    expect(block).not.toContain('resolves to the registered Use Brian account')
    expect(block).not.toContain('invites that email')
  })

  it.each([null, 'web-guest', 'unrecognized'])('withholds an email when identity provenance is %s', (senderAuthProvider) => {
    const block = buildNonMemberSenderBlock({
      channelType: 'feishu',
      senderAccount: resolveChannelSpeakerAccount({
        email: 'unverified@company.example',
        name: 'Guest',
        authProvider: senderAuthProvider,
      }),
    })
    expect(block).not.toContain('unverified@company.example')
    expect(block).toContain('Its Use Brian sign-in identity has not been verified')
    expect(block).toContain('Do not disclose a channel profile email')
    expect(block).toContain('confirmed actual Use Brian sign-in email')
  })

  it('also withholds a shadow email used as the provider display name', () => {
    const block = buildNonMemberSenderBlock({
      channelType: 'feishu',
      senderAccount: resolveChannelSpeakerAccount({
        email: 'profile-only@company.example',
        name: 'Guest <profile-only@company.example>',
        authProvider: 'channel',
      }),
    })
    expect(block).not.toContain('profile-only@company.example')
    expect(block).toContain('You are answering this sender')
  })

  it.each(['channel', 'email', null])('preserves the connector boundary for %s provenance', (senderAuthProvider) => {
    const block = buildNonMemberSenderBlock({
      channelType: 'feishu',
      senderAccount: resolveChannelSpeakerAccount({
        email: 'guest@company.example',
        name: 'Guest',
        authProvider: senderAuthProvider,
      }),
      assistantConnectorTools: true,
    })
    expect(block).toContain('A channel connector setting does not grant this sender staff authority')
    expect(block).toContain('Do not use protected connectors')
    expect(block).not.toContain('ARE available')
  })

  it.each(['channel', 'web-guest', 'unrecognized'])('omits cached %s account emails from speaker facts without changing the stored user or channel identity', (authProvider) => {
    const user = { id: 'sender-user', authProvider, name: 'Guest', email: 'profile-only@company.example' }
    const account = resolveChannelSpeakerAccount(user)
    const channel = { type: 'feishu', id: 'ou_example_sender', displayName: 'Channel Guest' }
    expect(account.email).toBeNull()
    expect(speakerIdentityFromUser(account, channel)).toEqual({
      name: 'Guest',
      email: null,
      channel,
    })
    expect(user).toEqual({ id: 'sender-user', authProvider, name: 'Guest', email: 'profile-only@company.example' })
  })

  it.each(['email', 'google', 'oidc'])('keeps registered %s email in the shared speaker and connector snapshot', (authProvider) => {
    expect(resolveChannelSpeakerAccount({ authProvider, name: 'Ken', email: 'ken@company.example' })).toEqual({
      provenance: 'registered',
      name: 'Ken',
      email: 'ken@company.example',
    })
  })

  it.each([null, undefined])('has no account facts when the user lookup returns %s', (user) => {
    const account = resolveChannelSpeakerAccount(user)
    expect(account).toEqual({ provenance: 'unknown', name: null, email: null })
    expect(speakerIdentityFromUser(account, { type: 'feishu', id: 'ou_example_sender', displayName: 'Channel Guest' }))
      .toEqual({ name: 'the current channel sender', channel: { type: 'feishu', id: 'ou_example_sender', displayName: 'Channel Guest' } })
  })
})
