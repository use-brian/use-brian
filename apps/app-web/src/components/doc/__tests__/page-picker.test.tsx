// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ current: true }))
const pages = [{ kind: 'page' as const, id: 'page-a', title: 'Current plan' }]
vi.mock('@/lib/use-workspace-directory', () => ({ useWorkspacePageDirectory: () => pages }))
vi.mock('@/lib/api/mentions', () => ({ isCurrentDirectoryPage: () => state.current }))
vi.mock('@/lib/viewport', () => ({ isPhoneViewport: () => true }))

import { I18nProvider } from '@/lib/i18n/client'
import { en } from '@/lib/i18n/dictionaries/en'
import { PagePicker } from '../page-picker'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('[COMP:app-web/page-picker] current page-directory selection', () => {
  let root: Root, host: HTMLDivElement
  const onPick = vi.fn(), onClose = vi.fn()

  beforeEach(async () => {
    state.current = true
    vi.clearAllMocks()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root.render(
      <I18nProvider locale="en" dict={en}>
        <PagePicker workspaceId="workspace-a" position={{ top: 10, left: 10 }} onPick={onPick} onClose={onClose} />
      </I18nProvider>,
    ))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('commits a mouse or keyboard selection only while the originating read is current', () => {
    const button = host.querySelector<HTMLButtonElement>('[data-page-id="page-a"]')!
    act(() => button.click())
    expect(onPick).toHaveBeenCalledWith(pages[0])

    onPick.mockClear()
    state.current = false
    act(() => button.click())
    expect(onPick).not.toHaveBeenCalled()

    const input = host.querySelector<HTMLInputElement>('input')!
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onPick).not.toHaveBeenCalled()
  })
})
