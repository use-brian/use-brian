/**
 * [COMP:app/wechat-desktop-bridge] login supervisor: auth polling → state,
 * QR relay, error translation.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { silentLogger } from '../log.js'
import { createLoginSupervisor, DEFAULT_LOGIN_ERROR, translateLoginError } from '../login-supervisor.js'
import { fakeAgent, fakeBridge, type FakeAgent, type FakeBridge } from './fakes.js'

let agent: FakeAgent
let bridge: FakeBridge

function supervisor() {
  return createLoginSupervisor({ agent, bridge, bridgeVersion: 'test-build', log: silentLogger, authPollMs: 100_000 })
}

const flush = () => new Promise((r) => setImmediate(r))

beforeEach(() => {
  agent = fakeAgent()
  bridge = fakeBridge()
})

describe('[COMP:app/wechat-desktop-bridge] login supervisor', () => {
  it('opens the login WS when logged out and relays a qr event as needs_action with the data URL', async () => {
    const s = supervisor()
    await s.tick()
    expect(agent.subscriptions).toBe(1)
    agent.emit({ type: 'qr', qrData: 'wx://login/abc', qrDataUrl: 'data:image/png;base64,QUJD' })
    await flush()
    const last = bridge.states.at(-1)!
    expect(last).toMatchObject({
      status: 'needs_action',
      action: { kind: 'qr', imageDataUrl: 'data:image/png;base64,QUJD' },
      bridgeVersion: 'test-build',
    })
    expect(s.isLoggedIn()).toBe(false)
  })

  it('falls back to text when the container sends no data URL', async () => {
    const s = supervisor()
    await s.tick()
    agent.emit({ type: 'qr', qrData: 'wx://login/abc' })
    await flush()
    expect(bridge.states.at(-1)!.action).toEqual({ kind: 'qr', text: 'wx://login/abc' })
  })

  it('relays phone_confirm as confirm_on_device', async () => {
    const s = supervisor()
    await s.tick()
    agent.emit({ type: 'phone_confirm', message: 'Tap confirm on your phone' })
    await flush()
    expect(bridge.states.at(-1)).toMatchObject({
      status: 'needs_action',
      action: { kind: 'confirm_on_device', message: 'Tap confirm on your phone' },
    })
  })

  it('login_success publishes connected with the account label and closes the WS', async () => {
    const s = supervisor()
    await s.tick()
    agent.emit({ type: 'login_success', userId: 'wxid_owner1' })
    await flush()
    expect(bridge.states.at(-1)).toMatchObject({ status: 'connected', accountLabel: 'wxid_owner1' })
    expect(s.isLoggedIn()).toBe(true)
    expect(agent.closedSubscriptions).toBe(1)
  })

  it('a logged_in poll publishes connected once, not on every tick', async () => {
    agent.auth = { status: 'logged_in', loggedInUser: 'Test Owner' }
    const s = supervisor()
    await s.tick()
    await s.tick()
    await s.tick()
    const connected = bridge.states.filter((st) => st.status === 'connected')
    expect(connected).toHaveLength(1)
    expect(connected[0]).toMatchObject({ accountLabel: 'Test Owner', bridgeVersion: 'test-build' })
    expect(agent.subscriptions).toBe(0)
    expect(s.isLoggedIn()).toBe(true)
  })

  it('translates a container error to our sentence and keeps the vendor text as cause', async () => {
    const known = translateLoginError('WeChat process not running')
    expect(known.message).toMatch(/not running/)
    expect(known.cause).toBe('WeChat process not running')
    const unknown = translateLoginError('Some vendor string nobody mapped')
    expect(unknown.message).toBe(DEFAULT_LOGIN_ERROR)
    expect(unknown.cause).toBe('Some vendor string nobody mapped')

    const s = supervisor()
    await s.tick()
    agent.emit({ type: 'error', message: 'Some vendor string nobody mapped' })
    await flush()
    const last = bridge.states.at(-1)!
    expect(last.status).toBe('error')
    expect(last.message).toBe(DEFAULT_LOGIN_ERROR)
    expect(JSON.stringify(last)).not.toContain('vendor string')
  })

  it('login_timeout re-opens the WS up to 6 times, then publishes the timeout error', async () => {
    const s = supervisor()
    await s.tick()
    for (let i = 0; i < 5; i++) {
      agent.emit({ type: 'login_timeout' })
      await flush()
    }
    expect(agent.subscriptions).toBe(6)
    expect(bridge.states.at(-1)!.status).not.toBe('error')
    agent.emit({ type: 'login_timeout' })
    await flush()
    expect(bridge.states.at(-1)).toMatchObject({ status: 'error', message: 'Login timed out; reconnect from Studio.' })
    await s.tick()
    expect(agent.subscriptions).toBe(6)
  })

  it('disconnect logs out, publishes disconnected and stops re-opening the WS', async () => {
    agent.auth = { status: 'logged_in', loggedInUser: 'Test Owner' }
    const s = supervisor()
    await s.tick()
    await s.disconnect()
    expect(agent.logoutCalls).toBe(1)
    expect(bridge.states.at(-1)!.status).toBe('disconnected')
    expect(s.isLoggedIn()).toBe(false)
    await s.tick()
    await s.tick()
    expect(agent.subscriptions).toBe(0)
    expect(bridge.states.filter((st) => st.status === 'disconnected')).toHaveLength(1)
  })

  it('an unreachable container publishes an error state', async () => {
    agent.authStatus = async () => {
      throw new Error('ECONNREFUSED')
    }
    await supervisor().tick()
    expect(bridge.states.at(-1)).toMatchObject({ status: 'error' })
    expect(bridge.states.at(-1)!.message).not.toContain('ECONNREFUSED')
  })
})
