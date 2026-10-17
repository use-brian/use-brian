/** A separate persisted business system. Brian reaches it only by authenticated HTTP/MCP. */
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Pool, PoolClient } from 'pg'
import express from 'express'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { authorizeConnectorRequest, handleSourceSidecar, sourceSubjectFromActor, sourceSubjectKey, sourceResourceKey,
  SOURCE_PROTOCOL_VERSION, type ConnectorActorClaims, type SourceSubject, type SourceResourceRef,
  type SourceEnvelope, type SourceAuthorizationRequest, type SourceAuthorizationResponse, type SourceCapabilities,
  type createConnectorActorVerifier } from '@use-brian/brian-app/connector'

export const independentSourceSchema = `
 CREATE TABLE accounts(kind text NOT NULL,id uuid NOT NULL,active boolean NOT NULL DEFAULT true,PRIMARY KEY(kind,id));
 CREATE TABLE assistants(id uuid PRIMARY KEY,active boolean NOT NULL DEFAULT true);
 CREATE TABLE records(id text PRIMARY KEY,kind text NOT NULL,content_version int NOT NULL DEFAULT 1,policy_version int NOT NULL DEFAULT 1,
   data jsonb NOT NULL,compartments text[] NOT NULL DEFAULT '{}',withdrawn boolean NOT NULL DEFAULT false);
 CREATE TABLE grants(kind text NOT NULL,account_id uuid NOT NULL,record_id text NOT NULL REFERENCES records(id),
   fields text[] NOT NULL,actions text[] NOT NULL,PRIMARY KEY(kind,account_id,record_id),FOREIGN KEY(kind,account_id) REFERENCES accounts(kind,id));
 CREATE TABLE commands(kind text NOT NULL,account_id uuid NOT NULL,assistant_id uuid NOT NULL,idempotency_key text NOT NULL,
   request_hash text NOT NULL,receipt text NOT NULL,record_id text NOT NULL,version int NOT NULL,PRIMARY KEY(kind,account_id,assistant_id,idempotency_key));
`
type Query = Pick<Pool | PoolClient, 'query'>
type SourceRecord = { id: string; kind: string; content_version: number; policy_version: number; data: Record<string, unknown>; compartments: string[]; withdrawn: boolean }
export async function startIndependentSource(input: { pool: Pool; tenant: string; transportToken: string;
  verifyActor: ReturnType<typeof createConnectorActorVerifier>; uiSessions: Map<string, SourceSubject> }) {
  const { pool, tenant } = input
  const capabilities: SourceCapabilities = { version: SOURCE_PROTOCOL_VERSION, tenant, retentionModes: ['governed'], fieldEvidence: true, reconciliation: true }
  const counters = { reads: 0, authorizations: 0, effects: 0, reconciliations: 0 }
  let afterRead: (() => Promise<void>) | undefined
  const actorKnown = async (db: Query, subject: SourceSubject) => Boolean((await db.query(
    'SELECT 1 FROM accounts a JOIN assistants s ON s.id=$3 AND s.active WHERE a.kind=$1 AND a.id=$2 AND a.active FOR SHARE OF a,s',
    [subject.kind,subject.id,subject.executingAssistantId])).rowCount)
  const currentRecord = async (db: Query, id: string, lock = false) => (await db.query<SourceRecord>(`SELECT * FROM records WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]
  // Ordinary UI reads, connector reads, authorize and mutations all call this same source ACL.
  async function allowed(db: Query, subject: SourceSubject, record: SourceRecord | undefined, fields: string[], action: string) {
    if (!record || record.withdrawn || !fields.length || !await actorKnown(db, subject)) return false
    const grant = (await db.query<{ fields: string[]; actions: string[] }>('SELECT fields,actions FROM grants WHERE kind=$1 AND account_id=$2 AND record_id=$3 FOR SHARE',
      [subject.kind,subject.id,record.id])).rows[0]
    return Boolean(grant && fields.every(field => grant.fields.includes(field) && Object.hasOwn(record.data, field)) && grant.actions.includes(action))
  }
  function ref(record: SourceRecord): SourceResourceRef {
    return { type: record.kind, id: record.id, contentVersion: String(record.content_version), policyVersion: String(record.policy_version) }
  }
  function evidence(record: SourceRecord, subject: SourceSubject, fields: string[]): SourceEnvelope {
    return { version: SOURCE_PROTOCOL_VERSION, tenant, resources: [{ resource: ref(record), fields,
      labels: { sensitivity: 'confidential', compartments: record.compartments, projectIds: [] }, subjects: [subject],
      actions: ['read','context','derive','retain','deliver','export'], retention: { mode: 'governed' }, export: { model: true, destinations: [] } }] }
  }
  async function read(subject: SourceSubject, id: string, fields: string[]) {
    const record = await currentRecord(pool, id)
    if (!await allowed(pool, subject, record, fields, 'read')) return null
    counters.reads++
    const output = { data: Object.fromEntries(fields.map(field => [field,record.data[field]])), envelope: evidence(record, subject, fields) }
    await afterRead?.()
    return output
  }
  async function authorize(actor: Readonly<ConnectorActorClaims>, request: SourceAuthorizationRequest): Promise<SourceAuthorizationResponse> {
    counters.authorizations++
    const caller = sourceSubjectFromActor(actor), decisions: SourceAuthorizationResponse['decisions'] = []
    for (const item of request.items) {
      const record = await currentRecord(pool, item.resource.id)
      for (const recipient of request.recipients) {
        // No acting on behalf of arbitrary recipients: requester must also hold the requested source action.
        const permitted = record && sourceResourceKey(ref(record)) === sourceResourceKey(item.resource)
          && item.retentionMode === 'governed' && await allowed(pool, caller, record, item.fields, item.action)
          && await allowed(pool, recipient.subject, record, item.fields, item.action)
        const pair = { itemId: item.itemId, recipientId: recipient.recipientId }
        decisions.push(permitted ? { ...pair, allowed: true, receipt: { id: randomUUID(), issuedAt: Date.now(), expiresAt: Date.now() + 4_500 } }
          : { ...pair, allowed: false })
      }
    }
    return { version: SOURCE_PROTOCOL_VERSION, tenant, operationId: request.operationId, decisions }
  }
  async function update(actor: Readonly<ConnectorActorClaims>, id: string, expectedVersion: string, values: Record<string, string>, idempotencyKey: string) {
    const subject = sourceSubjectFromActor(actor), db = await pool.connect()
    try {
      await db.query('BEGIN')
      const record = await currentRecord(db, id, true), fields = Object.keys(values)
      if (!await allowed(db, subject, record, fields, 'mutate')) throw new Error('source_access_denied')
      const requestHash = createHash('sha256').update(JSON.stringify([id,expectedVersion,Object.entries(values).sort(([a],[b]) => a.localeCompare(b))])).digest('hex')
      const existing = (await db.query<{ request_hash: string; receipt: string; version: number }>(
        'SELECT request_hash,receipt,version FROM commands WHERE kind=$1 AND account_id=$2 AND assistant_id=$3 AND idempotency_key=$4',
        [subject.kind,subject.id,subject.executingAssistantId,idempotencyKey])).rows[0]
      if (existing) {
        if (existing.request_hash !== requestHash) throw new Error('idempotency_conflict')
        await db.query('COMMIT'); return { receipt: existing.receipt, version: String(existing.version) }
      }
      if (String(record.content_version) !== expectedVersion) throw new Error('version_conflict')
      const receipt = randomUUID(), version = record.content_version + 1
      await db.query('UPDATE records SET data=data||$2::jsonb,content_version=$3 WHERE id=$1', [id,JSON.stringify(values),version])
      await db.query('INSERT INTO commands(kind,account_id,assistant_id,idempotency_key,request_hash,receipt,record_id,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [subject.kind,subject.id,subject.executingAssistantId,idempotencyKey,requestHash,receipt,id,version])
      await db.query('COMMIT'); counters.effects++; return { receipt, version: String(version) }
    } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
  }
  const app = express(); app.use(express.json({ limit: '512kb', verify: (req, _res, bytes) => { (req as typeof req & { sourceBytes: Buffer }).sourceBytes = Buffer.from(bytes) } }))
  const requestAuth = (req: express.Request) => ({ assertion: String(req.headers['x-usebrian-actor-assertion'] ?? ''),
    request: { method: req.method, target: req.originalUrl, body: (req as express.Request & { sourceBytes?: Buffer }).sourceBytes ?? new Uint8Array() },
    authenticateTransport: async () => req.headers.authorization === `Bearer ${input.transportToken}`, verifyActor: input.verifyActor })
  app.post('/usebrian/source/:endpoint', async (req, res) => {
    try {
      const endpoint = req.params.endpoint
      if (!['capabilities','authorize','reconcile'].includes(endpoint)) { res.sendStatus(404); return }
      const result = await handleSourceSidecar({ ...requestAuth(req), endpoint: endpoint as 'capabilities' | 'authorize' | 'reconcile' }, {
        capabilities: async actor => await actorKnown(pool, sourceSubjectFromActor(actor)) ? capabilities : null, authorize,
        reconcile: async (actor, request) => {
          counters.reconciliations++
          const subject = sourceSubjectFromActor(actor), command = (await pool.query<{ receipt: string; record_id: string }>(
            'SELECT receipt,record_id FROM commands WHERE kind=$1 AND account_id=$2 AND assistant_id=$3 AND idempotency_key=$4',
            [subject.kind,subject.id,subject.executingAssistantId,request.idempotencyKey])).rows[0]
          if (!command) return { version: SOURCE_PROTOCOL_VERSION, tenant, state: 'not_applied' }
          const record = await currentRecord(pool, command.record_id)
          if (!await allowed(pool, subject, record, Object.keys(record?.data ?? {}), 'mutate')
            || request.receipt !== undefined && request.receipt !== command.receipt) return { version: SOURCE_PROTOCOL_VERSION, tenant, state: 'uncertain' }
          return { version: SOURCE_PROTOCOL_VERSION, tenant, state: 'applied', receipt: command.receipt }
        },
      }); res.json(result)
    } catch { res.status(403).json({ error: 'source_unavailable' }) }
  })
  app.get('/ui/records/:id', async (req, res) => {
    const subject = input.uiSessions.get(String(req.headers.authorization ?? '').replace(/^Bearer /,''))
    if (!subject) { res.sendStatus(401); return }
    const fields = String(req.query.fields ?? '').split(',').filter(Boolean), result = await read(subject, req.params.id, fields)
    if (!result) { res.sendStatus(403); return }; res.json(result.data)
  })
  app.post('/http/read', async (req, res) => {
    try {
      const { value } = await authorizeConnectorRequest({ ...requestAuth(req), authorize: async actor => {
        const parsed = z.object({ id: z.string(), fields: z.array(z.string()).min(1).max(256) }).strict().parse(req.body)
        const value = await read(sourceSubjectFromActor(actor), parsed.id, parsed.fields)
        return value ? { allowed: true, value } : { allowed: false }
      } }); res.json(value)
    } catch { res.status(403).json({ error: 'source_access_denied' }) }
  })
  app.all('/mcp', async (req, res) => {
    try {
      const { actor } = await authorizeConnectorRequest({ ...requestAuth(req), authorize: async actor => ({ allowed: await actorKnown(pool, sourceSubjectFromActor(actor)), value: null }) })
      const server = new McpServer({ name: 'Independent reference source', version: '1' })
      server.registerTool('readRecord', { inputSchema: { id: z.string(), fields: z.array(z.string()).min(1).max(256) }, annotations: { readOnlyHint: true } }, async ({ id, fields }) => {
        const result = await read(sourceSubjectFromActor(actor), id, fields)
        return result ? { content: [{ type: 'text', text: JSON.stringify(result.data) }], _meta: { [SOURCE_PROTOCOL_VERSION]: result.envelope } }
          : { isError: true, content: [{ type: 'text', text: 'source_access_denied' }] }
      })
      server.registerTool('updateRecord', { inputSchema: { id: z.string(), expectedVersion: z.string(), values: z.record(z.string()), idempotencyKey: z.string().min(1).max(256) } }, async args => {
        try { const result = await update(actor, args.id, args.expectedVersion, args.values, args.idempotencyKey)
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch { return { isError: true, content: [{ type: 'text', text: 'source_effect_unavailable' }] } }
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.once('close', () => { void transport.close(); void server.close() })
      await server.connect(transport); await transport.handleRequest(req, res, req.body)
    } catch { res.status(403).json({ error: 'source_access_denied' }) }
  })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, counters, setAfterRead: (next?: () => Promise<void>) => { afterRead = next },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}
