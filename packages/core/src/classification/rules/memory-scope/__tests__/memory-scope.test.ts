import { describe, expect, it } from 'vitest'

import { decideMemoryScope } from '../index.js'

describe('[COMP:classification/memory-scope] decideMemoryScope', () => {
  it('app assistant + workspaceId defaults to team', () => {
    const d = decideMemoryScope({ assistantKind: 'app', workspaceId: 'ws-1' })
    expect(d.scope).toBe('team')
    expect(d.ruleId).toBe('memory-scope-app-assistant-team-default')
  })

  it('personal assistant defaults to user', () => {
    const d = decideMemoryScope({ assistantKind: 'standard', workspaceId: 'ws-1' })
    expect(d.scope).toBe('user')
    expect(d.ruleId).toBe('memory-scope-personal-assistant-user-default')
  })

  it('app assistant WITHOUT workspaceId defaults to user', () => {
    const d = decideMemoryScope({ assistantKind: 'app', workspaceId: null })
    expect(d.scope).toBe('user')
  })

  it('confidential + emitted team → forced user', () => {
    const d = decideMemoryScope({
      assistantKind: 'app',
      workspaceId: 'ws-1',
      sensitivity: 'confidential',
      emittedScope: 'team',
    })
    expect(d.scope).toBe('user')
    expect(d.ruleId).toBe('memory-scope-confidential-blocks-team')
    expect(d.forced).toBe(true)
  })

  it('emitted team without workspaceId → forced user', () => {
    const d = decideMemoryScope({
      assistantKind: 'standard',
      workspaceId: null,
      emittedScope: 'team',
    })
    expect(d.scope).toBe('user')
    expect(d.ruleId).toBe('memory-scope-no-workspace-blocks-team')
    expect(d.forced).toBe(true)
  })

  it('emitted user passes through unchanged', () => {
    const d = decideMemoryScope({
      assistantKind: 'standard',
      workspaceId: 'ws-1',
      emittedScope: 'user',
    })
    expect(d.scope).toBe('user')
    expect(d.forced).toBe(false)
  })
})
