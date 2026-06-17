/**
 * The single public-share render path. Resolves a page's blocks + live
 * data under the pinned `buildPublicAccessContext` (clearance:'public',
 * systemRead) and neutralizes identity/storage leaks. Used by the anonymous
 * `/public/pages/:token` (+ `?page=` sub-page) and `/public/published/:pageId`
 * routes and the authenticated owner `/views/:id/public-preview` route, so
 * "what the owner previews" is byte-for-byte "what an outsider sees".
 *
 * [COMP:doc/public-share-route]
 */

import {
  buildPublicAccessContext,
  neutralizeBlocksForPublic,
  neutralizePublicPayload,
  renderPage,
  type Block,
  type BindingDeps,
  type CrmStore,
  type Page,
  type TaskStore,
  type ViewPayload,
  type WorkflowRunStore,
  type WorkspaceDirectoryStore,
} from '@sidanclaw/core'
import { getChildPageLabelsSystem, type ChildPageLabel } from '../db/saved-views-store.js'

export type PublicRenderDeps = {
  taskStore: TaskStore
  crmStore: CrmStore
  workflowRunStore: WorkflowRunStore
  workspaceDirectory: WorkspaceDirectoryStore
}

export type PublicRender = {
  blocks: Block[]
  payload: ViewPayload
}

/**
 * No-op member directory for the public render path. Person cells in a
 * shared data view would otherwise trigger a system-bypass read of every
 * workspace member's name/avatar (`workspaceDirectory.batchGet`) — wasteful
 * for an anonymous viewer, and a needless reliance on the payload scrubber.
 * With this stub no member data is read at all; `neutralizePublicPayload`
 * still anonymizes any residual `person` widget (defense in depth).
 */
const PUBLIC_WORKSPACE_DIRECTORY: WorkspaceDirectoryStore = {
  listMembers: async () => [],
  get: async () => null,
  batchGet: async () => new Map(),
}

/**
 * Render a page for anonymous public viewing. The data values resolve at
 * `clearance:'public'` (the access predicate gate); the neutralizers strip
 * residual identity (member/entity UUIDs, mentions) and storage paths.
 * `shareRootId` is the share-subtree root the caller resolved access through
 * (token root / published page / previewed page) — it scopes which
 * `child_page` targets get their labels resolved (doc.md "Subtree share").
 */
export async function renderPublicPage(
  deps: PublicRenderDeps,
  workspaceId: string,
  page: Page,
  shareRootId: string,
): Promise<PublicRender> {
  const accessContext = buildPublicAccessContext(workspaceId)
  const bindingDeps: BindingDeps = {
    taskStore: deps.taskStore,
    crmStore: deps.crmStore,
    // workflow_runs binding reads via `userId` (the synthetic public
    // principal, not a member) → RLS returns nothing, so workflow-run blocks
    // render empty on a public page. Member directory is stubbed (above).
    workflowRunStore: deps.workflowRunStore,
    workspaceDirectory: PUBLIC_WORKSPACE_DIRECTORY,
    userId: accessContext.userId,
    workspaceId,
    accessContext,
  }
  const payload = await renderPage(page, bindingDeps)
  const blocks = await resolveChildPageLabels(neutralizeBlocksForPublic(page.blocks), shareRootId)
  return {
    blocks,
    payload: neutralizePublicPayload(payload),
  }
}

/**
 * Resolve `child_page` block labels for the public render. The neutralizer
 * keeps the `childPageId` (it is the child's share URL); here we attach the
 * child's `title`/`icon`/`via` for display — for children inside the share
 * subtree (`via:'subtree'`) or independently published (`via:'published'`).
 * Any other child resolves to no label, so we blank its `childPageId` too:
 * the slot stays (index alignment with the A2UI payload is preserved) but
 * renders nothing, leaking neither title nor id.
 */
async function resolveChildPageLabels(blocks: Block[], shareRootId: string): Promise<Block[]> {
  const childIds = blocks
    .filter((b): b is Extract<Block, { kind: 'child_page' }> => b.kind === 'child_page')
    .map((b) => b.childPageId)
    .filter(Boolean)
  if (childIds.length === 0) return blocks
  const labels = await getChildPageLabelsSystem(childIds, shareRootId)
  return labelChildPageBlocks(blocks, labels)
}

/**
 * Pure label application — split from the DB lookup for unit testing
 * (`public-share.test.ts`). Blanks unresolved children, attaches
 * title/icon/via to resolved ones, preserves block order + non-child blocks.
 */
export function labelChildPageBlocks(blocks: Block[], labels: Map<string, ChildPageLabel>): Block[] {
  return blocks.map((b) => {
    if (b.kind !== 'child_page') return b
    const info = b.childPageId ? labels.get(b.childPageId) : undefined
    if (!info) return { kind: 'child_page', id: b.id, childPageId: '' }
    return {
      kind: 'child_page',
      id: b.id,
      childPageId: b.childPageId,
      title: info.name,
      icon: info.icon,
      via: info.via,
    } as unknown as Block
  })
}
