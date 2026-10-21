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
