import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const installationBackedRoutes = [
  'telegram-byo.ts',
  'discord.ts',
  'whatsapp-cloud.ts',
  'msteams.ts',
  'slack.ts',
  'feishu.ts',
  'wechat.ts',
  'custom-channel-bridge.ts',
] as const

describe('[COMP:api/channel-live-authority] exact destination authority wiring', () => {
  it.each(installationBackedRoutes)(
    '%s forwards its exact integration and live store to the common pipeline',
    (file) => {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      expect(source).toContain('processChannelMessage({')
      expect(source).toMatch(/channelIntegrationId:\s*(?:params\.(?:integrationId|channelIntegrationId)|integration\.id)/)
      expect(source).toMatch(/channelIntegrationStore:\s*(?:params|options)\.integrationStore/)
    },
  )
})
