/** Service-only outbound transport; no model/COO impersonation. [COMP:channels/feishu-notifications] */
import { createHash } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { Pool } from 'pg'
import type { ChannelIntegrationStore, FeishuCredentials } from '../db/channel-integrations.js'
import { sendFeishuNotification } from '../feishu/client.js'

const inputSchema = z.object({ id: z.string().uuid(), recipientKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  title: z.string().trim().min(1).max(100), text: z.string().trim().min(1).max(2000), url: z.string().url().max(2048) }).strict()
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
type Client = { id: string; workspace_id: string; assistant_id: string; integration_id: string; app_origin: string }
type Receipt = { id: string; request_hash: string; status: string; message_id: string | null; error_code: string | null; updated_at: Date }
const publicReceipt = (r: Receipt) => ({ id: r.id, status: r.status === 'sending' && Date.now() - new Date(r.updated_at).getTime() > 60000 ? 'uncertain' : r.status,
  ...(r.message_id ? { messageId: r.message_id } : {}), ...(r.error_code ? { errorCode: r.error_code } : {}) })
export function feishuNotificationRoutes(options: { pool: Pool; integrations: ChannelIntegrationStore;
  send?: typeof sendFeishuNotification }): Router {
  const router = Router(), pool = options.pool
  router.use(async (req, res, next) => {
    const authorization = req.get('authorization') ?? ''
    if (!/^Bearer bn_[A-Za-z0-9_-]{40,}$/.test(authorization)) { res.status(401).json({ error: 'notification_unauthorized' }); return }
    try {
      const found = await pool.query<Client>('SELECT id,workspace_id,assistant_id,integration_id,app_origin FROM feishu_notification_clients WHERE token_hash=$1 AND enabled AND expires_at>now()', [hash(authorization.slice(7))])
      if (found.rows.length !== 1) { res.status(401).json({ error: 'notification_unauthorized' }); return }
      res.locals.notificationClient = found.rows[0]; next()
    } catch { res.status(503).json({ error: 'notification_unavailable' }) }
  })
  router.get('/:id', async (req,res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) { res.status(400).json({ error: 'invalid_id' }); return }
    const client = res.locals.notificationClient as Client
    try {
      const result = await pool.query<Receipt>('SELECT * FROM feishu_notification_receipts WHERE client_id=$1 AND id=$2', [client.id,req.params.id])
      const receipt = result.rows[0]
      if (!receipt || receipt.status === 'not_sent') { res.status(404).json({ error: 'notification_not_found' }); return }
      res.json(publicReceipt(receipt))
    } catch { res.status(503).json({ error: 'notification_unavailable' }) }
  })
  router.post('/', async (req,res) => {
    const parsed = inputSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'notification_invalid' }); return }
    const body = parsed.data, client = res.locals.notificationClient as Client, url = new URL(body.url)
    if (url.protocol !== 'https:' || url.origin !== client.app_origin || url.username || url.password) { res.status(403).json({ error: 'notification_destination_denied' }); return }
    const digest = hash(JSON.stringify(body))
    const providerHash = hash(client.id + ':' + body.id)
    const providerId = `${providerHash.slice(0,8)}-${providerHash.slice(8,12)}-4${providerHash.slice(13,16)}-a${providerHash.slice(17,20)}-${providerHash.slice(20,32)}`
    let reserved = false
    try {
      const previous = (await pool.query<Receipt>('SELECT * FROM feishu_notification_receipts WHERE client_id=$1 AND id=$2', [client.id,body.id])).rows[0]
      if (previous && previous.request_hash !== digest) { res.status(409).json({ error: 'notification_id_conflict' }); return }
      if (previous && previous.status !== 'not_sent') { res.json(publicReceipt(previous)); return }
      const recipient = (await pool.query<{open_id:string}>('SELECT r.open_id FROM feishu_notification_recipients r JOIN feishu_notification_clients c ON c.id=r.client_id WHERE r.client_id=$1 AND r.recipient_key=$2 AND r.enabled AND c.enabled AND c.expires_at>now()', [client.id,body.recipientKey])).rows[0]
      if (!recipient) { res.status(403).json({ error: 'notification_recipient_denied' }); return }
      const integration = await options.integrations.getCredentialsForAssistantIntegrationSystem(client.workspace_id,client.assistant_id,client.integration_id,'feishu',recipient.open_id)
      if (!integration || integration.status !== 'active') { res.status(503).json({ error: 'notification_integration_unavailable' }); return }
      const credentials = integration.credentials as FeishuCredentials
      if (!credentials.app_id || !credentials.app_secret || !['feishu','lark'].includes(credentials.brand)) { res.status(503).json({ error: 'notification_integration_unavailable' }); return }
      const reservation = await pool.query<Receipt>(`INSERT INTO feishu_notification_receipts(client_id,id,request_hash,recipient_key,open_id,status)
        SELECT $1,$2,$3,$4,$5,'sending' WHERE EXISTS(SELECT 1 FROM feishu_notification_clients c JOIN feishu_notification_recipients r ON r.client_id=c.id WHERE c.id=$1 AND c.enabled AND c.expires_at>now() AND r.recipient_key=$4 AND r.open_id=$5 AND r.enabled)
        ON CONFLICT(client_id,id) DO UPDATE SET status='sending',error_code=NULL,updated_at=now()
        WHERE feishu_notification_receipts.status='not_sent' AND feishu_notification_receipts.request_hash=excluded.request_hash AND feishu_notification_receipts.open_id=excluded.open_id RETURNING *`, [client.id,body.id,digest,body.recipientKey,recipient.open_id])
      if (!reservation.rowCount) {
        const receipt = (await pool.query<Receipt>('SELECT * FROM feishu_notification_receipts WHERE client_id=$1 AND id=$2', [client.id,body.id])).rows[0]
        if (!receipt || receipt.request_hash !== digest) { res.status(409).json({ error: 'notification_id_conflict' }); return }
        res.json(publicReceipt(receipt)); return
      }
      reserved = true
      const outcome = await (options.send ?? sendFeishuNotification)({ appId: credentials.app_id, appSecret: credentials.app_secret, brand: credentials.brand },
        { id: providerId, openId: recipient.open_id, text: `${body.title}\n${body.text}\n${body.url}` })
      const receipt = (await pool.query<Receipt>('UPDATE feishu_notification_receipts SET status=$3,message_id=$4,error_code=$5,updated_at=now() WHERE client_id=$1 AND id=$2 RETURNING *',
        [client.id,body.id,outcome.status,outcome.messageId ?? null,outcome.errorCode ?? null])).rows[0]
      res.json(publicReceipt(receipt))
    } catch {
      if (reserved) await pool.query("UPDATE feishu_notification_receipts SET status='uncertain',error_code='provider_uncertain',updated_at=now() WHERE client_id=$1 AND id=$2 AND status='sending'", [client.id,body.id]).catch(()=>undefined)
      res.status(503).json({ error: 'notification_unavailable' })
    }
  })
  return router
}
