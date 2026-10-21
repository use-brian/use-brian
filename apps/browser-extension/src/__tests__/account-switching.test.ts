import { describe, expect, it, vi } from 'vitest'
import { installAccountSwitching, type AccountBroker } from '../account-switching.js'
const first = { id: 'user-1', name: 'First account', email: 'first@example.com' }
const second = { id: 'user-2', name: 'Second account', email: 'second@example.com' }
function broker(user = first, origin = 'https://app.example.com', workspaceId = 'workspace-1'): AccountBroker {
  return { port: { sender: { origin }, postMessage: vi.fn() } as unknown as chrome.runtime.Port,
    hello: { userId: user.id, workspaceId, workspaceName: 'Example workspace', accountDirectory: { current: user, accounts: [first, second] } } }
}
function harness() {
  const data: Record<string, unknown> = {}, brokers = [broker()]
  let time = 1000
  const store = { get: vi.fn(async () => ({ ...data })), set: vi.fn(async (value: object) => { Object.assign(data, value) }), remove: vi.fn(async (key: string | string[]) => { for (const k of Array.isArray(key) ? key : [key]) delete data[k] }) }
  const deps = { store: store as unknown as chrome.storage.StorageArea, brokers: () => brokers, appOrigin: async () => 'https://app.example.com', beforeSwitch: vi.fn(async () => {}), reset: vi.fn(), publish: vi.fn(), now: () => time }
  return { data, brokers, deps, service: installAccountSwitching(deps), advance: () => { time += 600001 } }
}
const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
const begin = async (h: ReturnType<typeof harness>) => h.service.panel({ type: 'account-switch', accountId: second.id })
async function target(h: ReturnType<typeof harness>) {
  const b = broker(second); h.brokers.push(b); h.service.hello(b); await settle()
  const message = (b.port.postMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
  return { b, id: message?.id }
}
describe('[COMP:ext/account-switching] canonical saved accounts', () => {
  it('publishes bounded display fields without credentials', async () => {
    {
      const h = harness(); (h.brokers[0].hello.accountDirectory as any).accounts[0] = { ...first, refreshToken: 'PRIVATE' }
      const status = await h.service.status()
      expect(status.accountDirectory?.accounts[0]).toEqual(first)
      expect(JSON.stringify(status)).not.toContain('PRIVATE')
    }
  })
  it('stops control and clears the old panel before requesting canonical auth', async () => {
    const h = harness(); await begin(h)
    expect(h.deps.beforeSwitch).toHaveBeenCalledOnce(); expect(h.deps.reset).toHaveBeenCalledOnce()
    expect(h.deps.beforeSwitch.mock.invocationCallOrder[0]).toBeLessThan(h.deps.reset.mock.invocationCallOrder[0])
    expect(h.brokers[0].port.postMessage).toHaveBeenLastCalledWith({ type: 'account-action', action: 'switch', accountId: second.id })
    expect(await h.service.blocked()).toBe(true)
    expect(JSON.stringify(h.data)).not.toMatch(/token|password|credential/i)
  })
  it('does not navigate or save an intent if protected cleanup blocks switching', async () => {
    const h = harness(); h.deps.beforeSwitch.mockRejectedValue(Object.assign(new Error('blocked'), { code: 'protected_fill_denied' }))
    await begin(h)
    expect(h.deps.reset).not.toHaveBeenCalled(); expect(h.brokers[0].port.postMessage).not.toHaveBeenCalled()
    expect(await h.service.blocked()).toBe(false)
    expect(h.deps.publish).toHaveBeenCalledWith({ type: 'account-error', code: 'protected_fill_denied' })
  })
  it('rejects unknown saved accounts and a different deployment', async () => {
    const h = harness(); h.brokers.push(broker(second, 'https://other.example.com'))
    await h.service.panel({ type: 'account-switch', accountId: 'unknown' })
    expect(h.deps.beforeSwitch).not.toHaveBeenCalled()
    await begin(h)
    const unrelated = h.brokers[1]; h.service.hello(unrelated); h.service.hello(h.brokers[0]); await settle()
    expect(unrelated.port.postMessage).not.toHaveBeenCalled()
    expect(h.brokers[0].port.postMessage).toHaveBeenCalledTimes(1)
  })
  it('requires the selected target user and explicit selection from its profile list', async () => {
    const h = harness(); await begin(h); const { b, id } = await target(h)
    expect(b.port.postMessage).toHaveBeenLastCalledWith({ type: 'account-profiles', id })
    h.service.receive(b, { type: 'account-profiles', id: 'wrong', profiles: [{ id: 'private', name: 'Ignored' }] }); await settle()
    expect((await h.service.status()).accountSetup).not.toHaveProperty('profiles')
    h.service.receive(b, { type: 'account-profiles', id, profiles: [{ id: 'profile-2', name: 'Work browser' }] }); await settle()
    await h.service.panel({ type: 'account-pair', profileId: 'unknown' })
    expect(b.port.postMessage).toHaveBeenCalledTimes(1)
    await h.service.panel({ type: 'account-pair', profileId: 'profile-2' })
    expect(b.port.postMessage).toHaveBeenLastCalledWith({ type: 'account-pair', id, profileId: 'profile-2' })
    h.service.receive(b, { type: 'account-paired', id, ok: true }); await settle()
    expect(await h.service.blocked()).toBe(false)
  })
  it('expires redirect intents and never pairs after expiry', async () => {
    const h = harness(); await begin(h); const { b, id } = await target(h); h.advance()
    h.service.receive(b, { type: 'account-profiles', id, profiles: [{ id: 'profile-2', name: 'Work browser' }] }); await settle()
    expect(await h.service.blocked()).toBe(false); expect(h.data).toEqual({})
    await h.service.panel({ type: 'account-pair', profileId: 'profile-2' })
    expect(b.port.postMessage).toHaveBeenCalledTimes(1)
  })
  it('resumes a redirect after worker restart without reissuing sign-in or a chat', async () => {
    const h = harness(); await begin(h)
    const service = installAccountSwitching(h.deps), b = broker(second)
    h.brokers.push(b); service.hello(b); await settle()
    expect(b.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'account-profiles' }))
    expect(JSON.stringify((b.port.postMessage as ReturnType<typeof vi.fn>).mock.calls)).not.toMatch(/account-action|send/)
  })
  it('Add account only resumes for a different identity; cancellation blocks stale responses', async () => {
    const h = harness(); await h.service.panel({ type: 'account-add' }); h.service.hello(h.brokers[0]); await settle()
    expect(h.brokers[0].port.postMessage).toHaveBeenCalledTimes(1)
    const { b, id } = await target(h)
    await h.service.panel({ type: 'account-cancel' })
    h.service.receive(b, { type: 'account-profiles', id, profiles: [{ id: 'profile-2', name: 'Work browser' }] }); await settle()
    expect(await h.service.blocked()).toBe(false)
    expect((await h.service.status()).accountSetup).toBeNull()
  })
  it('keeps failed profile pairing visible and allows another explicit attempt', async () => {
    const h = harness(); await begin(h); const { b, id } = await target(h)
    h.service.receive(b, { type: 'account-profiles', id, profiles: [{ id: 'profile-2', name: 'Work browser' }] }); await settle()
    await h.service.panel({ type: 'account-pair', profileId: 'profile-2' })
    h.service.receive(b, { type: 'account-paired', id, ok: false }); await settle()
    expect(await h.service.blocked()).toBe(true)
    expect(h.deps.publish).toHaveBeenLastCalledWith({ type: 'account-error', code: 'account_unavailable' })
    await h.service.panel({ type: 'account-pair', profileId: 'profile-2' })
    expect(b.port.postMessage).toHaveBeenLastCalledWith({ type: 'account-pair', id, profileId: 'profile-2' })
  })
})

describe('[COMP:ext/account-switching] current-account recovery', () => {
  it('selects an owned profile for the current sign-in without navigating auth', async () => {
    const h = harness(); await h.service.panel({ type: 'account-connect' }); await settle()
    expect(h.brokers[0].port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'account-profiles' }))
    expect(h.brokers[0].port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'account-action' }))
    expect(await h.service.blocked()).toBe(true)
  })
})

describe('[COMP:ext/account-switching] workspace handoff', () => {
  function workspaces(h: ReturnType<typeof harness>) {
    h.brokers[0].hello.workspaceDirectory = { active: { id: 'workspace-1', name: 'First workspace' }, workspaces: [ { id: 'workspace-1', name: 'First workspace' }, { id: 'workspace-2', name: 'Second workspace' } ] }
    return h
  }
  it('requires a published workspace and binds resumption to its exact account and workspace', async () => {
    const h = workspaces(harness())
    await h.service.panel({ type: 'workspace-switch', workspaceId: 'unknown' })
    expect(h.deps.beforeSwitch).not.toHaveBeenCalled()
    await h.service.panel({ type: 'workspace-switch', workspaceId: 'workspace-2' })
    expect(h.brokers[0].port.postMessage).toHaveBeenLastCalledWith({ type: 'workspace-action', workspaceId: 'workspace-2' })
    expect(h.deps.reset).toHaveBeenCalledOnce()
    const wrongUser = broker(second, undefined, 'workspace-2'), wrongWorkspace = broker(first, undefined, 'workspace-3')
    for (const b of [wrongUser, wrongWorkspace]) { h.brokers.push(b); h.service.hello(b) }
    await settle()
    expect(wrongUser.port.postMessage).not.toHaveBeenCalled(); expect(wrongWorkspace.port.postMessage).not.toHaveBeenCalled()
    const target = broker(first, undefined, 'workspace-2'); h.brokers.push(target); h.service.hello(target); await settle()
    expect(target.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'account-profiles' }))
  })
  it('limits current-account recovery to the displayed workspace', async () => {
    const h = workspaces(harness()); await h.service.panel({ type: 'account-connect' }); await settle()
    const other = broker(first, undefined, 'workspace-2'); h.brokers.push(other); h.service.hello(other); await settle()
    expect(other.port.postMessage).not.toHaveBeenCalled()
  })
  it('allows workspace selection in an edition without saved account auth', async () => {
    const h = workspaces(harness()); (h.brokers[0].hello.accountDirectory as any).canManageAccounts = false
    await h.service.panel({ type: 'account-add' }); await begin(h)
    expect(h.deps.beforeSwitch).not.toHaveBeenCalled()
    await h.service.panel({ type: 'workspace-switch', workspaceId: 'workspace-2' })
    expect(h.brokers[0].port.postMessage).toHaveBeenLastCalledWith({ type: 'workspace-action', workspaceId: 'workspace-2' })
  })
  it('publishes only bounded display fields, safe images and preference timestamps', async () => {
    const h = workspaces(harness()); const raw = h.brokers[0].hello.workspaceDirectory as any
    raw.workspaces = [{ id: 'workspace-2', name: 'Second workspace', iconUrl: 'javascript:alert(1)', iconSeed: 42, pickerLastOpenedAt: 'not-a-date', token: 'PRIVATE' }]
    ;(h.brokers[0].hello.accountDirectory as any).current.avatarUrl = 'data:text/html,PRIVATE'
    const status = await h.service.status()
    expect(status.workspaceDirectory?.workspaces).toEqual([{ id: 'workspace-2', name: 'Second workspace', iconSeed: 42 }])
    expect(JSON.stringify(status)).not.toMatch(/PRIVATE|javascript:/)
    raw.active.id = 'another-workspace'
    expect((await h.service.status()).workspaceDirectory).toBeNull()
  })
})

function automaticHarness() {
  const h = harness(); h.brokers[0].hello.automaticBrowser = true;
  const installationId = vi.fn(async () => '10000000-0000-4000-8000-000000000001');
  const beforeAutomaticConnect = vi.fn(async () => {});
  const service = installAccountSwitching({ ...h.deps, installationId, beforeAutomaticConnect });
  return { ...h, service, installationId, beforeAutomaticConnect };
}
describe('[COMP:ext/account-switching] automatic extension chat setup', () => {
  it('connects on panel admission with no profile list, code or pairing click', async () => {
    const h = automaticHarness(); await h.service.ensureConnection(); await h.service.ensureConnection();
    expect(h.brokers[0].port.postMessage).toHaveBeenCalledOnce();
    const message = (h.brokers[0].port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(message).toMatchObject({ type: 'browser-connect', installationId: await h.installationId() });
    h.service.receive(h.brokers[0], { type: 'browser-connected', id: message.id, profileId: 'private-extension-profile' }); await settle();
    expect(await h.service.blocked()).toBe(false); await h.service.ensureConnection();
    expect(h.brokers[0].port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'account-profiles' }));
    expect(h.brokers[0].port.postMessage).toHaveBeenCalledTimes(2); // connect + cancellation of its request owner
  });
  it('does not retry failed automatic setup on status polls; Retry is explicit', async () => {
    const h = automaticHarness(); await h.service.ensureConnection();
    const message = (h.brokers[0].port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    h.service.receive(h.brokers[0], { type: 'account-error', id: message.id }); await settle();
    await h.service.ensureConnection(); expect(h.brokers[0].port.postMessage).toHaveBeenCalledOnce();
    expect((await h.service.status()).accountSetup).toMatchObject({ automatic: true, failed: true, pairing: false });
    await h.service.panel({ type: 'account-retry' });
    expect(h.brokers[0].port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'browser-connect' }));
  });
  it('does not interrupt a live website task on passive panel open', async () => {
    const h = automaticHarness(); h.beforeAutomaticConnect.mockRejectedValue(new Error('busy'));
    await h.service.ensureConnection(); await h.service.ensureConnection();
    expect(h.brokers[0].port.postMessage).not.toHaveBeenCalled(); expect(h.deps.beforeSwitch).not.toHaveBeenCalled(); expect(h.deps.reset).not.toHaveBeenCalled();
  });
  it('rebinds the new authenticated app port after a page reload', async () => {
    const h = automaticHarness(); await h.service.ensureConnection();
    const message = (h.brokers[0].port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    h.service.receive(h.brokers[0], { type: 'browser-connected', id: message.id, profileId: 'profile' }); await settle();
    h.service.disconnected(h.brokers[0]); await h.service.ensureConnection();
    expect(h.brokers[0].port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'browser-connect' }));
  });
})

it('[COMP:ext/account-switching] allows missing-identity recovery only after explicit Retry', async () => {
  const h = automaticHarness(); await h.service.ensureConnection();
  const message = (h.brokers[0].port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
  h.service.receive(h.brokers[0], { type: 'account-error', id: message.id, code: 'browser_identity_changed' }); await settle();
  await h.service.ensureConnection(); expect(h.brokers[0].port.postMessage).toHaveBeenCalledOnce();
  await h.service.panel({ type: 'account-retry' });
  expect(h.brokers[0].port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'browser-connect', resetMissing: true }));
});
