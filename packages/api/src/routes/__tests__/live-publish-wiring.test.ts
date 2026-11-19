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
 * are the hosted overlay's obligation (BootContext exposes the bus). The
 * public API and chat-link mounts carry the same port for the public lane's
 * stale-takeover notice.
 */
import { describe, it, expect, vi } from 'vitest'
import ts from 'typescript'
import { publishTurnCompleted } from '../../session-live-publisher.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootCompositionSource } from '../../boot/__tests__/composition-source.js'

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
    const boot = bootCompositionSource()
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

  it('both public turn mounts supply publishSessionEvent and both routers forward it to the public turn', () => {
    // The public lane's stale-takeover notice (turn-kernel.md, "onReclaimed"):
    // the port is optional, so an unwired mount typechecks and ships dark.
    const boot = bootCompositionSource()
    for (const mount of ['publicApiRoutes({', 'publicChatRoutes({']) {
      const at = boot.indexOf(mount)
      expect(at, `${mount} mount not found in the boot composition`).toBeGreaterThan(-1)
      const block = boot.slice(at, boot.indexOf('}))', at))
      expect(block.includes('publishSessionEvent'), `${mount.replace('({', '')} is mounted without publishSessionEvent`).toBe(true)
    }
    for (const file of ['public-api.ts', 'public-chat.ts']) {
      const src = readFileSync(join(routesDir, file), 'utf8')
      expect(src, `${file} must hand its whole options object to executePublicTurn`).toMatch(/executePublicTurn\(\s*options,/)
    }
    const publicTurn = readFileSync(join(routesDir, 'public-turn.ts'), 'utf8')
    expect(publicTurn).toContain('publishSessionEvent?: PublishSessionEvent')
    expect(publicTurn).toMatch(/onReclaimed: recovered => publishTurnCompleted\(\{[^}]*publishSessionEvent/)
  })

  it('the callee executor is constructed with the bus and mirrors through the shared publisher', () => {
    const executor = readFileSync(
      join(routesDir, '..', 'inter-assistant', 'executor.ts'),
      'utf8',
    )
    expect(executor).toContain('createTurnStreamPublisher(')
    expect(executor).toContain('publishTurnCompleted(')
    const boot = bootCompositionSource()
    const at = boot.indexOf('createCalleeExecutor({')
    expect(at).toBeGreaterThan(-1)
    expect(boot.slice(at, at + 400)).toContain('publishSessionEvent')
  })

  it.each([true, false])('publishes channel completion only after awaited exact release (released=%s)', async released => {
    const pipeline = readFileSync(join(routesDir, 'channel-pipeline.ts'), 'utf8')
    const tree = ts.createSourceFile('channel-pipeline.ts', pipeline, ts.ScriptTarget.Latest, true)
    let cleanup: ts.Block | undefined
    function visit(node: ts.Node) {
      if (ts.isTryStatement(node) && node.finallyBlock?.getText(tree).includes('await settlePreparationUsage()')
        && node.finallyBlock.getText(tree).includes('publishTurnCompleted(')) cleanup = node.finallyBlock
      ts.forEachChild(node, visit)
    }
    visit(tree)
    if (!cleanup) throw new Error('Missing actual complete channel cleanup')
    const order: string[] = [], bus = vi.fn(() => order.push('published'))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const turnOwner = { released: false, turnId: 'a'.repeat(64), completionReason: 'completed', finish: vi.fn(async () => {
      order.push('release started'); await gate; turnOwner.released = released; order.push('release finished')
    }) }
    const scope = { turnOwner, settlePreparationUsage: async () => { order.push('auxiliary settled') }, pendingPreparation: [], pendingUsage: [],
      channelType: 'fixture', hooks: { onCleanup: async () => { order.push('transport cleaned') } }, channelStopRequested: () => false,
      turnFailed: false, session: { id: 'session' }, userId: 'actor', publishSessionEvent: bus, publishTurnCompleted }
    const run = new Function(...Object.keys(scope), ts.transpileModule(`return (async () => { ${cleanup.getText(tree)} })()`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(scope))
    await vi.waitFor(() => expect(turnOwner.finish).toHaveBeenCalledExactlyOnceWith('completed'))
    expect(order).toEqual(['auxiliary settled', 'transport cleaned', 'release started'])
    expect(bus).not.toHaveBeenCalled()
    release(); await run
    expect(order).toEqual(['auxiliary settled', 'transport cleaned', 'release started', 'release finished', ...(released ? ['published'] : [])])
    expect(bus).toHaveBeenCalledTimes(released ? 1 : 0)
    if (released) expect(bus).toHaveBeenCalledWith({ kind: 'turn_completed', sessionId: 'session', payload: { senderUserId: 'actor', turnId: 'a'.repeat(64) } })
  })
})
