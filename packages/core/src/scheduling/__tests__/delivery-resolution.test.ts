import { describe, expect, it } from 'vitest'
import { resolveDeliveryChannel } from '../delivery-resolution.js'

describe('[COMP:scheduling/delivery-resolution] resolveDeliveryChannel', () => {
  it('no explicit channel → preferred messaging channel wins', () => {
    expect(
      resolveDeliveryChannel({
        preferredChannel: { channelType: 'telegram', channelId: '880211324' },
        channelType: 'web',
        channelId: 'web-session-uuid',
      }),
    ).toEqual({ channelType: 'telegram', channelId: '880211324' })
  })

  it('no explicit channel, no preferred → the current session', () => {
    expect(
      resolveDeliveryChannel({
        preferredChannel: null,
        channelType: 'telegram',
        channelId: '-100999:topic:5',
      }),
    ).toEqual({ channelType: 'telegram', channelId: '-100999:topic:5' })
  })

  it('explicit type matching the preferred channel → the preferred id', () => {
    expect(
      resolveDeliveryChannel(
        {
          preferredChannel: { channelType: 'slack', channelId: 'C0BB4AK5BHB' },
          channelType: 'web',
          channelId: 'web-session-uuid',
        },
        'slack',
      ),
    ).toEqual({ channelType: 'slack', channelId: 'C0BB4AK5BHB' })
  })

  it('explicit type matching the current session (not the preferred) → the session id', () => {
    // Authoring from inside a Slack channel whose preferred messaging channel
    // is Telegram: the same-type session must win, never the Telegram id.
    expect(
      resolveDeliveryChannel(
        {
          preferredChannel: { channelType: 'telegram', channelId: '880211324' },
          channelType: 'slack',
          channelId: 'C0BB4AK5BHB',
        },
        'slack',
      ),
    ).toEqual({ channelType: 'slack', channelId: 'C0BB4AK5BHB' })
  })

  it('explicit type matching NEITHER preferred NOR session → empty id (no cross-wiring)', () => {
    // The prod incident: authoring "deliver to Slack" from a web session whose
    // preferred channel is Telegram. The Telegram chat id must NOT be borrowed
    // as the Slack channel — it returns unresolved so the caller can guide.
    expect(
      resolveDeliveryChannel(
        {
          preferredChannel: { channelType: 'telegram', channelId: '880211324' },
          channelType: 'web',
          channelId: 'web-session-uuid',
        },
        'slack',
      ),
    ).toEqual({ channelType: 'slack', channelId: '' })
  })
})
