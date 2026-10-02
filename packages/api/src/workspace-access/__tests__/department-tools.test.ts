import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@use-brian/core'
import { createDepartmentTools } from '../department-tools.js'
import type { DepartmentStore } from '../../db/department-store.js'

const W = '00000000-0000-4000-8000-000000000100'
const D = '00000000-0000-4000-8000-000000000d01'
const U = '00000000-0000-4000-8000-000000000a03'
const ctx = { workspaceId: W, workspaceActorUserId: U } as unknown as ToolContext

function tools(overrides: Partial<DepartmentStore> = {}) {
  const store = {
    directory: vi.fn().mockResolvedValue([]), homes: vi.fn().mockResolvedValue([]),
    inWorkspace: vi.fn(async (_a: string, _w: string, id: string) => id === D),
    listEdges: vi.fn().mockResolvedValue([]), setEdge: vi.fn().mockResolvedValue(2), removeEdge: vi.fn().mockResolvedValue(2),
    addOwner: vi.fn().mockResolvedValue(2), removeOwner: vi.fn().mockResolvedValue(2), breakGlass: vi.fn().mockResolvedValue(2),
    setHome: vi.fn().mockResolvedValue(undefined), ...overrides,
  } as unknown as DepartmentStore
  const [inspect, manage] = createDepartmentTools(store)
  return { inspect, manage, store }
}

describe('[COMP:access/department-tools] Brian department tools', () => {
  it('manageDepartments always asks for confirmation and never allows persistent approval', () => {
    const { manage } = tools()
    expect(manage.name).toBe('manageDepartments')
    expect(manage.requiresConfirmation).toBe(true)
    expect(manage.allowPersistentApproval).toBe(false)
  })

  it('describes each change in plain words before it runs', async () => {
    const { manage } = tools()
    const lines = await manage.describeConfirmation!({ action: 'break_glass', departmentId: D, reason: 'Owner left' } as never, ctx)
    expect((lines ?? []).join(' ')).toContain('Its members will see this')
  })

  it('runs the same store command the screen does, as the verified person', async () => {
    const { manage, store } = tools()
    const result = await manage.execute({ action: 'set_member', departmentId: D, principal: { kind: 'assistant', id: U }, clearance: 'internal' } as never, ctx)
    expect(result).toEqual({ data: { revision: 2 } })
    expect(store.setEdge).toHaveBeenCalledWith(U, D, { kind: 'assistant', id: U }, 'internal', null, undefined)
  })

  it('refuses keys, public lanes and system reads, and hides departments the caller cannot see', async () => {
    const { manage, inspect, store } = tools()
    for (const extra of [{ programmaticPrincipal: {} }, { systemRead: true }, { workspaceActorUserId: undefined }]) {
      expect(await manage.execute({ action: 'remove_member', departmentId: D, principal: { kind: 'user', id: U } } as never, { ...ctx, ...extra } as never))
        .toEqual({ isError: true, data: { error: 'department_owner_required' } })
    }
    expect(await inspect.execute({ departmentId: '00000000-0000-4000-8000-000000000d04' } as never, ctx))
      .toEqual({ isError: true, data: { error: 'department_not_found' } })
    expect(store.removeEdge).not.toHaveBeenCalled()
  })
})
