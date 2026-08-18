/**
 * [COMP:doc/tools] `getBlock` failure copy.
 *
 * `getBlock` has three ways to fail and each one used to end the model's
 * search rather than redirect it:
 *
 *   - the PAGE misses      → `pageNotFound` (already the reference shape)
 *   - the BLOCK misses     → an id that changed under the model; the outline
 *                            is where a current one comes from
 *   - the block is CORRUPT → a stored-data fault, not a bad argument, and the
 *                            old copy pasted `ZodError.message` (a raw JSON
 *                            dump of the issue array) into the tool result
 *
 * The last one is why this suite exists: a validation failure now renders
 * through `formatToolError` (compact `path: message` lines) and says outright
 * that the arguments are fine and the same id will keep failing, so the model
 * routes around the block instead of re-sending it.
 *
 * Spec: `docs/architecture/engine/tool-executor.md` → "Failure copy".
 */

import { describe, expect, it, vi } from 'vitest'
import type { SavedViewStore } from '../../views/types.js'
import type { CrmStore } from '../../crm/types.js'
import type { TaskStore } from '../../tasks/types.js'
import type { WorkflowRunStore } from '../../workflow/types.js'
import { createGetBlockTool } from '../tools.js'
import type { DocToolDeps } from '../tools.js'
import type { Block, Page } from '../page-types.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000010'
const USER_ID = '00000000-0000-0000-0000-000000000020'
const PAGE_ID = '00000000-0000-0000-0000-0000000000b1'

function ctx(overrides: { workspaceId?: string | null } = {}) {
  return {
    userId: USER_ID,
    assistantId: 'asst-1',
    sessionId: 'sess-1',
    appId: 'Use Brian',
    channelType: 'web',
    channelId: 'web-1',
    workspaceId:
      overrides.workspaceId === undefined ? WORKSPACE_ID : overrides.workspaceId,
    abortSignal: new AbortController().signal,
  }
}

/** Minimal dep bag — `getBlock` only ever touches `savedViewStore.getPage`. */
function deps(page: Page | null): DocToolDeps {
  return {
    savedViewStore: {
      getPage: vi.fn().mockResolvedValue(page),
    } as unknown as SavedViewStore,
    docPageStore: {
      getVersionedPage: vi.fn(),
      applyPatch: vi.fn(),
    },
    taskStore: {} as TaskStore,
    crmStore: {} as CrmStore,
    workflowRunStore: {} as WorkflowRunStore,
    workspaceDirectory: {
      listMembers: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      batchGet: vi.fn().mockResolvedValue(new Map()),
    },
  }
}

const TEXT_BLOCK: Block = { kind: 'text', id: 'b1', text: 'hello' } as Block

describe('[COMP:doc/tools] getBlock failure copy', () => {
  it('sends a block miss back to the outline and forbids the blind retry', async () => {
    const tool = createGetBlockTool(deps({ blocks: [TEXT_BLOCK] }))
    const res = await tool.execute({ pageId: PAGE_ID, blockId: 'b-gone' }, ctx())

    expect(res.isError).toBe(true)
    const data = String(res.data)
    expect(data).toContain('b-gone')
    expect(data).toContain(PAGE_ID)
    // Why a valid-looking id can miss + where a current one comes from.
    expect(data).toContain('stale')
    expect(data).toContain('getCurrentPage')
    expect(data).toContain('Do NOT retry this exact block id')
  })

  it('renders a corrupt block through formatToolError, not the raw ZodError dump', async () => {
    // A block whose `kind` is real but whose payload does not satisfy the wire
    // format — the shape a hand-edited / migrated JSONB column produces.
    const corrupt = { kind: 'text', id: 'b1', text: 42 } as unknown as Block
    const tool = createGetBlockTool(deps({ blocks: [corrupt] }))
    const res = await tool.execute({ pageId: PAGE_ID, blockId: 'b1' }, ctx())

    expect(res.isError).toBe(true)
    const data = String(res.data)
    // formatToolError's compact `path: message` lines…
    expect(data).toContain('Validation failed:')
    expect(data).toMatch(/\btext\b\s*:/)
    // …and never the raw ZodError JSON dump the old copy interpolated.
    expect(data).not.toContain('"code"')
    expect(data).not.toContain('[\n')
    // A stored-data fault: say the arguments are fine and close the retry.
    expect(data).toContain('Nothing is wrong with your arguments')
    expect(data).toContain('will keep failing')
    expect(data).toContain('getCurrentPage')
  })

  it('still routes a missing page through the page-not-found pointer', async () => {
    const tool = createGetBlockTool(deps(null))
    const res = await tool.execute({ pageId: PAGE_ID, blockId: 'b1' }, ctx())

    expect(res.isError).toBe(true)
    const data = String(res.data)
    expect(data).toContain(PAGE_ID)
    expect(data).toContain('findPage')
  })
})
