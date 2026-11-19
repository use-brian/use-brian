import { describe, expect, it, vi } from 'vitest'
import { CampaignError } from '@use-brian/core/campaigns/types.js'
import {
  attributionQueryKeys,
  buildCampaignDestination,
  campaignRedirectUrl,
} from '../links.js'
import { requireCampaignPlacement } from '../../db/campaign-store.js'

const utm = {
  source: 'linkedin',
  medium: 'organic_social',
  campaign: 'example_launch',
  content: 'p001_body',
}

describe('[COMP:campaigns/links] native campaign links', () => {
  it('preserves unrelated query values and fragments while adding one stable attribution set', () => {
    const output = buildCampaignDestination({
      destination: 'https://example.com/pricing?ref=partner#plans',
      utm,
      publicLinkId: 'link_0123456789abcdefghi',
      existingAttribution: 'reject',
    })
    const url = new URL(output.url)
    expect(url.searchParams.get('ref')).toBe('partner')
    expect(url.searchParams.get('utm_source')).toBe('linkedin')
    expect(url.searchParams.get('brian_link')).toBe('link_0123456789abcdefghi')
    expect(url.hash).toBe('#plans')
  })

  it('makes attribution conflicts visible and applies explicit retain or replace policy', () => {
    const destination = 'https://example.com/?utm_source=partner&utm_medium=referral&brian_link=old_link_0123456789'
    expect(() => buildCampaignDestination({ destination, utm, publicLinkId: 'new_link_0123456789abc', existingAttribution: 'reject' }))
      .toThrowError(CampaignError)
    expect(attributionQueryKeys(destination)).toEqual(['utm_source', 'utm_medium', 'brian_link'])

    const retained = new URL(buildCampaignDestination({ destination, utm, publicLinkId: 'new_link_0123456789abc', existingAttribution: 'retain' }).url)
    expect(retained.searchParams.get('utm_source')).toBe('partner')
    expect(retained.searchParams.get('utm_medium')).toBe('referral')
    expect(retained.searchParams.get('brian_link')).toBe('new_link_0123456789abc')

    const replaced = new URL(buildCampaignDestination({ destination, utm, publicLinkId: 'new_link_0123456789abc', existingAttribution: 'replace' }).url)
    expect(replaced.searchParams.get('utm_source')).toBe('linkedin')
    expect(replaced.searchParams.getAll('utm_source')).toEqual(['linkedin'])
  })

  it('rejects unsafe destinations and creates only stored-id redirect shapes', () => {
    expect(() => buildCampaignDestination({ destination: 'https://secret@example.com/', utm, publicLinkId: 'link_0123456789abcdefghi', existingAttribution: 'reject' })).toThrow()
    expect(() => buildCampaignDestination({ destination: 'javascript:alert(1)', utm, publicLinkId: 'link_0123456789abcdefghi', existingAttribution: 'reject' })).toThrow()
    expect(campaignRedirectUrl('https://campaigns.example.com/base', 'link_0123456789abcdefghi'))
      .toBe('https://campaigns.example.com/r/link_0123456789abcdefghi')
  })

  it('refuses to attach a link to a placement outside the selected campaign', async () => {
    const query = vi.fn(async (_sql: string, _parameters?: unknown[]) => ({ rows: [], rowCount: 0 }))
    await expect(requireCampaignPlacement({ query } as never, {
      workspaceId: crypto.randomUUID(),
      campaignId: crypto.randomUUID(),
      placementId: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: 'not_found' })
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[0]).toContain('campaign_id=$2')
  })

  it('keeps a valid redirect available when observation storage fails', async () => {
    const lookup = vi.fn(async () => ({ destination: 'https://example.com/destination' }))
    const record = vi.fn(async () => { throw new Error('collector unavailable') })
    const row = await lookup()
    await record().catch(() => undefined)
    expect(row.destination).toBe('https://example.com/destination')
    expect(record).toHaveBeenCalledOnce()
  })
})
