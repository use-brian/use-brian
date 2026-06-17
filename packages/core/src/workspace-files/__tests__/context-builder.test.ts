import { describe, it, expect } from 'vitest'
import { buildWorkspaceFilesContext } from '../context-builder.js'
import type { WorkspaceFileIndexRow } from '../types.js'

function row(partial: Partial<WorkspaceFileIndexRow>): WorkspaceFileIndexRow {
  return {
    id: partial.id ?? 'id',
    workspaceId: partial.workspaceId ?? 'workspace_1',
    path: partial.path ?? '/file.md',
    parentPath: partial.parentPath ?? '/',
    name: partial.name ?? 'file.md',
    title: partial.title ?? null,
    summary: partial.summary ?? null,
    mime: partial.mime ?? 'text/markdown',
    sizeBytes: partial.sizeBytes ?? 0,
    tags: partial.tags ?? [],
    sensitivity: partial.sensitivity ?? 'internal',
    updatedAt: partial.updatedAt ?? new Date('2026-05-09T00:00:00Z'),
  }
}

describe('[COMP:files/prompt-context] buildWorkspaceFilesContext', () => {
  it('emits a fallback body when no rows', () => {
    const out = buildWorkspaceFilesContext([])
    expect(out).toContain('# Workspace Files')
    expect(out).toContain('No files yet')
  })

  it('renders title/name + mime + summary', () => {
    const out = buildWorkspaceFilesContext([
      row({ path: '/notes.md', name: 'notes.md', title: 'Sprint notes', summary: 'Q1 retro themes' }),
    ])
    expect(out).toContain('# Workspace Files')
    expect(out).toContain('/notes.md · Sprint notes · text/markdown')
    expect(out).toContain('Q1 retro themes')
  })

  it('falls back to filename when title is null', () => {
    const out = buildWorkspaceFilesContext([
      row({ path: '/raw.md', name: 'raw.md', title: null }),
    ])
    expect(out).toContain('/raw.md · raw.md · text/markdown')
  })

  it('groups rows by parent_path in alphabetical folder order', () => {
    const out = buildWorkspaceFilesContext([
      row({ path: '/reports/q1.md', parentPath: '/reports', name: 'q1.md', title: 'Q1' }),
      row({ path: '/inbox/today.md', parentPath: '/inbox', name: 'today.md', title: 'Today' }),
      row({ path: '/root.md', parentPath: '/', name: 'root.md', title: 'Root' }),
    ])
    const inboxIdx = out.indexOf('/inbox')
    const reportsIdx = out.indexOf('/reports')
    const rootIdx = out.indexOf('\n/\n')
    expect(rootIdx).toBeLessThan(inboxIdx)
    expect(inboxIdx).toBeLessThan(reportsIdx)
  })
})
