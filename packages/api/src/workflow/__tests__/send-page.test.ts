import { describe, it, expect, vi, beforeEach } from 'vitest'

import { createSendPagePort, type SendPagePortDeps } from '../send-page.js'
import type { PageSendClaim } from '../../db/page-send-log-store.js'

const WS = '00000000-0000-0000-0000-000000000001'
const USER = '00000000-0000-0000-0000-000000000002'
const PAGE = '00000000-0000-0000-0000-00000000aaaa'

const BASE_PARAMS = {
  workspaceId: WS,
  userId: USER,
  pageId: PAGE,
  workflowId: 'wf-1',
  runId: 'run-1',
  stepId: 's1',
  via: 'gmail' as const,
  to: { recordField: 'email' } as const,
  subject: { literal: 'Hello Acme' } as const,
}

type SendFn = (params: { to: string; subject: string; body: string }) => Promise<{ id: string; threadId: string }>

function makeDeps(overrides?: {
  view?: Partial<{ id: string; workspaceId: string; name: string; clearance: string }> | null
  record?: Record<string, unknown> | null
  page?: { blocks: unknown[] } | null
  claim?: PageSendClaim
  send?: SendFn
  senderOk?: boolean
}) {
  const markSent = vi.fn(async () => {})
  const markFailed = vi.fn(async () => {})
  const mergeFields = vi.fn(async () => true)
  const claim = vi.fn(
    async (): Promise<PageSendClaim> => overrides?.claim ?? { outcome: 'claimed', claimId: 'claim-1' },
  )
  const send = vi.fn<SendFn>(overrides?.send ?? (async () => ({ id: 'gm-1', threadId: 'th-1' })))

  const deps: SendPagePortDeps = {
    savedViewStore: {
      getById: async () =>
        overrides?.view === null
          ? null
          : {
              id: PAGE,
              workspaceId: WS,
              name: 'Acme draft',
              clearance: 'internal',
              ...(overrides?.view ?? {}),
            },
    },
    docPageStore: {
      getVersionedPage: async () =>
        overrides?.page === null
          ? null
          : ({
              page: overrides?.page ?? {
                blocks: [{ id: 'b1', kind: 'text', text: 'Hi Bernard, quick intro.' }],
              },
              version: 3,
            } as never),
    },
    blueprintRecordStore: {
      getByPageId: async () =>
        overrides?.record === null
          ? null
          : ({
              id: 'rec-1',
              workspaceId: WS,
              sensitivity: 'internal',
              specSnapshot: [
                { key: 'email', heading: 'Email', instruction: '', type: 'string', required: true },
                { key: 'status', heading: 'Status', instruction: '', type: 'string', required: false },
              ],
              fields: { email: 'bernard@fls.hk' },
              ...(overrides?.record ?? {}),
            } as never),
      mergeFields,
    },
    pageSendLog: { claim, markSent, markFailed },
    acquireGmailSender: async () =>
      overrides?.senderOk === false
        ? { ok: false, message: 'Gmail is not connected for this user.' }
        : { ok: true, send },
  }
  return { deps, markSent, markFailed, mergeFields, claim, send }
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:workflow/send-page-port] createSendPagePort', () => {
  it('sends the page body verbatim and stamps the ledger + declared record fields', async () => {
    const h = makeDeps()
    const result = await createSendPagePort(h.deps)(BASE_PARAMS)
    expect(result).toMatchObject({ status: 'sent', recipient: 'bernard@fls.hk', externalId: 'gm-1' })
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'bernard@fls.hk', subject: 'Hello Acme' }),
    )
    const body = h.send.mock.calls[0][0].body
    expect(body).toContain('Hi Bernard, quick intro.')
    expect(h.markSent).toHaveBeenCalledWith(USER, 'claim-1', 'gm-1')
    // Stamp-back writes ONLY contract-declared keys: status yes, sent_at no.
    expect(h.mergeFields).toHaveBeenCalledWith(USER, 'rec-1', { status: 'sent' })
  })

  it('blocks a confidential page (egress gate) before any claim', async () => {
    const h = makeDeps({ view: { clearance: 'confidential' } })
    const result = await createSendPagePort(h.deps)(BASE_PARAMS)
    expect(result).toMatchObject({ status: 'blocked', reason: 'egress_blocked' })
    expect(h.claim).not.toHaveBeenCalled()
  })

  it('blocks a confidential record (egress gate)', async () => {
    const h = makeDeps({ record: { sensitivity: 'confidential' } })
    const result = await createSendPagePort(h.deps)(BASE_PARAMS)
    expect(result).toMatchObject({ status: 'blocked', reason: 'egress_blocked' })
  })

  it('blocks when the recordField is needed but no record exists', async () => {
    const h = makeDeps({ record: null })
    const result = await createSendPagePort(h.deps)(BASE_PARAMS)
    expect(result).toMatchObject({ status: 'blocked', reason: 'record_not_found' })
  })

  it('blocks an empty or non-email recipient', async () => {
    const empty = makeDeps({ record: { fields: {} } })
    expect(await createSendPagePort(empty.deps)(BASE_PARAMS)).toMatchObject({
      status: 'blocked',
      reason: 'missing_recipient',
    })
    const bogus = makeDeps({ record: { fields: { email: 'not-an-email' } } })
    expect(await createSendPagePort(bogus.deps)(BASE_PARAMS)).toMatchObject({
      status: 'blocked',
      reason: 'missing_recipient',
    })
  })

  it('blocks an empty page (nothing to send)', async () => {
    const h = makeDeps({ page: { blocks: [] } })
    const result = await createSendPagePort(h.deps)(BASE_PARAMS)
    expect(result).toMatchObject({ status: 'blocked', reason: 'empty_page' })
    expect(h.claim).not.toHaveBeenCalled()
  })

  it('returns already_sent on a sent claim conflict (idempotent re-click)', async () => {
    const h = makeDeps({
      claim: { outcome: 'already_sent', recipient: 'bernard@fls.hk', sentAt: '2026-07-11T00:00:00Z' },
    })
    const result = await createSendPagePort(h.deps)(BASE_PARAMS)
    expect(result).toMatchObject({ status: 'already_sent', recipient: 'bernard@fls.hk' })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('blocks while another send is in flight', async () => {
    const h = makeDeps({ claim: { outcome: 'in_flight' } })
    const result = await createSendPagePort(h.deps)(BASE_PARAMS)
    expect(result).toMatchObject({ status: 'blocked', reason: 'send_in_flight' })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('releases the claim when gmail is not connected', async () => {
    const h = makeDeps({ senderOk: false })
    const result = await createSendPagePort(h.deps)(BASE_PARAMS)
    expect(result).toMatchObject({ status: 'blocked', reason: 'gmail_not_connected' })
    expect(h.markFailed).toHaveBeenCalledWith(USER, 'claim-1', expect.stringContaining('not connected'))
  })

  it('releases the claim and rethrows on a transport error', async () => {
    const h = makeDeps({
      send: async () => {
        throw new Error('gmail 500')
      },
    })
    await expect(createSendPagePort(h.deps)(BASE_PARAMS)).rejects.toThrow('gmail 500')
    expect(h.markFailed).toHaveBeenCalledWith(USER, 'claim-1', 'gmail 500')
    expect(h.markSent).not.toHaveBeenCalled()
  })

  it('blocks a page missing or foreign to the workspace', async () => {
    const missing = makeDeps({ view: null })
    expect(await createSendPagePort(missing.deps)(BASE_PARAMS)).toMatchObject({
      status: 'blocked',
      reason: 'page_not_found',
    })
    const foreign = makeDeps({ view: { workspaceId: '00000000-0000-0000-0000-00000000ffff' } })
    expect(await createSendPagePort(foreign.deps)(BASE_PARAMS)).toMatchObject({
      status: 'blocked',
      reason: 'page_not_found',
    })
  })
})
