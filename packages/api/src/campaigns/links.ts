/** Stable campaign-link construction and redirect policy. [COMP:campaigns/links] */
import { CampaignError } from '@use-brian/core/campaigns/types.js'
import {
  campaignHttpUrlSchema,
  type CampaignUtm,
} from '@use-brian/shared/campaigns'

export const CAMPAIGN_ATTRIBUTION_QUERY_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'brian_link',
] as const

export type CampaignAttributionConflictMode = 'reject' | 'replace' | 'retain'

export function attributionQueryKeys(destination: string): string[] {
  const url = new URL(campaignHttpUrlSchema.parse(destination))
  return CAMPAIGN_ATTRIBUTION_QUERY_KEYS.filter(key => url.searchParams.has(key))
}

/**
 * Build a direct destination. `retain` preserves existing standard UTM values,
 * fills missing values from the approved snapshot, and always binds the
 * non-secret Brian join to the newly registered immutable link.
 */
export function buildCampaignDestination(input: {
  destination: string
  utm: CampaignUtm
  publicLinkId: string
  existingAttribution: CampaignAttributionConflictMode
}): { url: string; retainedKeys: string[]; replacedKeys: string[] } {
  const url = new URL(campaignHttpUrlSchema.parse(input.destination))
  const conflicts = attributionQueryKeys(url.toString())
  if (conflicts.length > 0 && input.existingAttribution === 'reject') {
    throw new CampaignError('conflict', 'The destination already contains campaign attribution parameters.', {
      conflictingKeys: conflicts,
      choices: ['replace', 'retain'],
    })
  }

  const entries: Array<[string, string | undefined]> = [
    ['utm_source', input.utm.source],
    ['utm_medium', input.utm.medium],
    ['utm_campaign', input.utm.campaign],
    ['utm_content', input.utm.content],
    ['utm_term', input.utm.term],
  ]
  const retainedKeys: string[] = []
  const replacedKeys: string[] = []
  for (const [key, value] of entries) {
    if (value === undefined) continue
    if (url.searchParams.has(key) && input.existingAttribution === 'retain') {
      retainedKeys.push(key)
      continue
    }
    if (url.searchParams.has(key)) replacedKeys.push(key)
    url.searchParams.set(key, value)
  }
  if (url.searchParams.has('brian_link')) replacedKeys.push('brian_link')
  url.searchParams.set('brian_link', input.publicLinkId)
  return { url: url.toString(), retainedKeys, replacedKeys }
}

export function campaignRedirectUrl(publicOrigin: string, publicLinkId: string): string {
  const origin = new URL(publicOrigin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
    throw new CampaignError('invalid_input', 'A credential-free HTTP(S) public origin is required.')
  }
  return new URL(`/r/${encodeURIComponent(publicLinkId)}`, origin).toString()
}
