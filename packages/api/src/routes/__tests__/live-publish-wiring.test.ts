/**
 * Live watch lane wiring — the threading proof (live-work.md §5.2).
 * Component tag: [COMP:api/session-live-publisher].
 *
 * `publishSessionEvent` is optional on `ChannelPipelineParams` (unit
 * tests), so an unwired lane typechecks and unit-tests green while its
 * turns ship invisible to the Live watch pane — the exact
 * `channel-custom-llm-wiring` failure shape. Two properties, each
 * independent (the call site AND the mount), pinned repo-shape style
 * (precedent: admin-drift-allbuiltins-grep.test.ts): every open channel
 * route that calls `processChannelMessage` must forward the param, and
 * every boot.ts channel mount must supply it. The closed platform routes
 * are the hosted overlay's obligation (BootContext exposes the bus).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const routesDir = join(dirname(fileURLToPath(import.meta.url)), '..')

const OPEN_CHANNEL_ROUTES = [
  'slack.ts',
  'telegram-byo.ts',
  'discord.ts',
  'whatsapp-cloud.ts',
  'msteams.ts',
  'feishu.ts',
  'wechat.ts',
  'custom-channel-bridge.ts',
]

describe('[COMP:api/session-live-publisher] lane wiring', () => {
  it('every open channel route forwards publishSessionEvent into processChannelMessage', () => {
    for (const file of OPEN_CHANNEL_ROUTES) {
      const src = readFileSync(join(routesDir, file), 'utf8')
      expect(src, `${file} does not call processChannelMessage`).toContain('processChannelMessage(')
      expect(
        /publishSessionEvent: (params|options)\.publishSessionEvent,/.test(src),
        `${file} calls processChannelMessage without forwarding publishSessionEvent — its turns are invisible to the Live watch pane`,
      ).toBe(true)
    }
  })

  it('every boot.ts channel mount supplies publishSessionEvent (the mount is a second, independent property)', () => {
    const boot = readFileSync(join(routesDir, '..', 'boot.ts'), 'utf8')
    const mounts = [
      'telegramByoRoutes({',
      'slackRoutes({',
      'whatsappCloudRoutes({',
      'msteamsRoutes({',
      'discordRoutes({',
      'wechatRoutes({',
      'feishuRoutes({',
      'customChannelBridgeRoutes({',
    ]
    for (const mount of mounts) {
      const at = boot.indexOf(mount)
      expect(at, `${mount} mount not found in boot.ts`).toBeGreaterThan(-1)
      // The options object spans well under 60 lines for every mount.
      const block = boot.slice(at, at + 3_500)
      expect(
        block.includes('publishSessionEvent'),
        `boot.ts mounts ${mount.replace('({', '')} without supplying publishSessionEvent — the route forwards undefined and the lane ships dark`,
      ).toBe(true)
    }
  })

  it('the callee executor is constructed with the bus and mirrors through the shared publisher', () => {
    const executor = readFileSync(
      join(routesDir, '..', 'inter-assistant', 'executor.ts'),
      'utf8',
    )
    expect(executor).toContain('createTurnStreamPublisher(')
    expect(executor).toContain('publishTurnCompleted(')
    const boot = readFileSync(join(routesDir, '..', 'boot.ts'), 'utf8')
    const at = boot.indexOf('createCalleeExecutor({')
    expect(at).toBeGreaterThan(-1)
    expect(boot.slice(at, at + 400)).toContain('publishSessionEvent')
  })

  it('the channel pipeline publishes between its running/idle bookends', () => {
    const pipeline = readFileSync(join(routesDir, 'channel-pipeline.ts'), 'utf8')
    expect(pipeline).toContain('createTurnStreamPublisher(')
    // Terminal event lives in the finally with the idle bookend.
    const finallyAt = pipeline.lastIndexOf('} finally {')
    expect(finallyAt).toBeGreaterThan(-1)
    expect(pipeline.slice(finallyAt)).toContain('publishTurnCompleted(')
  })
})
