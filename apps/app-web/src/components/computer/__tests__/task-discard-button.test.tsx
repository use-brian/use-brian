// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
const mocks = vi.hoisted(() => ({ confirm: vi.fn(), discard: vi.fn() }))
vi.mock('@/components/ui/confirm-dialog', () => ({ confirmDialog: mocks.confirm }))
vi.mock('@/lib/api/computer', () => ({ discardComputerTask: mocks.discard }))
vi.mock('@/lib/i18n/client', async () => {
  const { en } = await import('@/lib/i18n/dictionaries/en')
  return { useT: () => en }
})
import { TaskDiscardButton } from '../task-discard-button'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
describe('[COMP:app-web/task-discard] unavailable-task recovery control', () => {
  let root: Root; let host: HTMLDivElement
  const done = vi.fn()
  beforeEach(async () => {
    vi.clearAllMocks(); mocks.confirm.mockResolvedValue(true); mocks.discard.mockResolvedValue(true)
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<TaskDiscardButton sessionId="session-1" workspaceId="workspace-1" onDiscarded={done} />))
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  const click = () => act(async () => host.querySelector('button')!.click())
  it('requires confirmation and sends only session/workspace for an unavailable task', async () => {
    mocks.confirm.mockResolvedValueOnce(false)
    await click(); expect(mocks.discard).not.toHaveBeenCalled()
    await click(); expect(mocks.discard).toHaveBeenCalledWith('session-1', 'workspace-1')
    expect(mocks.confirm.mock.calls[0]?.[0].description).toContain('will not be saved')
    expect(done).toHaveBeenCalledOnce()
  })
  it('keeps the recovery action and shows uncertainty instead of navigating on failure', async () => {
    mocks.discard.mockResolvedValueOnce(false)
    await click(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be confirmed')
    expect(done).not.toHaveBeenCalled()
    await click(); expect(done).toHaveBeenCalledOnce()
  })
  it('disables duplicate submissions while the acknowledgement is pending', async () => {
    let finish!: (ok: boolean) => void
    mocks.discard.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve }))
    await click(); await click()
    expect(host.querySelector('button')!.disabled).toBe(true)
    expect(mocks.discard).toHaveBeenCalledOnce()
    await act(async () => finish(true))
    expect(done).toHaveBeenCalledOnce()
  })
})
