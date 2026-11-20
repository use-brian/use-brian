import { describe, expect, it, vi } from 'vitest'
import type { CustomPageTemplate } from '@use-brian/core/doc/custom-template-types.js'
import { InvalidRecordingBlueprintError, resolveRecordingBlueprint } from '../resolve-blueprint.js'

const id = '00000000-0000-4000-8000-000000000001'
const template: CustomPageTemplate = {
  id, workspaceId: 'workspace', name: 'Meeting notes',
  createdBy: 'actor', description: null, icon: null, category: 'meeting', blocks: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  extraction: { fields: [{ key: 'summary', heading: 'Summary', instruction: 'Summarize', type: 'markdown', required: false }], capture: [] },
}
const input = { userId: 'actor', workspaceId: 'workspace' }
function store() {
  return { getById: vi.fn(async () => template), list: vi.fn(async () => [template]) }
}

describe('[COMP:recordings/blueprint-resolution] recording blueprint selection', () => {
  it('resolves an installed UUID with the acting user and no roster lookup', async () => {
    const deps = store()
    expect(await resolveRecordingBlueprint(deps, { ...input, selection: ` ${id} ` })).toEqual(template)
    expect(deps.getById).toHaveBeenCalledWith('actor', id)
    expect(deps.list).not.toHaveBeenCalled()
  })

  it.each(['meeting-notes', ' MEETING NOTES ', 'Meeting_notes', 'meeting  notes'])('resolves %s without querying a UUID column with text', async (selection) => {
    const deps = store()
    expect(await resolveRecordingBlueprint(deps, { ...input, selection })).toEqual(template)
    expect(deps.getById).not.toHaveBeenCalled()
    expect(deps.list).toHaveBeenCalledWith('actor', 'workspace')
  })

  it('resolves the actual localized name, not a permanent catalog alias', async () => {
    const deps = store()
    deps.list.mockResolvedValue([{ ...template, name: '會議記錄' }])
    expect((await resolveRecordingBlueprint(deps, { ...input, selection: '會議記錄' })).id).toBe(id)
    await expect(resolveRecordingBlueprint(deps, { ...input, selection: 'meeting-notes' })).rejects.toThrow(InvalidRecordingBlueprintError)
  })

  it.each([
    { ...template, extraction: null },
    { ...template, workspaceId: 'other-workspace' },
    null,
  ])('rejects an inaccessible, wrong-workspace or non-blueprint UUID', async (row) => {
    const deps = { ...store(), getById: vi.fn(async () => row) }
    await expect(resolveRecordingBlueprint(deps, { ...input, selection: id })).rejects.toThrow(/listBlueprints/)
  })

  it('never selects a plain template, another workspace, or a partial name match', async () => {
    const deps = store()
    deps.list.mockResolvedValue([
      { ...template, extraction: null },
      { ...template, workspaceId: 'other-workspace' },
      { ...template, name: 'Meeting notes archive' },
    ])
    await expect(resolveRecordingBlueprint(deps, { ...input, selection: 'meeting-notes' })).rejects.toThrow(/not an accessible blueprint/)
  })

  it.each(['Meeting notes', 'meeting-notes'])('rejects ambiguous %s instead of choosing the newest copy', async (selection) => {
    const deps = store()
    deps.list.mockResolvedValue([template, { ...template, id: '00000000-0000-4000-8000-000000000002' }])
    await expect(resolveRecordingBlueprint(deps, { ...input, selection })).rejects.toThrow(/ambiguous/)
  })

  it('prefers a unique exact name over a normalized spelling', async () => {
    const deps = store()
    deps.list.mockResolvedValue([template, { ...template, id: 'other', name: 'Meeting-notes' }])
    expect((await resolveRecordingBlueprint(deps, { ...input, selection: 'Meeting notes' })).id).toBe(id)
  })

  it('does not disguise a database outage as a missing blueprint', async () => {
    const deps = store()
    deps.list.mockRejectedValue(new Error('database unavailable'))
    await expect(resolveRecordingBlueprint(deps, { ...input, selection: 'meeting-notes' })).rejects.toThrow('database unavailable')
  })
})
