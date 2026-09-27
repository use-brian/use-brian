// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeetingTagsPanel } from '../meeting-tags-panel'
import { getDictionary } from '@/lib/i18n/dictionaries'

const mock = vi.hoisted(() => ({ command: vi.fn(), refresh: vi.fn(), data: null as any }))
vi.mock('@/lib/api/meeting-tags', () => ({ meetingTags: mock.command }));
vi.mock('@/lib/surface-cache', () => ({ useCachedResource: () => ({ data: mock.data, refresh: mock.refresh }) }));
vi.mock('@/lib/surface-prefetch', () => ({ meetingTagsCacheKey: () => 'meeting-tags' }));
vi.mock('@/lib/i18n/client', () => ({ useT: () => getDictionary('en'), format: (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const host = document.createElement('div')
let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.clearAllMocks() })

describe('[COMP:app-web/meeting-tags] manual approval UI', () => {
  it('shows no default tags and never creates or accepts a rule on mount', async () => {
    mock.data = { folderId: 'folder', isFolder: false, tags: [], rules: [], suggestions: [] }
    root = createRoot(host)
    await act(async () => root!.render(<MeetingTagsPanel workspaceId="ws" pageId="note" />))
    expect(host.textContent).toContain('No tags are added by default')
    expect(host.textContent).toContain('No active rules')
    expect(host.querySelector('input')!.value).toBe('')
    expect(mock.command).not.toHaveBeenCalled()
  })
  it('activates a suggestion only after Accept, and can dismiss independently', async () => {
    mock.data = { folderId: 'folder', isFolder: true, tags: [], rules: [], suggestions: [{ id: 'proposal', tag: 'Plans', phrases: ['roadmap'], pageIds: ['one', 'two'] }] }
    root = createRoot(host)
    await act(async () => root!.render(<MeetingTagsPanel workspaceId="ws" pageId="folder" />))
    expect(mock.command).not.toHaveBeenCalled()
    expect(host.querySelectorAll('a')).toHaveLength(2)
    const accept = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Accept rule')!
    await act(async () => accept.click())
    expect(mock.command).toHaveBeenCalledWith('ws', 'folder', { kind: 'accept-rule', id: 'proposal' })
    const dismiss = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Dismiss')!
    await act(async () => dismiss.click())
    expect(mock.command).toHaveBeenLastCalledWith('ws', 'folder', { kind: 'dismiss-rule', id: 'proposal' })
  })
})
