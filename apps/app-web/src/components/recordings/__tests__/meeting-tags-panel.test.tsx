// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MeetingTagsPanel, MeetingTagRulesDialog, MeetingTagRulesMenuItem } from '../meeting-tags-panel'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { getDictionary } from '@/lib/i18n/dictionaries'

const mock = vi.hoisted(() => ({ command: vi.fn(), refresh: vi.fn(), data: null as any, pathname: '/folder' }))
vi.mock('next/navigation', () => ({ usePathname: () => mock.pathname }));
vi.mock('@/lib/api/meeting-tags', () => ({ meetingTags: mock.command }));
vi.mock('@/lib/surface-cache', () => ({ useCachedResource: () => ({ data: mock.data, refresh: mock.refresh }) }));
vi.mock('@/lib/surface-prefetch', () => ({ meetingTagsCacheKey: () => 'meeting-tags' }));
vi.mock('@/lib/i18n/client', () => ({ useT: () => getDictionary('en'), format: (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  mock.pathname = '/folder'
  mock.data = { folderId: 'folder', isFolder: false, tags: [], rules: [], suggestions: [] }
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks() })
const button = (name: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === name || item.getAttribute('aria-label') === name)!
const click = async (name: string) => { await act(async () => button(name).click()) }

describe('[COMP:app-web/meeting-tags] folder-owned rule settings', () => {
  it('keeps rules off notes and assigns nothing until the tag form is submitted', async () => {
    await act(async () => root.render(<MeetingTagsPanel workspaceId="ws" pageId="note" />))
    expect(host.textContent).toBe('Add tags')
    expect(document.querySelector('input')).toBeNull()
    await click('Add tags')
    expect(document.body.textContent).toContain('Tags on this meeting')
    expect(document.body.textContent).not.toContain('Folder rules')
    expect(document.body.textContent).not.toContain('Suggested rules')
    expect(document.querySelector('input')!.value).toBe('')
    expect(mock.command).not.toHaveBeenCalled()
    await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(mock.command).toHaveBeenCalledWith('ws', 'note', { kind: 'set-tags', tags: [] })
  })
  it('shows editable tag chips without rule controls even when rules exist', async () => {
    mock.data.tags = [{ name: 'Plans', source: 'manual' }]
    mock.data.rules = [{ id: 'rule', tag: 'Plans', phrases: ['roadmap'] }]
    await act(async () => root.render(<MeetingTagsPanel workspaceId="ws" pageId="note" />))
    expect(button('Edit tags').textContent).toContain('Plans')
    await click('Edit tags')
    expect(document.querySelector('input')!.value).toBe('Plans')
    expect(document.body.textContent).not.toContain('Required phrases')
  })
  it('keeps an empty folder quiet and exposes settings only from folder menus', async () => {
    mock.data.isFolder = true
    await act(async () => root.render(<MeetingTagsPanel workspaceId="ws" pageId="folder" />))
    expect(host.textContent).toBe('')
    const open = vi.fn()
    const menu = <DropdownMenu open><DropdownMenuTrigger render={<button>Menu</button>} /><DropdownMenuContent><MeetingTagRulesMenuItem workspaceId="ws" pageId="folder" onOpen={open} /></DropdownMenuContent></DropdownMenu>
    await act(async () => root.render(menu))
    const item = document.querySelector('[role="menuitem"]') as HTMLElement
    expect(item.textContent).toBe('Tag rules')
    await act(async () => item.click())
    expect(open).toHaveBeenCalledOnce()
    mock.data.isFolder = false
    await act(async () => root.render(<DropdownMenu open><DropdownMenuTrigger render={<button>Menu</button>} /><DropdownMenuContent><MeetingTagRulesMenuItem workspaceId="ws" pageId="note" onOpen={open} /></DropdownMenuContent></DropdownMenu>))
    expect(document.body.textContent).not.toContain('Tag rules')
  })
  it('opens suggestions in the folder panel and requires explicit acceptance or dismissal', async () => {
    mock.data = { folderId: 'folder', isFolder: true, tags: [], rules: [], suggestions: [{ id: 'proposal', tag: 'Plans', phrases: ['roadmap'], pageIds: ['one', 'two'] }] }
    await act(async () => root.render(<MeetingTagsPanel workspaceId="ws" pageId="folder" />))
    expect(host.textContent).toBe('Suggested rules (1)')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click('Suggested rules (1)')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('No active rules')
    expect(document.querySelectorAll('a')).toHaveLength(2)
    expect(mock.command).not.toHaveBeenCalled()
    await click('Accept rule')
    expect(mock.command).toHaveBeenCalledWith('ws', 'folder', { kind: 'accept-rule', id: 'proposal' })
    await click('Dismiss')
    expect(mock.command).toHaveBeenLastCalledWith('ws', 'folder', { kind: 'dismiss-rule', id: 'proposal' })
    await click('Close tag rules')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it('closes settings when navigating away without activating anything', async () => {
    mock.data.isFolder = true
    const change = vi.fn()
    await act(async () => root.render(<MeetingTagRulesDialog workspaceId="ws" pageId="folder" open onOpenChange={change} />))
    expect(change).not.toHaveBeenCalled()
    mock.pathname = '/other-note'
    await act(async () => root.render(<MeetingTagRulesDialog workspaceId="ws" pageId="folder" open onOpenChange={change} />))
    expect(change).toHaveBeenCalledWith(false)
    expect(mock.command).not.toHaveBeenCalled()
  })
})
