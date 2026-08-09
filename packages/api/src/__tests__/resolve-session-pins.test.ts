/**
 * Unit tests for pin resolution — the half of [COMP:api/room-pins] that turns a
 * `session_pins` row into a chip label + a prompt-block line.
 *
 * `routes/__tests__/room-pins.test.ts` mocks this module wholesale to test the
 * route gates, so until this file existed NOTHING executed the resolver's SQL.
 * That is how contact / company / deal pins spent months resolving against
 * `contacts` / `companies` / `deals` — three tables migration 296 dropped when
 * the CRM collapsed into `entities`. Every such pin threw `relation does not
 * exist`, the blanket catch swallowed it, and the only symptom was a chip stuck
 * on "unavailable" plus a prompt line telling the assistant a perfectly
 * readable contact was gone.
 *
 * So these tests assert the TABLE and KIND each pin reads, not just the
 * rendered string: a resolver that quietly answers "unavailable" for everything
 * passes an output-only test. The clearance and error paths are pinned too,
 * because they are the two ways a wrong answer can look like a right one.
 *
 * Spec: docs/architecture/features/chat-app.md → "Pinned room context (P1b)".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../db/client.js', () => ({ query: vi.fn() }))

import { query } from '../db/client.js'
import { resolveSessionPinLabels } from '../resolve-session-pins.js'
import type { SessionPin } from '../db/session-pins-store.js'

const mockQuery = vi.mocked(query)

const WORKSPACE = 'ws-1'

function pin(over: Partial<SessionPin> & Pick<SessionPin, 'kind'>): SessionPin {
  return {
    id: 'pin-1',
    sessionId: 'sess-1',
    refId: 'ref-1',
    url: null,
    text: null,
    position: 0,
    addedByUserId: null,
    addedByAssistantId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  } as SessionPin
}

/** The SQL handed to the single `query` call, whitespace-normalized. */
function sql(): string {
  return (mockQuery.mock.calls[0]?.[0] as string).replace(/\s+/g, ' ')
}

function params(): unknown[] {
  return mockQuery.mock.calls[0]?.[1] as unknown[]
}

function rows(value: Record<string, unknown>[]) {
  mockQuery.mockResolvedValue({ rows: value } as never)
}

describe('[COMP:api/room-pins] Pin resolution reads the live schema', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('resolves a contact from entities with kind person, never the dropped contacts table', async () => {
    rows([{ name: 'Ada Lovelace', sensitivity: 'internal' }])

    const labels = await resolveSessionPinLabels(
      [pin({ kind: 'contact', refId: 'c-1' })],
      WORKSPACE,
      'internal',
    )

    expect(labels.get('pin-1')).toBe('Ada Lovelace')
    expect(sql()).toContain('FROM entities')
    expect(sql()).not.toMatch(/FROM contacts\b/)
    // The kind is what separates a person row from a company row in the
    // unified table; without it a company id would resolve as a contact.
    expect(params()).toEqual(['c-1', WORKSPACE, 'person'])
    // Superseded / retracted rows are not live and must not resolve.
    expect(sql()).toContain('valid_to IS NULL')
    expect(sql()).toContain('retracted_at IS NULL')
  })

  it('resolves a company from entities with kind company', async () => {
    rows([{ name: 'Initech', sensitivity: 'internal' }])

    const labels = await resolveSessionPinLabels(
      [pin({ kind: 'company', refId: 'co-1' })],
      WORKSPACE,
      'internal',
    )

    expect(labels.get('pin-1')).toBe('Initech')
    expect(sql()).toContain('FROM entities')
    expect(sql()).not.toMatch(/FROM companies\b/)
    expect(params()).toEqual(['co-1', WORKSPACE, 'company'])
  })

  it('resolves a deal from entities, reading stage/amount/close date out of attributes', async () => {
    rows([
      {
        name: 'Acme renewal',
        stage: 'proposal',
        amount: '12000.00',
        closeDate: '2026-09-30',
        sensitivity: 'internal',
      },
    ])

    const labels = await resolveSessionPinLabels(
      [pin({ kind: 'deal', refId: 'd-1' })],
      WORKSPACE,
      'internal',
    )

    expect(labels.get('pin-1')).toBe('Acme renewal')
    expect(sql()).toContain('FROM entities')
    expect(sql()).not.toMatch(/FROM deals\b/)
    // Post-296 these three live in `attributes`, not in columns of their own.
    expect(sql()).toContain("attributes->>'stage'")
    expect(sql()).toContain("attributes->>'amount'")
    expect(sql()).toContain("attributes->>'close_date'")
    expect(sql()).toContain("kind = 'deal'")
  })

  it('keeps a pinned item above the room clearance unavailable', async () => {
    rows([{ name: 'Project Nightfall', sensitivity: 'confidential' }])

    const labels = await resolveSessionPinLabels(
      [pin({ kind: 'company', refId: 'co-2' })],
      WORKSPACE,
      'internal',
    )

    // `null` is the unavailable chip — the pin is shown, never silently dropped.
    expect(labels.get('pin-1')).toBeNull()
  })

  it('degrades a row that does not exist to unavailable without logging', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rows([])

    const labels = await resolveSessionPinLabels(
      [pin({ kind: 'contact', refId: 'gone' })],
      WORKSPACE,
      'internal',
    )

    expect(labels.get('pin-1')).toBeNull()
    // An ordinary miss is not an incident; logging it would bury the real one.
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('logs when the query itself fails instead of degrading silently', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockQuery.mockRejectedValue(new Error('relation "contacts" does not exist'))

    const labels = await resolveSessionPinLabels(
      [pin({ kind: 'contact', refId: 'c-3' })],
      WORKSPACE,
      'internal',
    )

    // Still degrades — one bad pin must never fail the whole block.
    expect(labels.get('pin-1')).toBeNull()
    // But it is now visible. A schema drift that produces an identical chip to
    // an ordinary miss is exactly the failure this file exists to prevent.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0]?.[0])).toContain('contact')
    spy.mockRestore()
  })

  it('needs no query for url and instruction pins', async () => {
    const labels = await resolveSessionPinLabels(
      [
        pin({ id: 'pin-u', kind: 'url', refId: null, url: 'https://example.com/spec' }),
        pin({ id: 'pin-i', kind: 'instruction', refId: null, text: 'Answer in Cantonese.' }),
      ],
      WORKSPACE,
      'internal',
    )

    expect(labels.get('pin-u')).toBe('https://example.com/spec')
    expect(labels.get('pin-i')).toBe('Answer in Cantonese.')
    expect(mockQuery).not.toHaveBeenCalled()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
