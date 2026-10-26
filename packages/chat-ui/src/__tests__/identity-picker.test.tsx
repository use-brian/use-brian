import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { IdentityAccountSection, IdentityWorkspaceSection } from '../IdentityPicker.js'
import { organizeWorkspacePicker, usesScalableWorkspacePicker } from '../workspace-picker.js'

const accounts = [{ id: 'u1', name: 'First account', email: 'first@example.com' }, { id: 'u2', name: 'Second account', email: 'second@example.com', avatarUrl: 'https://example.com/avatar.png' }]
const rows = [{ id: 'w1', name: 'First workspace', iconSeed: 42 }, { id: 'w2', name: 'Second workspace', iconSeed: 43 }]
describe('[COMP:chat-ui/identity-picker] shared account and workspace menu', () => {
  it('shows the active account with a disabled checkmarked row and labels the alternate account', () => {
    const html = renderToStaticMarkup(<IdentityAccountSection accounts={accounts} activeId="u1" onSwitch={() => {}} switchLabel={a => `Switch to ${a.email}`} />)
    expect(html).toMatch(/disabled="" aria-current="true"/)
    expect(html).toContain('aria-label="Switch to second@example.com"')
    expect(html).toContain('first@example.com'); expect(html).toContain('https://example.com/avatar.png')
    expect(html.match(/aria-current="true"/g)).toHaveLength(1)
  })
  it('preserves uploaded workspace pictures and the active row across both surfaces', () => {
    const html = renderToStaticMarkup(<IdentityWorkspaceSection workspaces={[rows[0], { ...rows[1], iconUrl: 'https://example.com/workspace.png' }]} activeId="w1" onSelect={() => {}} searchable={false} query="" onQueryChange={() => {}} searchLabel="Search workspaces" emptyLabel="No workspaces" />)
    expect(html).toContain('aria-current="true"'); expect(html).toContain('First workspace')
    expect(html).toContain('https://example.com/workspace.png'); expect(html).not.toContain('type="search"')
  })
  it('uses the same scale threshold, pinned ordering and localized search empty state', () => {
    expect(usesScalableWorkspacePicker(5)).toBe(false); expect(usesScalableWorkspacePicker(6)).toBe(true)
    const ordered = organizeWorkspacePicker([{ ...rows[0], pickerHiddenAt: '2026-10-21' }, { ...rows[1], pickerPinnedAt: '2026-10-21' }], '')
    expect(ordered.pinned.map(w => w.id)).toEqual(['w2']); expect(ordered.hidden.map(w => w.id)).toEqual(['w1'])
    const html = renderToStaticMarkup(<IdentityWorkspaceSection workspaces={[]} activeId="w1" onSelect={() => {}} searchable query="missing" onQueryChange={() => {}} searchLabel="Search workspaces" emptyLabel="No matching workspaces" />)
    expect(html).toContain('flex shrink-0 flex-col'); expect(html).toContain('type="search"'); expect(html).toContain('value="missing"'); expect(html).toContain('No matching workspaces')
  })
})
