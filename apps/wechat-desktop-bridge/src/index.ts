/**
 * wechat-desktop-bridge: mirrors a personal WeChat account (driven by the
 * agent-wechat container) into a Use Brian custom channel.
 *
 * Boot order (docs/architecture/channels/wechat-desktop.md): parse env →
 * GET /hello (401/404 fatal) → wait for the container's /health → start the
 * login supervisor, the monitor and the outbox worker. The only listener is a
 * local /health for the compose healthcheck.
 */
import express from 'express'
import { createAgentWechatClient } from './agent-wechat-client.js'
import { createBrianBridgeClient, FatalConfigError } from './brian-bridge-client.js'
import { bridgeVersionString } from './build-info.js'
import { ConfigError, parseConfig } from './config.js'
import { consoleLogger as log, errorMessage, sleep } from './log.js'
import { createLoginSupervisor } from './login-supervisor.js'
import { createMonitor } from './monitor.js'
import { createOutboxWorker } from './outbox-worker.js'
import { FEATURE_MEDIA_STREAM, FEATURE_MEDIA_UPGRADE } from './protocol-types.js'
import { loadStateFile } from './state-file.js'

async function main(): Promise<void> {
  let config
  try {
    config = parseConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message)
      process.exit(2)
    }
    throw err
  }

  const bridgeVersion = bridgeVersionString()
  log.info(`wechat-desktop-bridge ${bridgeVersion} starting (channel ${config.BRIAN_CHANNEL_ID})`)

  const bridge = createBrianBridgeClient({
    apiUrl: config.BRIAN_API_URL,
    channelId: config.BRIAN_CHANNEL_ID,
    token: config.BRIAN_BRIDGE_TOKEN,
  })
  const agent = createAgentWechatClient({ baseUrl: config.AGENT_WECHAT_URL, token: config.AGENT_WECHAT_TOKEN })

  // 1. hello: a wrong token / deleted channel is a config error, not a retry.
  let hello
  try {
    hello = await bridge.hello()
  } catch (err) {
    if (err instanceof FatalConfigError) {
      console.error(err.message)
      process.exit(3)
    }
    console.error(`Could not reach Use Brian at ${config.BRIAN_API_URL}: ${errorMessage(err)}`)
    process.exit(4)
  }
  log.info(`hello ok: channel "${hello.displayName}" (workspace ${hello.workspaceId}, protocol ${hello.protocol})`)
  if (hello.protocol !== 1) {
    console.error(`Use Brian speaks bridge protocol ${hello.protocol}; this bridge speaks 1. Upgrade the bridge.`)
    process.exit(5)
  }
  const mediaUpgradeEnabled = hello.features?.includes(FEATURE_MEDIA_UPGRADE) === true
  const mediaStreamEnabled = hello.features?.includes(FEATURE_MEDIA_STREAM) === true
  log.info(
    mediaUpgradeEnabled
      ? 'server supports media_upgrade: durable attachment recovery enabled'
      : 'server does not advertise media_upgrade: archive upgrades disabled',
  )
  log.info(
    mediaStreamEnabled
      ? 'server supports media_stream: ready attachment bytes use raw uploads'
      : 'server does not advertise media_stream: attachment bytes use the legacy inline path',
  )

  // /health listener first so compose sees us while we wait for the container.
  const app = express()
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', bridgeVersion, loggedIn: supervisor?.isLoggedIn() ?? false })
  })
  const server = app.listen(config.BRIDGE_PORT, () => log.info(`health listener on :${config.BRIDGE_PORT}`))

  // 2. wait for agent-wechat (the container takes ~30 s to come up).
  let supervisor: ReturnType<typeof createLoginSupervisor> | null = null
  const fatal = (err: unknown): void => {
    console.error(`fatal: ${errorMessage(err)}`)
    shutdown(3)
  }
  await bridge.putState({ status: 'connecting', message: 'Waiting for the agent-wechat container.', bridgeVersion, capabilities: { documents: true } }).catch(
    (err) => (err instanceof FatalConfigError ? fatal(err) : log.warn(`state publish failed: ${errorMessage(err)}`)),
  )
  let backoff = 1000
  while (!(await agent.health())) {
    log.info(`agent-wechat not ready at ${config.AGENT_WECHAT_URL}; retrying in ${backoff} ms`)
    await sleep(backoff)
    backoff = Math.min(backoff * 2, 15_000)
  }
  log.info('agent-wechat is up')

  // 3. loops.
  const { state, fresh } = await loadStateFile(config.BRIDGE_STATE_FILE)
  if (fresh) {
    log.info(
      config.BACKFILL_ON_FIRST_BOOT
        ? 'fresh state file: BACKFILL_ON_FIRST_BOOT is set, replaying history into the channel'
        : 'fresh state file: cursors will seed at each chat\'s current last message (no backfill)',
    )
  }

  supervisor = createLoginSupervisor({ agent, bridge, bridgeVersion, log, onFatal: fatal })
  const monitor = createMonitor({
    agent,
    bridge,
    state,
    stateFilePath: config.BRIDGE_STATE_FILE,
    pollIntervalMs: config.POLL_INTERVAL_MS,
    backfillOnFirstBoot: config.BACKFILL_ON_FIRST_BOOT,
    isLoggedIn: () => supervisor?.isLoggedIn() ?? false,
    mediaUpgradeEnabled,
    mediaStreamEnabled,
    log,
    onFatal: fatal,
  })
  const outbox = createOutboxWorker({
    agent,
    bridge,
    onDisconnect: () => supervisor!.disconnect(),
    log,
    onFatal: fatal,
  })

  await supervisor.start()
  monitor.start()
  outbox.start()
  log.info('loops started')

  let shuttingDown = false
  function shutdown(code = 0): void {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down')
    outbox.stop()
    monitor.stop()
    supervisor?.stop()
    server.close()
    setTimeout(() => process.exit(code), 500).unref()
  }
  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(0))
}

main().catch((err) => {
  console.error(`wechat-desktop-bridge failed to start: ${errorMessage(err)}`)
  process.exit(1)
})
