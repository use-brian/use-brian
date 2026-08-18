import { describe, expect, it, vi } from 'vitest'
import {
  resolveDeliveryChannel,
  resolveTargetView,
  resolveTargetViewDetailed,
} from '../delivery-resolution.js'

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

describe('[COMP:scheduling/delivery-resolution] resolveTargetViewDetailed', () => {
  const ctx = { userId: 'u-1', workspaceId: 'ws-1' }
  const PAGE = '3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c'

  it('no candidate → unlinked with no warning (nothing was asked for)', async () => {
    expect(await resolveTargetViewDetailed(undefined, null, ctx)).toEqual({ viewId: null })
  })

  it('no validator wired → the candidate is trusted, no warning', async () => {
    expect(await resolveTargetViewDetailed(undefined, PAGE, ctx)).toEqual({ viewId: PAGE })
  })

  it('same-workspace page → linked, no warning', async () => {
    const resolver = vi.fn(async () => 'ws-1')
    expect(await resolveTargetViewDetailed(resolver, PAGE, ctx)).toEqual({ viewId: PAGE })
    expect(resolver).toHaveBeenCalledWith({ userId: 'u-1', viewId: PAGE })
  })

  it('unresolvable page → dropped WITH a warning naming the id, the discovery tools, and the verdict', async () => {
    // The silent-drop failure: the schedule is saved, the model is told
    // nothing, and the page it promised to maintain is never touched.
    const { viewId, warning } = await resolveTargetViewDetailed(async () => null, PAGE, ctx)
    expect(viewId).toBeNull()
    expect(warning).toContain(PAGE)
    expect(warning).toMatch(/NOT linked to this schedule/)
    expect(warning).toMatch(/deleted, superseded/)
    expect(warning).toContain('`findPage`')
    expect(warning).toContain('`listPages`')
    expect(warning).toMatch(/The schedule itself is live/)
    expect(warning).toMatch(/re-sending this same id will drop it again/)
  })

  it('page in another workspace → dropped, and the warning says WHICH constraint failed', async () => {
    const { viewId, warning } = await resolveTargetViewDetailed(async () => 'ws-other', PAGE, ctx)
    expect(viewId).toBeNull()
    expect(warning).toMatch(/lives in a different workspace/)
    expect(warning).toMatch(/re-sending this same id will drop it again/)
  })

  it('no workspace context → dropped, and the warning names that as the cause', async () => {
    const { viewId, warning } = await resolveTargetViewDetailed(
      async () => 'ws-1',
      PAGE,
      { userId: 'u-1', workspaceId: null },
    )
    expect(viewId).toBeNull()
    expect(warning).toMatch(/no workspace context/)
  })

  it('a thrown lookup is reported as transient, not as a bad id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { viewId, warning } = await resolveTargetViewDetailed(
      async () => { throw new Error('db down') },
      PAGE,
      ctx,
    )
    expect(viewId).toBeNull()
    expect(warning).toMatch(/the page lookup itself failed/)
    expect(warning).toMatch(/transient: retry the page link once/i)
    // Never rendered as "no such page" — that is the miss/failure conflation.
    expect(warning).not.toMatch(/deleted, superseded/)
    warn.mockRestore()
  })

  it('resolveTargetView stays the id-only wrapper (existing call sites unchanged)', async () => {
    expect(await resolveTargetView(async () => 'ws-1', PAGE, ctx)).toBe(PAGE)
    expect(await resolveTargetView(async () => 'ws-other', PAGE, ctx)).toBeNull()
  })
})
