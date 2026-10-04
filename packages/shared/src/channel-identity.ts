/**
 * Channel identity registry - how a person connects their chat account to
 * their Use Brian account on each channel. One row per channel kind, read by
 * BOTH surfaces that show it (Settings -> Account -> Connected accounts and
 * the Studio channel footer), so every channel looks and behaves the same.
 *
 * A row is a claim about the server, not a preference: `connect: 'code'`
 * means the channel route REDEEMS a link code and its inbound path READS the
 * resulting link before any other resolution. A channel whose route does
 * neither is `'unavailable'` and the UI says so, rather than offering a
 * Connect button whose link nothing would ever read.
 *
 * Spec: docs/plans/channel-identity-binding.md §4, §5.
 * Component tag: [COMP:shared/channel-identity].
 */

export const CHANNEL_IDENTITY_KINDS = [
  'telegram',
  'slack',
  'feishu',
  'whatsapp',
  'discord',
  'msteams',
  'wechat',
  'email',
  'custom',
] as const

export type ChannelIdentityKind = (typeof CHANNEL_IDENTITY_KINDS)[number]

export type ChannelConnectMode =
  /** Mint a code; the response carries a deep link that delivers it (t.me ?start=). */
  | 'code_deeplink'
  /** Mint a code; the person sends it to Brian on the channel. */
  | 'code'
  /** No claim handler or link read on this channel yet. */
  | 'unavailable'

export type ChannelIdentityDescriptor = {
  kind: ChannelIdentityKind
  /** `linked_identities.provider` the claim writes; null when nothing does. */
  linkProvider: string | null
  connect: ChannelConnectMode
  /** `POST` path that mints the code, relative to the API origin. */
  codeEndpoint: string | null
  /**
   * Whether the channel route matches senders to accounts by the provider's
   * email automatically (so most members need no setup at all).
   */
  emailMatching: boolean
  /**
   * Whether the route records its email-matching status
   * (`channel_email_lookup_*`), so the Studio footer can show it to admins.
   * A channel that matches by email but does not report shows no status line
   * rather than a "pending" one that never resolves.
   */
  emailStatusReported: boolean
}

export const CHANNEL_IDENTITY: Record<ChannelIdentityKind, ChannelIdentityDescriptor> = {
  telegram: {
    kind: 'telegram',
    linkProvider: 'telegram',
    connect: 'code_deeplink',
    codeEndpoint: '/api/account/telegram/link-code',
    emailMatching: false,
    emailStatusReported: false,
  },
  slack: {
    kind: 'slack',
    linkProvider: 'slack',
    connect: 'code',
    codeEndpoint: '/api/account/slack/link-code',
    emailMatching: true,
    emailStatusReported: false,
  },
  feishu: {
    kind: 'feishu',
    linkProvider: 'feishu',
    connect: 'code',
    codeEndpoint: '/api/account/feishu/link-code',
    emailMatching: true,
    emailStatusReported: true,
  },
  whatsapp: {
    kind: 'whatsapp',
    linkProvider: 'whatsapp',
    connect: 'code',
    codeEndpoint: '/api/account/whatsapp/link-code',
    emailMatching: false,
    emailStatusReported: false,
  },
  discord: { kind: 'discord', linkProvider: null, connect: 'unavailable', codeEndpoint: null, emailMatching: false, emailStatusReported: false },
  msteams: { kind: 'msteams', linkProvider: null, connect: 'unavailable', codeEndpoint: null, emailMatching: false, emailStatusReported: false },
  wechat: { kind: 'wechat', linkProvider: null, connect: 'unavailable', codeEndpoint: null, emailMatching: false, emailStatusReported: false },
  email: { kind: 'email', linkProvider: null, connect: 'unavailable', codeEndpoint: null, emailMatching: false, emailStatusReported: false },
  custom: { kind: 'custom', linkProvider: null, connect: 'unavailable', codeEndpoint: null, emailMatching: false, emailStatusReported: false },
}

/**
 * The descriptor for a Studio channel. A WhatsApp channel on the Cloud API
 * is the workspace's OWN number, whose route reads no links - the link code
 * only works with the hosted official number - so it is `'unavailable'`.
 */
export function channelIdentityFor(
  channelType: string,
  integrationProvider?: string | null,
): ChannelIdentityDescriptor {
  if (channelType === 'whatsapp' && integrationProvider === 'cloud_api') {
    return { ...CHANNEL_IDENTITY.whatsapp, linkProvider: null, connect: 'unavailable', codeEndpoint: null }
  }
  if ((CHANNEL_IDENTITY_KINDS as readonly string[]).includes(channelType)) {
    return CHANNEL_IDENTITY[channelType as ChannelIdentityKind]
  }
  return CHANNEL_IDENTITY.custom
}
