// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n/client'
import { en } from '@/lib/i18n/dictionaries/en'
import type { Dictionary } from '@/lib/i18n/dictionaries'
import type { PersonalDisplayHistory } from '@/lib/api/sessions'
const mocks = vi.hoisted(() => ({ read: vi.fn(), actor: 'owner', listener: null as null | ((value: { id: string } | null) => void) }))
vi.mock('@/lib/api/sessions', () => ({ readPersonalDisplayHistory: mocks.read }))
vi.mock('@/lib/user', () => ({ getUserInfo: () => ({ id: mocks.actor }), subscribeUserInfo: (fn: typeof mocks.listener) => { mocks.listener = fn; return () => { mocks.listener = null } } }))
import { ChatDisplayHistoryRow, ChatDisplayHistoryStatus, mergeDisplayTimeline, usePersonalDisplayHistory } from '../chat-display-history'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root, container: HTMLDivElement
const row = (sequence: number, available = true): PersonalDisplayHistory['rows'][number] => ({ id: `row-${sequence}`, sequence, role: sequence % 2 ? 'user' : 'assistant',
  timestamp: `2026-01-01T00:00:0${sequence}Z`, available, text: available ? `Saved ${sequence} <img src="https://example.invalid/image">` : null })
const page: PersonalDisplayHistory = { sessionId: 'chat', workspaceId: 'workspace', mode: 'personal_transcript_display', rows: [row(1), row(2), row(3), row(4)], nextSequence: null }
const canonical = [1, 3].map(sequence => ({ id: `row-${sequence}`, timestamp: new Date(row(sequence).timestamp), text: `Canonical ${sequence}` }))
let latest: ReturnType<typeof usePersonalDisplayHistory>
function Harness({ sessionId = 'chat', enabled = true, messages = canonical }: { sessionId?: string; enabled?: boolean; messages?: typeof canonical }) {
  const history = usePersonalDisplayHistory('workspace', sessionId, enabled); latest = history
  const timeline = mergeDisplayTimeline(messages, history.rows)
  return <><div data-canonical-count={messages.length} />{timeline.map(entry => entry.historicalDisplayOnly
    ? <ChatDisplayHistoryRow key={entry.row.id} row={entry.row} />
    : <article key={entry.message.id} data-message-id={entry.message.id}>{entry.message.text}<button>Reply</button></article>)}
    <ChatDisplayHistoryStatus history={history} hasHistoricalRows={timeline.some(entry => entry.historicalDisplayOnly)} /></>
}
async function render(props: Parameters<typeof Harness>[0] = {}) {
  await act(async () => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><Harness {...props} /></I18nProvider>))
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
beforeEach(() => { vi.clearAllMocks(); mocks.actor = 'owner'; mocks.read.mockResolvedValue(page); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
describe('[COMP:app-web/chat-display-history] independent human timeline', () => {
  it('fills missing replies after a successful partial canonical read without adding semantic actions or state', async () => {
    await render()
    expect([...container.querySelectorAll('article')].map(element => element.textContent)).toEqual([
      'Canonical 1Reply', expect.stringContaining('Saved 2'), 'Canonical 3Reply', expect.stringContaining('Saved 4'),
    ])
    expect(container.querySelector('[data-canonical-count]')?.getAttribute('data-canonical-count')).toBe('2')
    expect(container.querySelectorAll('[data-message-id]')).toHaveLength(2)
    for (const historical of container.querySelectorAll('[data-historical-display-only]')) expect(historical.querySelector('button,a,img,iframe,textarea,[data-message-id]')).toBeNull()
    expect(canonical).toHaveLength(2)
    expect(container.textContent).toContain(en.chatApp.displayHistory.notice)
  })
  it('keeps canonical objects, action indexes and coalesced admission identities', () => {
    const final = { ...canonical[0], id: 'row-4' }
    const entries = mergeDisplayTimeline([canonical[0], final], page.rows, new Set(['row-1', 'row-2', 'row-3', 'row-4']))
    expect(entries).toEqual([{ historicalDisplayOnly: false, message: canonical[0], canonicalIndex: 0 }, { historicalDisplayOnly: false, message: final, canonicalIndex: 1 }])
    expect(entries[1].historicalDisplayOnly ? null : entries[1].message).toBe(final)
  })
  it('orders equal-timestamp historical rows by saved sequence and keeps unavailable markers', async () => {
    mocks.read.mockResolvedValue({ ...page, rows: [row(1), { ...row(2, false), timestamp: row(1).timestamp }, row(3), row(4)] })
    await render()
    expect(container.querySelectorAll('article')[1].textContent).toContain(en.chatApp.displayHistory.unavailableMessage)
    expect(container.querySelectorAll('article')[1].textContent).not.toContain('Saved 2')
  })
  it('can display separately admitted history when canonical model history is unavailable', async () => {
    await render({ messages: [] })
    expect(container.querySelectorAll('[data-historical-display-only]')).toHaveLength(4)
    expect(container.querySelectorAll('[data-message-id]')).toHaveLength(0)
    await act(async () => latest.invalidate())
    expect(container.textContent).not.toContain('Saved 2')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(en.chatApp.displayHistory.failed)
  })
  it('revalidates on transcript refresh, clears denied text, and reloads on retry', async () => {
    await render(); mocks.read.mockRejectedValueOnce(new Error('denied'))
    await act(async () => latest.refresh())
    expect(container.textContent).not.toContain('Saved 2')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === en.chatApp.displayHistory.retry)!.click())
    expect(container.textContent).toContain('Saved 2')
  })
  it('loads bounded pages and rereads them on focus', async () => {
    mocks.read.mockResolvedValueOnce({ ...page, rows: page.rows.slice(0, 2), nextSequence: 2 })
    await render()
    mocks.read.mockResolvedValueOnce({ ...page, rows: page.rows.slice(2) })
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === en.chatApp.displayHistory.more)!.click())
    expect(mocks.read.mock.calls[1][2]).toBe(2)
    expect(container.querySelectorAll('[data-historical-display-only]')).toHaveLength(2)
    mocks.read.mockResolvedValueOnce({ ...page, rows: page.rows.slice(0, 2), nextSequence: 2 }).mockResolvedValueOnce({ ...page, rows: page.rows.slice(2) })
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(mocks.read.mock.calls.slice(-2).map(args => args[2])).toEqual([0, 2])
  })
  it('aborts on chat and actor switches and ignores late old history', async () => {
    const old = deferred<PersonalDisplayHistory>(); mocks.read.mockReturnValueOnce(old.promise)
    await render(); const signal = mocks.read.mock.calls[0][3] as AbortSignal
    mocks.read.mockResolvedValueOnce({ ...page, sessionId: 'next', rows: [] })
    await render({ sessionId: 'next' }); expect(signal.aborted).toBe(true)
    await act(async () => old.resolve(page)); expect(container.textContent).not.toContain('Saved 2')
    await render(); expect(container.textContent).toContain('Saved 2')
    mocks.read.mockRejectedValueOnce(new Error('denied'))
    await act(async () => { mocks.actor = 'other'; mocks.listener?.({ id: 'other' }) })
    expect(container.textContent).not.toContain('Saved 2')
  })
  it('revalidates only the matching workspace event and drops old bytes while checking access', async () => {
    await render()
    await act(async () => window.dispatchEvent(new CustomEvent('sidan:chat-sessions-refresh', { detail: { workspaceId: 'other' } })))
    expect(mocks.read).toHaveBeenCalledTimes(1)
    const refresh = deferred<PersonalDisplayHistory>(); mocks.read.mockReturnValueOnce(refresh.promise)
    await act(async () => window.dispatchEvent(new CustomEvent('sidan:chat-sessions-refresh', { detail: { workspaceId: 'workspace' } })))
    expect(container.textContent).not.toContain('Saved 2')
    await act(async () => refresh.resolve(page)); expect(container.textContent).toContain('Saved 2')
  })
  it('makes no display request for an ineligible conversation', async () => {
    await render({ enabled: false }); expect(mocks.read).not.toHaveBeenCalled()
    expect(container.querySelectorAll('[data-historical-display-only]')).toHaveLength(0)
  })
})
