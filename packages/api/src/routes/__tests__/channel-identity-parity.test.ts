import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHANNEL_IDENTITY } from '@use-brian/shared'

/**
 * The channel identity registry is a claim about the routes: a channel the
 * UI offers Connect on must REDEEM a link code and READ the resulting link
 * before resolving the sender, or the person connects and nothing changes
 * (the Slack link-code shape before 2026-08-18: written, never read). This
 * reads each open route's source and holds the registry to it, in both
 * directions, and holds `emailStatusReported` to the route actually writing
 * `channel_email_lookup_*`. WhatsApp's claim lives in the closed hosted
 * official-number route, which this open suite cannot read; that row is
 * not graded here.
 *
 * Spec: docs/plans/channel-identity-binding.md §5.
 */
const ROUTE_FILES = {
  telegram: 'telegram-byo.ts',
  slack: 'slack.ts',
  feishu: 'feishu.ts',
  discord: 'discord.ts',
  msteams: 'msteams.ts',
  wechat: 'wechat.ts',
} as const

function source(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8')
}

describe('[COMP:api/channel-identity-parity] channel identity registry matches the routes', () => {
  for (const [kind, file] of Object.entries(ROUTE_FILES)) {
    const row = CHANNEL_IDENTITY[kind as keyof typeof ROUTE_FILES]
    const text = source(file)
    const reads = text.includes('linkedAccountStore.findByProvider(')
    const claims = /linkCodeStore\.claim\(/.test(text)

    it(`${kind}: emailStatusReported=${row.emailStatusReported} agrees with ${file}`, () => {
      expect(text.includes('channel_email_lookup_')).toBe(row.emailStatusReported)
    })

    it(`${kind}: connect=${row.connect} agrees with ${file}`, () => {
      if (row.connect === 'unavailable') {
        expect({ reads, claims }, `${file} now reads/claims links; mark ${kind} connectable in the registry`)
          .toEqual({ reads: false, claims: false })
      } else {
        expect({ reads, claims }, `${file} must claim codes and read links for ${kind} to offer Connect`)
          .toEqual({ reads: true, claims: true })
      }
    })
  }
})
