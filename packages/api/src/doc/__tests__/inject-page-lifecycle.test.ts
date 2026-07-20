/**
 * [COMP:api/doc-inject] Doc inject — page-lifecycle fallback wiring.
 *
 * Regression guard for the empty PageWorkflowRuns chip (workflow.md → "Page
 * event source"). The interactive chat route calls `injectDocTools` WITHOUT a
 * `savedViewStore`, so the assistant's createSubPage / patchPage / renderPage
 * writes reach the DB through `inject.ts`'s lazily-cached fallback store. That
 * fallback MUST be constructed with `onPageLifecycle: publishPageLifecycle` or
 * those `system` page writes emit no lifecycle event and a `page`-source
 * workflow never fires — most visible in single-player OSS, where the assistant
 * authors most pages.
 *
 * The other inject tests always pass a `savedViewStore` explicitly, so they
 * never exercise the fallback; this file omits it on purpose.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type {
  DocEntityStore,
  DocPageStore,
  CrmStore,
  PageLifecycleEvent,
  TaskStore,
  Tool,
  WorkflowRunStore,
  WorkspaceDirectoryStore,
} from '@use-brian/core'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

// Capture the options the inject fallback hands the store factory. The factory
// returns a proxy "store" — the inject path never calls its methods (the tool
// factories are pure constructors), so a no-op stand-in is enough.
vi.mock('../../db/saved-views-store.js', () => ({
  createDbSavedViewStore: vi.fn(
    () =>
      new Proxy({}, { get: () => vi.fn() }) as unknown,
  ),
}))

import { injectDocTools } from '../inject.js'
import { createDbSavedViewStore } from '../../db/saved-views-store.js'
import { setPageEventDispatcher } from '../../page-event-fanout.js'
import type { DispatchEvent, WorkflowEventDispatcher } from '@use-brian/core'

function noopStore<T>(): T {
  return new Proxy({}, { get: () => vi.fn() }) as T
}

// Note: NO `savedViewStore` — that is the whole point, the fallback resolves it.
const baseOpts = {
  userId: 'user-1',
  assistant: {
    id: 'primary-1',
    kind: 'primary' as const,
    appType: null,
    workspaceId: 'ws-1',
  },
  docSurface: true,
  docPageStore: noopStore<DocPageStore>(),
  docEntityStore: noopStore<DocEntityStore>(),
  taskStore: noopStore<TaskStore>(),
  crmStore: noopStore<CrmStore>(),
  workflowRunStore: noopStore<WorkflowRunStore>(),
  workspaceDirectory: noopStore<WorkspaceDirectoryStore>(),
}

const EVENT: PageLifecycleEvent = {
  workspaceId: 'ws-1',
  pageId: 'p1',
  parentId: null,
  title: 'Spec',
  actorId: 'user-1',
  action: 'updated',
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  setPageEventDispatcher(null)
})

describe('[COMP:api/doc-inject] injectDocTools page-lifecycle fallback', () => {
  it('constructs the fallback store with a page-lifecycle hook that reaches the bound dispatcher', async () => {
    const dispatch = vi.fn(async (_ev: DispatchEvent) => {})
    setPageEventDispatcher({ dispatch } as unknown as WorkflowEventDispatcher)

    const tools = new Map<string, Tool>()
    const result = await injectDocTools({ ...baseOpts, tools })

    // Doc tools still inject normally through the fallback store.
    expect(result.injected).toBe(true)

    // The fallback was built WITH a lifecycle hook (the bug was an unhooked
    // `createDbSavedViewStore()` here).
    expect(createDbSavedViewStore).toHaveBeenCalledWith(
      expect.objectContaining({ onPageLifecycle: expect.any(Function) }),
    )

    // And that hook is `publishPageLifecycle` — invoking it dispatches the
    // converted event to the dispatcher bootOpenApi binds.
    const opts = vi.mocked(createDbSavedViewStore).mock.calls[0]?.[0]
    opts?.onPageLifecycle?.(EVENT)
    await Promise.resolve() // let the fire-and-forget settle

    expect(dispatch).toHaveBeenCalledTimes(1)
    // action='updated' → the watched page is the page itself.
    expect(dispatch.mock.calls[0][0].source).toEqual({ type: 'page', pageId: 'p1' })
  })
})
