/**
 * Resolve the `# Brand` L1 block for one turn.
 *
 * Shared by `routes/chat.ts` (web) and `routes/channel-pipeline.ts` (every
 * messaging channel) so the two cannot drift on the gate.
 *
 * It reaches the store itself rather than taking it as an injected dependency.
 * That is deliberate: the `# Workspace Files` block IS injected, so every one
 * of the eight channel webhook factories has to remember to forward
 * `workspaceFilesStore` into `processChannelMessage`, and a ninth channel that
 * forgets ships with no files block and nothing catches it. The brand store
 * has nothing to configure — no blob client, no credential — so there is no
 * deployment where it is legitimately absent, and one accessor is strictly
 * safer than nine forwarding sites. Tests pass `store` to override.
 *
 * Two conditions, both required:
 *   1. the assistant holds the `brand` capability,
 *   2. it is bound to a workspace whose default brand has an APPROVED version.
 *
 * Either false → `null` → no block, and a prompt byte-identical to today's.
 * The second is the interesting one: a workspace with a brand draft but no
 * approval still gets no block, because a draft is a proposal — and an
 * assistant is one of the things that can write a draft, so admitting drafts
 * here would let the model widen its own brand rules.
 *
 * Never throws. A failed brand read degrades to no block, exactly as a failed
 * workspace-files read does: an ambient enrichment must not be able to fail a
 * user's turn.
 *
 * Spec: docs/architecture/features/brand.md → "L1 prompt block"
 *
 * [COMP:brand/prompt-context]
 */

import { buildBrandContext, type BrandStore } from '@use-brian/core'
import { getBrandStore } from '../db/brand-store.js'

export async function resolveBrandContext(params: {
  userId: string
  workspaceId: string | null | undefined
  /** Whether the assistant holds the `brand` capability grant. */
  hasCapability: boolean
  /** Prefix for the warning log, e.g. 'chat' or the channel type. */
  logLabel: string
  /** Test seam. Defaults to the shared pg-backed store. */
  store?: BrandStore
}): Promise<string | null> {
  const { userId, workspaceId, hasCapability, logLabel } = params
  if (!workspaceId || !hasCapability) return null
  const store = params.store ?? getBrandStore()

  try {
    const brand = await store.get(userId, workspaceId)
    if (!brand || !brand.activeRecord || brand.activeVersion === null) return null
    return buildBrandContext({
      name: brand.name,
      slug: brand.slug,
      record: brand.activeRecord,
      version: brand.activeVersion,
    })
  } catch (err) {
    console.error(`[${logLabel}] brand digest fetch failed:`, err)
    return null
  }
}
