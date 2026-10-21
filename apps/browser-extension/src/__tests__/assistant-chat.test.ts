import { describe, expect, it, vi } from 'vitest'
import { installAssistantChat, pageEvidence, pairedChatIdentity } from '../assistant-chat.js'
import { decodePng, roundIcon } from '../../scripts/round-icons.mjs'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeSourceHash } from '../../scripts/build-hash.mjs'
import { readablePageNames } from '@use-brian/browser-control/snapshot.js'

const identity = { userId: 'user-1', workspaceId: 'workspace-1', browserProfileId: 'profile-1' }
function token(extra = {}) { return `header.${btoa(JSON.stringify({ ...identity, kind: 'browser-ext-session', exp: 2000, ...extra }))}.signature` }
function event() { const listeners: Array<(...args: any[]) => void> = []; return { addListener: (f: (...args: any[]) => void) => listeners.push(f), emit: (...args: any[]) => listeners.forEach(f => f(...args)) } }
function harness() {
  const external = event(), internal = event()
  vi.stubGlobal('chrome', { runtime: { id: 'extension-id', getURL: (p: string) => `chrome-extension://extension-id/${p}`, onConnectExternal: external, onConnect: internal }, storage: { onChanged: event() } })
  const deps = { identity: async () => identity, ready: () => true, readPage: vi.fn(), pageStillCurrent: async () => true, stop: vi.fn(async () => {}), matches: () => ['https://app.usebrian.ai/*'] }
  installAssistantChat(deps)
  const port = (name: string, sender: object) => ({ name, sender, postMessage: vi.fn(), disconnect: vi.fn(), onMessage: event(), onDisconnect: event() })
  const broker = port('brian-assistant-chat', { origin: 'https://app.usebrian.ai', frameId: 0 })
  const panel = port('brian-assistant-panel', { id: 'extension-id', url: 'chrome-extension://extension-id/sidepanel.html' })
  return { external, internal, deps, broker, panel }
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

describe('[COMP:ext/assistant-chat] paired assistant transport and evidence', () => {
  it('rejects expired, malformed and wrong-kind pairing hints', () => {
    expect(pairedChatIdentity(token(), 1000_000)).toEqual(identity)
    expect(pairedChatIdentity(token(), 2000_000)).toBeNull()
    expect(pairedChatIdentity(token({ kind: 'access' }), 1000)).toBeNull()
    expect(pairedChatIdentity('bad')).toBeNull()
  })
  it('bounds website evidence and omits all editable values', () => {
    const page = pageEvidence({ url: 'https://example.com', title: 'Example', nodes: [{ role: 'textbox', name: 'Private field' }, { role: 'StaticText', name: 'a'.repeat(15000) }] })
    expect(page.text).toHaveLength(12000)
    expect(page.text).not.toContain('Private')
  })
  it('excludes static text nested beneath editable controls and contenteditable regions', () => {
    const nodes = readablePageNames([
      { nodeId: '1', role: { value: 'textbox' }, childIds: ['2'] },
      { nodeId: '2', role: { value: 'StaticText' }, name: { value: 'Private typed text' } },
      { nodeId: '3', role: { value: 'generic' }, properties: [{ name: 'editable', value: { value: 'richtext' } }], childIds: ['4'] },
      { nodeId: '4', role: { value: 'StaticText' }, name: { value: 'Private draft' } },
      { nodeId: '5', role: { value: 'StaticText' }, name: { value: 'Public article text' } },
    ])
    expect(nodes).toEqual([{ role: 'StaticText', name: 'Public article text' }])
  })
  it('refuses third-party and embedded-frame connections', () => {
    const h = harness(); h.broker.sender.origin = 'https://other.example'
    h.external.emit(h.broker); expect(h.broker.disconnect).toHaveBeenCalled()
    const j = harness(); j.broker.sender.frameId = 2; j.external.emit(j.broker); expect(j.broker.disconnect).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
  it('does not publish another workspace roster or forward a send to it', async () => {
    const h = harness(); h.external.emit(h.broker)
    h.broker.onMessage.emit({ type: 'hello', ...identity, workspaceId: 'other', assistants: [{ id: 'assistant', name: 'Assistant' }] })
    h.internal.emit(h.panel); await settle()
    expect(h.panel.postMessage).toHaveBeenCalledWith({ type: 'status', connected: false })
    h.panel.onMessage.emit({ type: 'send', id: 'request', text: 'Hello' }); await settle()
    expect(h.broker.postMessage).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
  it('forwards only to the paired identity and stops browser control on disconnect', async () => {
    const h = harness(); h.external.emit(h.broker)
    h.broker.onMessage.emit({ type: 'hello', ...identity, assistants: [] })
    h.internal.emit(h.panel); await settle()
    h.panel.onMessage.emit({ type: 'send', id: 'request', text: 'Hello', assistantId: 'assistant' }); await settle()
    expect(h.broker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'send', browserProfileId: identity.browserProfileId }))
    h.broker.onDisconnect.emit(); expect(h.deps.stop).toHaveBeenCalled()
    expect(h.panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'failure', code: 'app_disconnected' }))
    vi.unstubAllGlobals()
  })
  it('requires a fresh explicit capture before sharing page content', async () => {
    const h = harness(); h.external.emit(h.broker); h.broker.onMessage.emit({ type: 'hello', ...identity, assistants: [] }); h.internal.emit(h.panel)
    h.panel.onMessage.emit({ type: 'send', id: 'request', text: 'Hello', page: { capturedAt: 'invented' } }); await settle()
    expect(h.broker.postMessage).not.toHaveBeenCalled()
    expect(h.panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'failure', code: 'page_changed' }))
    vi.unstubAllGlobals()
  })
  it('Stop fences a send that is still awaiting admission', async () => {
    const h = harness(); h.external.emit(h.broker); h.broker.onMessage.emit({ type: 'hello', ...identity, assistants: [] }); h.internal.emit(h.panel); await settle()
    let release: (value: typeof identity) => void = () => {}
    const waiting = new Promise<typeof identity>(resolve => { release = resolve })
    h.deps.identity = () => waiting
    h.panel.onMessage.emit({ type: 'send', id: 'request', text: 'Hello' })
    h.panel.onMessage.emit({ type: 'stop' })
    release(identity); await settle()
    expect(h.broker.postMessage).not.toHaveBeenCalled()
    expect(h.deps.stop).toHaveBeenCalled()
    expect(h.panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'failure', code: 'stopped' }))
    vi.unstubAllGlobals()
  })
})

describe('[COMP:ext/assistant-chat] rounded extension artwork', () => {
  it('changes the build fingerprint when a packaged UI asset changes', () => {
    const temp = mkdtempSync(join(tmpdir(), 'extension-build-'))
    const app = join(temp, 'src/apps/browser-extension')
    try {
      for (const dir of ['src', 'static']) mkdirSync(join(app, dir), { recursive: true })
      mkdirSync(join(temp, 'src/packages/browser-control/src'), { recursive: true })
      writeFileSync(join(app, 'src/background.ts'), '// fixture')
      writeFileSync(join(app, 'static/manifest.json'), '{}')
      writeFileSync(join(app, 'static/sidepanel.css'), 'body { color: black }')
      const before = computeSourceHash(app)
      writeFileSync(join(app, 'static/sidepanel.css'), 'body { color: white }')
      expect(computeSourceHash(app)).not.toBe(before)
    } finally { rmSync(temp, { recursive: true, force: true }) }
  })
  it('has transparent corners and preserves the creature at every size', () => {
    for (const size of [16, 32, 48, 128]) {
      const bytes = readFileSync(new URL(`../../static/icon-${size}.png`, import.meta.url))
      const { pixels, width, height } = decodePng(bytes)
      expect([width, height]).toEqual([size, size])
      expect(pixels[3]).toBe(0)
      expect(pixels[(size * size - 1) * 4 + 3]).toBe(0)
      expect(pixels[(Math.floor(size / 2) * size + Math.floor(size / 2)) * 4 + 3]).toBe(255)
      expect(decodePng(roundIcon(bytes)).pixels).toEqual(pixels)
    }
  })
})
