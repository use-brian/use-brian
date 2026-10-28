// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(`${process.cwd()}/static/popup.html`, 'utf8')
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const node = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

describe('[COMP:ext/assistant-chat] account-first settings and advanced pairing', () => {
  let receive: (message: Record<string, unknown>) => void
  let postMessage: ReturnType<typeof vi.fn>
  let sendMessage: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    vi.resetModules(); vi.useFakeTimers()
    window.history.replaceState(null, '', '/')
    document.documentElement.innerHTML = html
    postMessage = vi.fn()
    sendMessage = vi.fn(async (message: { type: string }) => message.type === 'protected-status' ? { apiConfigured: true } : message.type === 'status' ? { state: 'unpaired' } : { ok: true })
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, connect: vi.fn(() => ({ postMessage, onMessage: { addListener: (fn: typeof receive) => { receive = fn } }, onDisconnect: { addListener: vi.fn() } })) },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    })
    await import('../popup.js'); await settle()
  })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('leads with sign-in and keeps relay/token inputs inside a collapsed advanced guide', () => {
    expect(node('sign-in').textContent).toBe('Sign in to Brian')
    expect(node<HTMLDetailsElement>('advanced-connection').open).toBe(false)
    expect(node('relay-url').closest('details')?.id).toBe('advanced-connection')
    expect(node('pairing-token').closest('details')?.id).toBe('advanced-connection')
    expect(node('status-text').textContent).not.toContain('Paste a pairing token')
    node('sign-in').click()
    expect(postMessage).toHaveBeenCalledWith({ type: 'sign-in' })
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'configure' }))
  })
  it('shows sign-in progress, allows cancellation, then shows connected identity', () => {
    receive({ type: 'status', connected: false, signInPending: true })
    expect(node('account-status').textContent).toContain('Finish signing in')
    expect(node('sign-in').textContent).toBe('Open sign-in tab')
    node('cancel-sign-in').click()
    expect(postMessage).toHaveBeenCalledWith({ type: 'cancel-sign-in' })
    receive({ type: 'status', connected: true, accountDirectory: { current: { name: 'Example user', email: 'user@example.com' } }, workspaceName: 'Example workspace' })
    expect(node('account-identity').textContent).toBe('user@example.com · Example workspace')
    expect(node('cancel-sign-in').hidden).toBe(true)
    expect(node('account-retry').hidden).toBe(true)
  })
  it('retries an authenticated browser connection through the canonical account flow', () => {
    receive({ type: 'status', connected: false, accountDirectory: { current: { name: 'Example user', email: 'user@example.com' } } })
    expect(node('account-retry').hidden).toBe(false)
    node('account-retry').click()
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'account-connect' })
  })
  it('preserves manual pairing and blank-token reconnect without treating them as login', async () => {
    node<HTMLInputElement>('relay-url').value = 'wss://relay.example.com/ext'
    node<HTMLInputElement>('pairing-token').value = 'fictional-pairing-token'
    node('connect').click(); await settle()
    expect(sendMessage).toHaveBeenCalledWith({ type: 'configure', relayUrl: 'wss://relay.example.com/ext', pairingToken: 'fictional-pairing-token' })
    expect(node<HTMLInputElement>('pairing-token').value).toBe('')
    node('connect').click(); await settle()
    expect(sendMessage).toHaveBeenLastCalledWith({ type: 'configure', relayUrl: 'wss://relay.example.com/ext', pairingToken: undefined })
    expect(node('sign-in').textContent).toBe('Sign in to Brian')
  })
  it('keeps manual connection errors in Advanced connection', async () => {
    sendMessage.mockResolvedValueOnce({ ok: false })
    node('connect').click(); await settle()
    expect(node<HTMLDetailsElement>('advanced-connection').open).toBe(true)
    expect(node('pairing-error').hidden).toBe(false)
    expect(node<HTMLDetailsElement>('protected-fill').open).toBe(false)
  })
})
