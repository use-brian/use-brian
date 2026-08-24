/**
 * Feishu/Lark inbound long-connection bridge.
 * Outbound sends stay API -> provider REST; this app owns socket lifecycle only.
 */

import express from 'express'
import { connectorSecretMatches } from './auth.js'
import { getEnv } from './env.js'
import { createFeishuConnectorManager } from './manager.js'

const env = getEnv()
const app = express()
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.use((req, res, next) => {
  if (!connectorSecretMatches(req.headers['x-connector-secret'], env.FEISHU_CONNECTOR_SECRET)) {
    res.status(401).json({ error: 'Invalid or missing X-Connector-Secret' })
    return
  }
  next()
})

const manager = createFeishuConnectorManager({
  apiUrl: env.USEBRIAN_API_URL,
  connectorSecret: env.FEISHU_CONNECTOR_SECRET,
})

app.post('/connect/:channelId', async (req, res) => {
  const body = req.body as { appId?: string; appSecret?: string; brand?: 'feishu' | 'lark' }
  if (!body.appId || !body.appSecret || (body.brand !== 'feishu' && body.brand !== 'lark')) {
    res.status(400).json({ error: 'appId, appSecret, and brand are required' })
    return
  }
  try {
    const status = await manager.connect(req.params.channelId, {
      appId: body.appId,
      appSecret: body.appSecret,
      brand: body.brand,
    })
    res.json(status)
  } catch (error) {
    res.status(502).json({
      error: 'Feishu/Lark connection failed',
      code: error && typeof error === 'object'
        ? (error as { code?: string }).code ?? 'unknown'
        : 'unknown',
    })
  }
})

app.post('/disconnect/:channelId', async (req, res) => {
  await manager.disconnect(req.params.channelId)
  res.json({ ok: true })
})

app.get('/status/:channelId', (req, res) => {
  const status = manager.getStatus(req.params.channelId)
  if (!status) {
    res.status(404).json({ error: 'not_connected' })
    return
  }
  res.json(status)
})

const server = app.listen(env.PORT, async () => {
  console.log(`feishu-connector listening on port ${env.PORT}`)
  try {
    await manager.restoreAll()
  } catch (error) {
    console.error(
      '[feishu-connector] restore failed:',
      error && typeof error === 'object' ? (error as { code?: string }).code ?? 'unknown' : 'unknown',
    )
  }
})

async function shutdown(): Promise<void> {
  console.log('Shutting down feishu-connector...')
  server.close()
  await manager.disconnectAll()
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
