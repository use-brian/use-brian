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

  it('does not treat the interactive provider session as a second origin recipient', () => {
    const source = readFileSync(new URL('../channel-pipeline.ts', import.meta.url), 'utf8')
    const audienceCall = source.match(/authorizeDeliveryAudience\(\{([\s\S]*?)\n\s*\}\)/)?.[1] ?? ''
    expect(audienceCall).toContain('...audienceInput')
    expect(audienceCall).not.toContain('sessionId')
    expect(source).toContain('ignoreSessionBinding: isGroupChat')
  })

  it('keeps hidden session state outside an isolated public audience', () => {
    const source = readFileSync(new URL('../channel-pipeline.ts', import.meta.url), 'utf8')
    expect(source).toContain('if (sessionStateStore && !isolatedAudience)')
    expect(source).toContain('if (sessionStateStore && isIdentified && !isolatedAudience)')
    expect(source).toContain('maximumAccessCurrent: currentAudienceMaximum')
    expect(source).toContain('persistSessionSummary: !isolatedAudience')
    expect(source).toContain('getClaimsForLatestAssistantMessage(session.id, true)')
    const pendingRecordingBlock = source.match(
      /Pre-flight-confirm reply correlation[\s\S]*?Processing start/,
    )?.[0] ?? ''
    expect(pendingRecordingBlock).toContain('if (!isolatedAudience) {')
  })
})
