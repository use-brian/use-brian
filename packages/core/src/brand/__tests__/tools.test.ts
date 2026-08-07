/**
 * [COMP:brand/tools] — `getBrand` and `updateBrandDraft`.
 *
 * The property that has to hold is that `updateBrandDraft` cannot approve.
 * Not "should not" — cannot: there is no argument that would let it, and the
 * only store method it reaches is `saveDraft`. This suite asserts that at the
 * call level (the fake store's `approve` is never invoked) and at the flag
 * level (`requiresCapability` + `requiresConfirmation`, which are what keep
 * the tool gated in the UI and off the human-less surfaces).
 *
 * Fixture data is invented.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BrandRecordSchema, type BrandRecord } from '@use-brian/shared'
import { createBrandTools } from '../tools.js'
import type { BrandDetail, BrandStore } from '../types.js'

const APPROVED: BrandRecord = BrandRecordSchema.parse({
  naming: { name: 'Northwind Ferry', tagline: 'Every crossing, on the hour' },
  messaging: {
    oneLine: 'Scheduled coastal freight you can plan around.',
    voice: [{ trait: 'Punctual', means: 'Lead with the fact', avoid: 'Preambles' }],
  },
})

function detail(overrides: Partial<BrandDetail> = {}): BrandDetail {
  return {
    id: 'brand-1',
    workspaceId: 'ws-1',
    slug: 'northwind',
    name: 'Northwind Ferry',
    isDefault: true,
    status: 'active',
    activeVersionId: 'v-1',
    activeVersion: 2,
    hasDraft: false,
    sensitivity: 'internal',
    createdBy: 'u-1',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-07T00:00:00Z'),
    draft: null,
    activeRecord: APPROVED,
    ...overrides,
  }
}

function fakeStore(brand: BrandDetail | null = detail()): BrandStore & {
  approve: ReturnType<typeof vi.fn>
  saveDraft: ReturnType<typeof vi.fn>
} {
  const saveDraft = vi.fn(async (_u: string, _w: string, _b: string, record: BrandRecord) =>
    detail({ draft: record, hasDraft: true }),
  )
  const approve = vi.fn(async () => {
    throw new Error('approve must never be reachable from a tool')
  })
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async () => brand),
    create: vi.fn(async () => detail()),
    saveDraft,
    approve,
    listVersions: vi.fn(async () => []),
    getVersion: vi.fn(async () => null),
  } as unknown as BrandStore & { approve: typeof approve; saveDraft: typeof saveDraft }
}

const CONTEXT = {
  userId: 'u-1',
  workspaceId: 'ws-1',
  assistantId: 'a-1',
  sessionId: 's-1',
  channelType: 'web',
} as never

/** Same context with no workspace bound — the gate every tool runs first. */
const NO_WORKSPACE_CONTEXT = {
  userId: 'u-1',
  workspaceId: undefined,
  assistantId: 'a-1',
  sessionId: 's-1',
  channelType: 'web',
} as never

beforeEach(() => vi.clearAllMocks())

describe('[COMP:brand/tools] gating flags', () => {
  it('carries requiresCapability: brand on both tools', () => {
    const { getBrand, updateBrandDraft } = createBrandTools(fakeStore())
    // The capability name IS the connector id — that equality is what makes
    // the Studio Built-in rail's off switch load-bearing.
    expect(getBrand.requiresCapability).toBe('brand')
    expect(updateBrandDraft.requiresCapability).toBe('brand')
  })

  it('makes the write confirmation-required and the read not', () => {
    const { getBrand, updateBrandDraft } = createBrandTools(fakeStore())
    // requiresConfirmation does double duty: an Approve/Deny card on
    // interactive surfaces, AND — via the confirmation strip both already run
    // — exclusion from the public API and an un-deferred A2A consult, neither
    // of which has a human in the loop.
    expect(updateBrandDraft.requiresConfirmation).toBe(true)
    expect(getBrand.requiresConfirmation).toBe(false)
    expect(getBrand.isReadOnly).toBe(true)
  })
})

describe('[COMP:brand/tools] getBrand', () => {
  it('returns the approved record by default', async () => {
    const store = fakeStore(detail({ draft: BrandRecordSchema.parse({ naming: { name: 'Draft name' } }), hasDraft: true }))
    const { getBrand } = createBrandTools(store)
    const res = await getBrand.execute({}, CONTEXT)
    const data = res.data as { reading: string; record: BrandRecord; has_unapproved_draft: boolean }
    expect(data.reading).toBe('approved')
    expect(data.record.naming.name).toBe('Northwind Ferry')
    // The model is told a draft exists so it can offer to show it, rather
    // than discovering the record it just read is stale.
    expect(data.has_unapproved_draft).toBe(true)
  })

  it('returns the draft only when explicitly asked, and labels it', async () => {
    const draft = BrandRecordSchema.parse({ naming: { name: 'Draft name' } })
    const store = fakeStore(detail({ draft, hasDraft: true }))
    const { getBrand } = createBrandTools(store)
    const res = await getBrand.execute({ include_draft: true }, CONTEXT)
    const data = res.data as { reading: string; record: BrandRecord }
    expect(data.reading).toBe('draft')
    expect(data.record.naming.name).toBe('Draft name')
  })

  it('labels a never-approved record as a draft rather than passing it off as settled', async () => {
    const draft = BrandRecordSchema.parse({ naming: { name: 'Draft name' } })
    const store = fakeStore(detail({ draft, hasDraft: true, activeRecord: null, activeVersion: null, activeVersionId: null, status: 'draft' }))
    const { getBrand } = createBrandTools(store)
    const res = await getBrand.execute({}, CONTEXT)
    expect((res.data as { reading: string }).reading).toBe('draft')
  })

  it('tells the model not to invent values when no brand exists', async () => {
    const { getBrand } = createBrandTools(fakeStore(null))
    const res = await getBrand.execute({}, CONTEXT)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('do not invent brand values')
  })

  it('errors honestly with no workspace', async () => {
    const { getBrand } = createBrandTools(fakeStore())
    const res = await getBrand.execute({}, NO_WORKSPACE_CONTEXT)
    expect(res.isError).toBe(true)
  })
})

describe('[COMP:brand/tools] updateBrandDraft writes the draft and only the draft', () => {
  it('saves through saveDraft and never touches approve', async () => {
    const store = fakeStore()
    const { updateBrandDraft } = createBrandTools(store)
    const res = await updateBrandDraft.execute(
      { changes: { messaging: { oneLine: 'Hourly crossings, published in advance.' } } },
      CONTEXT,
    )
    expect(res.isError).toBeUndefined()
    expect(store.saveDraft).toHaveBeenCalledTimes(1)
    expect(store.approve).not.toHaveBeenCalled()
    // The model must not tell the user the brand changed.
    expect(String(res.data)).toContain('DRAFT')
    expect(String(res.data)).toContain('not live yet')
  })

  it('bases the new draft on the in-flight draft, not the approved record', async () => {
    const inFlight = BrandRecordSchema.parse({
      naming: { name: 'Northwind Ferry' },
      strategy: { positioning: 'A colleague was mid-edit here.' },
    })
    const store = fakeStore(detail({ draft: inFlight, hasDraft: true }))
    const { updateBrandDraft } = createBrandTools(store)
    await updateBrandDraft.execute({ changes: { messaging: { oneLine: 'New line.' } } }, CONTEXT)
    const saved = store.saveDraft.mock.calls[0][3] as BrandRecord
    // Patching the approved record instead would silently discard the
    // colleague's unapproved work.
    expect(saved.strategy?.positioning).toBe('A colleague was mid-edit here.')
    expect(saved.messaging?.oneLine).toBe('New line.')
  })

  it('falls back to the approved record when no draft is in flight', async () => {
    const store = fakeStore()
    const { updateBrandDraft } = createBrandTools(store)
    await updateBrandDraft.execute({ changes: { messaging: { oneLine: 'New line.' } } }, CONTEXT)
    const saved = store.saveDraft.mock.calls[0][3] as BrandRecord
    expect(saved.naming.tagline).toBe('Every crossing, on the hour')
  })

  it('replaces a group whole', async () => {
    const store = fakeStore()
    const { updateBrandDraft } = createBrandTools(store)
    await updateBrandDraft.execute({ changes: { messaging: { oneLine: 'New line.' } } }, CONTEXT)
    const saved = store.saveDraft.mock.calls[0][3] as BrandRecord
    // The prior voice entry is gone — group replacement, as the description
    // states, so the model's mental model matches the code.
    expect(saved.messaging?.voice).toEqual([])
  })

  it('rejects a patch that would leave the merged record invalid', async () => {
    const store = fakeStore()
    const { updateBrandDraft } = createBrandTools(store)
    const res = await updateBrandDraft.execute(
      { changes: { messaging: { voice: [{ trait: 'Punctual' }] } } } as never,
      CONTEXT,
    )
    expect(res.isError).toBe(true)
    // Field paths, so the model can repair its own input instead of retrying
    // the same shape.
    expect(String(res.data)).toContain('messaging.voice')
    expect(store.saveDraft).not.toHaveBeenCalled()
  })

  it('rejects an empty change set', async () => {
    const store = fakeStore()
    const { updateBrandDraft } = createBrandTools(store)
    const res = await updateBrandDraft.execute({ changes: {} }, CONTEXT)
    expect(res.isError).toBe(true)
    expect(store.saveDraft).not.toHaveBeenCalled()
  })

  it('refuses when the workspace has no brand yet', async () => {
    const store = fakeStore(null)
    const { updateBrandDraft } = createBrandTools(store)
    const res = await updateBrandDraft.execute({ changes: { messaging: { oneLine: 'x' } } }, CONTEXT)
    expect(res.isError).toBe(true)
    expect(store.saveDraft).not.toHaveBeenCalled()
  })

  it('accepts no argument that could approve or activate', () => {
    const { updateBrandDraft } = createBrandTools(fakeStore())
    const keys = Object.keys(
      (updateBrandDraft.inputSchema as unknown as { shape: Record<string, unknown> }).shape,
    )
    expect(keys.sort()).toEqual(['change_summary', 'changes', 'slug'])
  })
})

describe('[COMP:brand/tools] confirmation preview', () => {
  it('names the groups being replaced and says it stays a draft', async () => {
    const { updateBrandDraft } = createBrandTools(fakeStore())
    const lines = (await updateBrandDraft.describeConfirmation!(
      { changes: { messaging: { oneLine: 'x' }, colors: [] }, change_summary: 'Tighten the one-liner' },
      CONTEXT,
    )) as string[] | null
    expect(lines).not.toBeNull()
    const text = lines!.join('\n')
    expect(text).toContain('Replaces in full: messaging, colors')
    expect(text).toContain('owner or admin approves it in Studio')
    expect(text).toContain('Tighten the one-liner')
  })

  it('returns null when no recognised group is present', async () => {
    const { updateBrandDraft } = createBrandTools(fakeStore())
    expect(await updateBrandDraft.describeConfirmation!({ changes: {} }, CONTEXT)).toBeNull()
  })
})
