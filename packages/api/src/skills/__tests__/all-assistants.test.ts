import { describe, it, expect, vi } from 'vitest'
import {
  materialiseAllAssistants,
  disableForAllAssistants,
} from '../all-assistants.js'

/**
 * The conversion between the `all_assistants` intent and materialised
 * `workspace_skill_enablement` rows.
 *
 * Spec: docs/architecture/engine/skill-system.md → "Per-assistant enablement".
 */
describe('[COMP:api/skill-all-assistants] all_assistants conversion', () => {
  function harness(allAssistants: boolean) {
    const calls: string[] = []
    const enable = vi.fn(async (_s: string, a: string) => {
      calls.push(`enable:${a}`)
      return {} as never
    })
    const disableAll = vi.fn(async () => {
      calls.push('disableAll')
      return 0
    })
    const setAllAssistants = vi.fn(async () => {
      calls.push('setAllAssistants')
    })
    return {
      calls,
      enable,
      disableAll,
      setAllAssistants,
      skill: { rowId: 'row-1', workspaceId: 'ws-1', allAssistants },
      enablementStore: { enable, disableAll } as never,
      workspaceSkillStore: { setAllAssistants } as never,
    }
  }

  it('is a no-op on an unflagged skill, and does not even list assistants', async () => {
    const h = harness(false)
    const listAssistantIds = vi.fn(async () => ['a-1'])

    const result = await materialiseAllAssistants({
      skill: h.skill,
      actingUserId: 'u-1',
      listAssistantIds,
      enablementStore: h.enablementStore,
      workspaceSkillStore: h.workspaceSkillStore,
    })

    expect(result).toEqual({ converted: false, enabledAssistantIds: [] })
    // A no-op must not cost a query — the caller's own row diff handles it.
    expect(listAssistantIds).not.toHaveBeenCalled()
    expect(h.calls).toEqual([])
  })

  it('materialises a row for every assistant, then clears the flag', async () => {
    const h = harness(true)

    const result = await materialiseAllAssistants({
      skill: h.skill,
      actingUserId: 'u-1',
      listAssistantIds: async () => ['a-1', 'a-2', 'a-3'],
      enablementStore: h.enablementStore,
      workspaceSkillStore: h.workspaceSkillStore,
    })

    expect(result.converted).toBe(true)
    expect(result.enabledAssistantIds).toEqual(['a-1', 'a-2', 'a-3'])
    // Order is the invariant: a crash mid-way must leave the skill offered to
    // MORE assistants (flag still set), never fewer.
    expect(h.calls).toEqual([
      'enable:a-1',
      'enable:a-2',
      'enable:a-3',
      'setAllAssistants',
    ])
    expect(h.setAllAssistants).toHaveBeenCalledWith('u-1', 'ws-1', 'row-1', false)
  })

  it('leaves the excluded assistant without a row — the turn-one-off case', async () => {
    const h = harness(true)

    const result = await materialiseAllAssistants({
      skill: h.skill,
      actingUserId: 'u-1',
      listAssistantIds: async () => ['a-1', 'a-2', 'a-3'],
      enablementStore: h.enablementStore,
      workspaceSkillStore: h.workspaceSkillStore,
      exclude: ['a-2'],
    })

    expect(result.enabledAssistantIds).toEqual(['a-1', 'a-3'])
    expect(h.enable).toHaveBeenCalledTimes(2)
    expect(h.enable).not.toHaveBeenCalledWith('row-1', 'a-2', 'u-1')
    // The flag is gone, so row-absence means "off" again for a-2.
    expect(h.setAllAssistants).toHaveBeenCalledWith('u-1', 'ws-1', 'row-1', false)
  })

  it('disable-everywhere clears the flag BEFORE dropping rows', async () => {
    const h = harness(true)

    await disableForAllAssistants({
      skill: h.skill,
      actingUserId: 'u-1',
      enablementStore: h.enablementStore,
      workspaceSkillStore: h.workspaceSkillStore,
    })

    // Without the flag write this is the silent-success bug: zero rows to
    // delete, flag still true, skill still offered to everyone.
    expect(h.calls).toEqual(['setAllAssistants', 'disableAll'])
  })

  it('disable-everywhere on an unflagged skill drops rows and writes no flag', async () => {
    const h = harness(false)

    await disableForAllAssistants({
      skill: h.skill,
      actingUserId: 'u-1',
      enablementStore: h.enablementStore,
      workspaceSkillStore: h.workspaceSkillStore,
    })

    expect(h.calls).toEqual(['disableAll'])
    expect(h.setAllAssistants).not.toHaveBeenCalled()
  })
})
