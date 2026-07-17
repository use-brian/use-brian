/**
 * [COMP:api/ingest-placeholder-resolver] Ingest-rule placeholder resolver
 * — expands `:crm_contacts` / `:workspace_members` to workspace-scoped
 * email lists so Gmail / Calendar default rules route by people, not
 * frozen literals.
 *
 * `query` is mocked: the test asserts the resolved list and the
 * workspace-scoped parameter, without a database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IngestContext } from '@use-brian/core'
import { query } from '../../db/client.js'
import { resolveIngestPlaceholders } from '../placeholder-resolver.js'

vi.mock('../../db/client.js', () => ({ query: vi.fn() }))

const ctx: IngestContext = {
  workspace_id: 'ws-1',
  connector_instance_id: 'ci-1',
}

/** A `pg.QueryResult`-shaped stub carrying just the `email` rows. */
function emailRows(...emails: string[]): Awaited<ReturnType<typeof query>> {
  return { rows: emails.map((email) => ({ email })) } as unknown as Awaited<
    ReturnType<typeof query>
  >
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/ingest-placeholder-resolver] resolveIngestPlaceholders', () => {
  it(':crm_contacts returns the workspace contact emails', async () => {
    vi.mocked(query).mockResolvedValue(emailRows('a@x.com', 'b@y.com'))
    const out = await resolveIngestPlaceholders(':crm_contacts', ctx)
    expect(out).toEqual(['a@x.com', 'b@y.com'])
    // Scoped to the context's workspace.
    expect(vi.mocked(query).mock.calls[0]![1]).toEqual(['ws-1'])
  })

  it(':workspace_members returns the workspace member emails', async () => {
    vi.mocked(query).mockResolvedValue(emailRows('member@acme.com'))
    const out = await resolveIngestPlaceholders(':workspace_members', ctx)
    expect(out).toEqual(['member@acme.com'])
    expect(vi.mocked(query).mock.calls[0]![1]).toEqual(['ws-1'])
  })

  it('an unknown placeholder resolves to an empty list without a query', async () => {
    const out = await resolveIngestPlaceholders(':priority_channels', ctx)
    expect(out).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  it('an empty contact table resolves to an empty list', async () => {
    vi.mocked(query).mockResolvedValue(emailRows())
    const out = await resolveIngestPlaceholders(':crm_contacts', ctx)
    expect(out).toEqual([])
  })
})
