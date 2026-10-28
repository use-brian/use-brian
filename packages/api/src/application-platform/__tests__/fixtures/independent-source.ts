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
  SOURCE_PROTOCOL_VERSION, parseSourceAuthorizationRequest, sourceEffectDigest, ConnectorActorError, SourceProtocolError, type ConnectorReplayConsumer, type ConnectorActorClaims, type SourceSubject, type SourceResourceRef,
  type SourceEnvelope, type SourceRetention, type SourceRetentionMode, type SourceAction, type SourceAuthorizationRequest, type SourceAuthorizationResponse, type SourceCapabilities,
  type createConnectorActorVerifier } from '@use-brian/brian-app/connector'

export const independentSourceSchema = `
 CREATE TABLE accounts(kind text NOT NULL,id uuid NOT NULL,active boolean NOT NULL DEFAULT true,administrative boolean NOT NULL DEFAULT false,PRIMARY KEY(kind,id));
 CREATE TABLE assistants(id uuid PRIMARY KEY,active boolean NOT NULL DEFAULT true);
 CREATE TABLE actor_replays(key text PRIMARY KEY,expires_at bigint NOT NULL);
 CREATE TABLE records(id text PRIMARY KEY,kind text NOT NULL,content_version int NOT NULL DEFAULT 1,policy_version int NOT NULL DEFAULT 1,
   data jsonb NOT NULL,compartments text[] NOT NULL DEFAULT '{}',withdrawn boolean NOT NULL DEFAULT false);
 CREATE TABLE record_history(record_id text NOT NULL,content_version int NOT NULL,policy_version int NOT NULL,before_image jsonb NOT NULL,
   PRIMARY KEY(record_id,content_version,policy_version));
 CREATE TABLE grants(kind text NOT NULL,account_id uuid NOT NULL,record_id text NOT NULL REFERENCES records(id),
   fields text[] NOT NULL,actions text[] NOT NULL,PRIMARY KEY(kind,account_id,record_id),FOREIGN KEY(kind,account_id) REFERENCES accounts(kind,id));
 CREATE TABLE releases(id text PRIMARY KEY,record_id text NOT NULL REFERENCES records(id),resource jsonb NOT NULL,fields text[] NOT NULL,
   actions text[] NOT NULL,subjects jsonb NOT NULL,expires_at bigint NOT NULL,revoked boolean NOT NULL DEFAULT false);
 CREATE TABLE commands(kind text NOT NULL,account_id uuid NOT NULL,assistant_id uuid NOT NULL,idempotency_key text NOT NULL,
   request_hash text NOT NULL,effect_digest text NOT NULL,receipt text NOT NULL,record_id text NOT NULL,version int NOT NULL,PRIMARY KEY(kind,account_id,assistant_id,idempotency_key));
`
/** Shared atomic replay state survives another verifier/process using this same source database. */
export function independentSourceReplayConsumer(pool: Pool, maximumEntries = 10_000): ConnectorReplayConsumer {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 1_000_000) throw new RangeError('Invalid replay capacity')
  return async ({ key, expiresAt, now }) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('reference-source-actor-replay',0))")
      await client.query('DELETE FROM actor_replays WHERE expires_at<=$1', [now])
      if ((await client.query('SELECT key FROM actor_replays WHERE key=$1', [key])).rowCount) { await client.query('COMMIT'); return false }
      if ((await client.query<{ count: number }>('SELECT count(*)::int AS count FROM actor_replays')).rows[0].count >= maximumEntries) throw new ConnectorActorError('assertion_unavailable')
      await client.query('INSERT INTO actor_replays(key,expires_at) VALUES($1,$2)', [key,expiresAt])
      await client.query('COMMIT'); return true
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
}
type Query = Pick<Pool | PoolClient, 'query'>
type SourceRecord = { id: string; kind: string; content_version: number; policy_version: number; data: Record<string, unknown>; compartments: string[]; withdrawn: boolean }
export async function startIndependentSource(input: { pool: Pool; tenant: string; transportToken: string;
  verifyActor: ReturnType<typeof createConnectorActorVerifier>; uiSessions: Map<string, SourceSubject>; retentionModes?: SourceRetentionMode[]; pathPrefix?: '/api';
  attendedActions?: {idempotencyMetadataKey:string} }) {
  const { pool, tenant } = input
  const capabilities: SourceCapabilities = { version: SOURCE_PROTOCOL_VERSION, tenant, retentionModes: input.retentionModes ?? ['governed'], fieldEvidence: true, reconciliation: true, effectBinding: 'command_v1',
    ...(input.attendedActions ? {attendedActions:input.attendedActions} : {}) }
  const counters = { reads: 0, discoveries: 0, authorizations: 0, effects: 0, reconciliations: 0 }
  let afterRead: (() => Promise<void>) | undefined
  let afterEffect: (() => Promise<void>) | undefined
  let beforeEffect: (() => Promise<void>) | undefined
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
  function evidence(record: SourceRecord, subject: SourceSubject, fields: string[], actions: SourceAction[], retention: SourceRetention = { mode: 'governed' }): SourceEnvelope {
    return { version: SOURCE_PROTOCOL_VERSION, tenant, resources: [{ resource: ref(record), fields,
      labels: { sensitivity: 'confidential', compartments: record.compartments, projectIds: [] }, subjects: [subject],
      actions, retention, export: { model: true, destinations: retention.mode === 'ephemeral' ? ['private_web'] : [] } }] }
  }
  async function read(subject: SourceSubject, id: string, fields: string[], mode: SourceRetentionMode = 'governed', releaseId?: string) {
    const record = await currentRecord(pool, id)
    if (!capabilities.retentionModes.includes(mode) || !await allowed(pool, subject, record, fields, 'read')) return null
    const grant = (await pool.query<{ actions: SourceAction[] }>('SELECT actions FROM grants WHERE kind=$1 AND account_id=$2 AND record_id=$3', [subject.kind,subject.id,id])).rows[0]
    if (!grant) return null
    let retention: SourceRetention = { mode: mode === 'released_snapshot' ? 'governed' : mode }
    if (mode === 'released_snapshot') {
      const release = (await pool.query<{ expires_at: string }>(`SELECT expires_at FROM releases WHERE id=$1 AND record_id=$2 AND resource=$3::jsonb
        AND fields @> $4::text[] AND actions @> ARRAY['read','context'] AND subjects @> $5::jsonb AND NOT revoked AND expires_at>$6`,
        [releaseId,id,JSON.stringify(ref(record)),fields,JSON.stringify([subject]),Date.now()])).rows[0]
      if (!release || !releaseId) return null
      retention = { mode, releaseId, expiresAt: Number(release.expires_at) }
    }
    counters.reads++
    const output = { data: Object.fromEntries(fields.map(field => [field,record.data[field]])), envelope: evidence(record, subject, fields, grant.actions, retention) }
    await afterRead?.()
    return output
  }
  function effectMatchesRequest(request:SourceAuthorizationRequest) {
    const command=request.effect?z.object({id:z.string(),expectedVersion:z.string(),expectedPolicyVersion:z.string(),values:z.record(z.string()),idempotencyKey:z.string().min(1).max(256)}).strict().safeParse(request.effect.input):undefined
    return !request.effect || request.effect.tool==='updateRecord' && command?.success===true
      && command.data.idempotencyKey===request.effect.idempotencyKey && request.items.length===1
      && request.items.every(item=>item.action==='mutate'&&item.resource.id===command.data.id&&item.resource.contentVersion===command.data.expectedVersion&&item.resource.policyVersion===command.data.expectedPolicyVersion
        && item.fields.length===Object.keys(command.data.values).length && item.fields.every(field=>Object.hasOwn(command.data.values,field)))
  }
  async function authorize(actor: Readonly<ConnectorActorClaims>, request: SourceAuthorizationRequest): Promise<SourceAuthorizationResponse> {
    counters.authorizations++
    const caller = sourceSubjectFromActor(actor), decisions: SourceAuthorizationResponse['decisions'] = []
    const effectMatches=effectMatchesRequest(request)
    for (const item of request.items) {
      const current = await currentRecord(pool, item.resource.id)
      let record = current
      // This source explicitly retains governed history; Brian cannot infer this right.
      if (current && sourceResourceKey(ref(current)) !== sourceResourceKey(item.resource)
        && item.retentionMode === 'governed' && ['read','context','derive','retain'].includes(item.action)
        && item.resource.policyVersion === String(current.policy_version)) {
        record = (await pool.query<{before_image:SourceRecord}>(
          'SELECT before_image FROM record_history WHERE record_id=$1 AND content_version::text=$2 AND policy_version::text=$3',
          [item.resource.id,item.resource.contentVersion,item.resource.policyVersion])).rows[0]?.before_image
      }
      for (const recipient of request.recipients) {
        // No acting on behalf of arbitrary recipients: requester must also hold the requested source action.
        let permitted = Boolean(effectMatches && record && sourceResourceKey(ref(record)) === sourceResourceKey(item.resource)
          && capabilities.retentionModes.includes(item.retentionMode) && item.retentionMode !== 'released_snapshot'
          && await allowed(pool, caller, current, item.fields, item.action)
          && await allowed(pool, recipient.subject, current, item.fields, item.action)
          && await allowed(pool, caller, record, item.fields, item.action)
          && await allowed(pool, recipient.subject, record, item.fields, item.action))
        if (effectMatches && record && !record.withdrawn && item.retentionMode === 'released_snapshot' && item.release
          && await actorKnown(pool, caller) && await actorKnown(pool, recipient.subject)) {
          const release = await pool.query(`SELECT 1 FROM releases WHERE id=$1 AND record_id=$2 AND resource=$3::jsonb AND fields @> $4::text[]
            AND $5=ANY(actions) AND subjects @> $6::jsonb AND NOT revoked AND expires_at=$7 AND expires_at>$8`,
            [item.release.id,record.id,JSON.stringify(item.resource),item.fields,item.action,JSON.stringify([caller,recipient.subject]),item.release.expiresAt,Date.now()])
          permitted = capabilities.retentionModes.includes('released_snapshot') && release.rowCount === 1
        }
        const pair = { itemId: item.itemId, recipientId: recipient.recipientId }
        decisions.push(permitted ? { ...pair, allowed: true, receipt: { id: randomUUID(), issuedAt: Date.now(), expiresAt: Date.now() + (item.action === 'derive' ? 3_000 : 4_500) } }
          : { ...pair, allowed: false })
      }
    }
    return { version: SOURCE_PROTOCOL_VERSION, tenant, operationId: request.operationId, decisions }
  }
  async function update(actor: Readonly<ConnectorActorClaims>, id: string, expectedVersion: string, values: Record<string, string>, idempotencyKey: string, expectedPolicyVersion?:string) {
    await beforeEffect?.()
    const subject = sourceSubjectFromActor(actor), db = await pool.connect()
    try {
      await db.query('BEGIN')
      const record = await currentRecord(db, id, true), fields = Object.keys(values)
      if (!await allowed(db, subject, record, fields, 'mutate')) throw new Error('source_access_denied')
      const requestHash = createHash('sha256').update(JSON.stringify([id,expectedVersion,Object.entries(values).sort(([a],[b]) => a.localeCompare(b)),...(expectedPolicyVersion===undefined?[]:[expectedPolicyVersion])])).digest('hex')
      const existing = (await db.query<{ request_hash: string; receipt: string; version: number }>(
        'SELECT request_hash,receipt,version FROM commands WHERE kind=$1 AND account_id=$2 AND assistant_id=$3 AND idempotency_key=$4',
        [subject.kind,subject.id,subject.executingAssistantId,idempotencyKey])).rows[0]
      if (existing) {
        if (existing.request_hash !== requestHash) throw new Error('idempotency_conflict')
        await db.query('COMMIT'); return { receipt: existing.receipt, version: String(existing.version) }
      }
      if(expectedPolicyVersion!==undefined&&String(record.policy_version)!==expectedPolicyVersion)throw new Error('policy_version_conflict')
      if (String(record.content_version) !== expectedVersion) throw new Error('version_conflict')
      const receipt = randomUUID(), version = record.content_version + 1
      await db.query('INSERT INTO record_history(record_id,content_version,policy_version,before_image) VALUES($1,$2,$3,$4)',[id,record.content_version,record.policy_version,record])
      await db.query('UPDATE records SET data=data||$2::jsonb,content_version=$3 WHERE id=$1', [id,JSON.stringify(values),version])
      await db.query('INSERT INTO commands(kind,account_id,assistant_id,idempotency_key,request_hash,effect_digest,receipt,record_id,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [subject.kind,subject.id,subject.executingAssistantId,idempotencyKey,requestHash,sourceEffectDigest({tool:'updateRecord',input:{id,expectedVersion,values,idempotencyKey,...(expectedPolicyVersion===undefined?{}:{expectedPolicyVersion})},idempotencyKey}),receipt,id,version])
      await db.query('COMMIT'); counters.effects++; await afterEffect?.(); return { receipt, version: String(version) }
    } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
  }
  const app = express(); app.use(express.json({ limit: '512kb', verify: (req, _res, bytes) => { (req as typeof req & { sourceBytes: Buffer }).sourceBytes = Buffer.from(bytes) } }))
  const requestAuth = (req: express.Request) => ({ assertion: String(req.headers['x-usebrian-actor-assertion'] ?? ''),
    request: { method: req.method, target: req.originalUrl, body: (req as express.Request & { sourceBytes?: Buffer }).sourceBytes ?? new Uint8Array() },
    authenticateTransport: async () => req.headers.authorization === `Bearer ${input.transportToken}`, verifyActor: input.verifyActor })
  app.post(`${input.pathPrefix ?? ''}/usebrian/source/:endpoint`, async (req, res) => {
    try {
      const endpoint = req.params.endpoint
      if (!['capabilities','authorize','reconcile'].includes(endpoint)) { res.sendStatus(404); return }
      const result = await handleSourceSidecar({ ...requestAuth(req), endpoint: endpoint as 'capabilities' | 'authorize' | 'reconcile' }, {
        capabilities: async actor => await actorKnown(pool, sourceSubjectFromActor(actor)) ? capabilities : null, authorize,
        reconcile: async (actor, request) => {
          counters.reconciliations++
          const subject = sourceSubjectFromActor(actor), command = (await pool.query<{ receipt: string; record_id: string; effect_digest: string }>(
            'SELECT receipt,record_id,effect_digest FROM commands WHERE kind=$1 AND account_id=$2 AND assistant_id=$3 AND idempotency_key=$4',
            [subject.kind,subject.id,subject.executingAssistantId,request.idempotencyKey])).rows[0]
          if (!command) return { version: SOURCE_PROTOCOL_VERSION, tenant, state: request.effectDigest?'uncertain':'not_applied' }
          if(request.effectDigest && (!request.authorization || !effectMatchesRequest(request.authorization)
            ||request.authorization.recipients.length!==1||sourceSubjectKey(request.authorization.recipients[0].subject)!==sourceSubjectKey(subject)
            ||request.authorization.items.some(item=>item.resource.id!==command.record_id)))return {version:SOURCE_PROTOCOL_VERSION,tenant,state:'uncertain'}
          const record = await currentRecord(pool, command.record_id)
          if (request.authorization?.items.some(item=>item.resource.type!==record?.kind||item.resource.policyVersion!==String(record?.policy_version))
            ||!await allowed(pool, subject, record, request.authorization?.items[0].fields??Object.keys(record?.data ?? {}), 'mutate')
            || request.receipt !== undefined && request.receipt !== command.receipt
            || request.effectDigest !== undefined && request.effectDigest !== command.effect_digest) return { version: SOURCE_PROTOCOL_VERSION, tenant, state: 'uncertain' }
          return { version: SOURCE_PROTOCOL_VERSION, tenant, state: 'applied', receipt: command.receipt, effectDigest: command.effect_digest }
        },
      }); res.json(result)
    } catch (error) {
      // An infrastructure/ACL-store outage is unknown, never a negative grant.
      const refused=error instanceof ConnectorActorError||error instanceof SourceProtocolError&&error.code==='source_access_denied'
      res.status(refused?403:503).json({error:refused?'source_access_denied':'source_unavailable'})
    }
  })
  // Independent source administration. Brian assertions and transport tokens cannot grant source rights.
  app.post(`${input.pathPrefix ?? ''}/ui/grants`,async(req,res)=>{
    const subject=input.uiSessions.get(String(req.headers.authorization??'').replace(/^Bearer /,''))
    if(!subject||!await actorKnown(pool,subject)||(await pool.query('SELECT 1 FROM accounts WHERE kind=$1 AND id=$2 AND administrative AND active',[subject.kind,subject.id])).rowCount!==1){res.sendStatus(403);return}
    const parsed=z.object({kind:z.enum(['human','service']),accountId:z.string().uuid(),assistantId:z.string().uuid(),recordId:z.string(),fields:z.array(z.string()).min(1),actions:z.array(z.enum(['read','context','derive','retain','deliver','export','mutate'])).min(1)}).strict().safeParse(req.body)
    if(!parsed.success){res.sendStatus(400);return}const value=parsed.data,record=await currentRecord(pool,value.recordId)
    if(!record||value.fields.some(field=>!Object.hasOwn(record.data,field))){res.sendStatus(400);return}
    const db=await pool.connect();try{await db.query('BEGIN');await db.query('INSERT INTO accounts(kind,id) VALUES($1,$2) ON CONFLICT DO NOTHING',[value.kind,value.accountId]);await db.query('INSERT INTO assistants(id) VALUES($1) ON CONFLICT DO NOTHING',[value.assistantId]);await db.query('INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,account_id,record_id) DO UPDATE SET fields=excluded.fields,actions=excluded.actions',[value.kind,value.accountId,value.recordId,value.fields,value.actions]);await db.query('COMMIT');res.json({approved:true})}catch{await db.query('ROLLBACK');res.sendStatus(503)}finally{db.release()}
  })
  app.delete('/ui/grants',async(req,res)=>{
    const subject=input.uiSessions.get(String(req.headers.authorization??'').replace(/^Bearer /,''))
    if(!subject||!await actorKnown(pool,subject)||(await pool.query('SELECT 1 FROM accounts WHERE kind=$1 AND id=$2 AND administrative AND active',[subject.kind,subject.id])).rowCount!==1){res.sendStatus(403);return}
    const parsed=z.object({kind:z.enum(['human','service']),accountId:z.string().uuid(),recordId:z.string()}).strict().safeParse(req.body)
    if(!parsed.success){res.sendStatus(400);return}const v=parsed.data;await pool.query('DELETE FROM grants WHERE kind=$1 AND account_id=$2 AND record_id=$3',[v.kind,v.accountId,v.recordId]);res.json({revoked:true})
  })
  app.get(`${input.pathPrefix ?? ''}/ui/records/:id`, async (req, res) => {
    const subject = input.uiSessions.get(String(req.headers.authorization ?? '').replace(/^Bearer /,''))
    if (!subject) { res.sendStatus(401); return }
    const fields = String(req.query.fields ?? '').split(',').filter(Boolean), result = await read(subject, req.params.id, fields)
    if (!result) { res.sendStatus(403); return }; res.json(result.data)
  })
  app.post(`${input.pathPrefix ?? ''}/http/read`, async (req, res) => {
    try {
      const { value } = await authorizeConnectorRequest({ ...requestAuth(req), authorize: async actor => {
        const parsed = z.object({ id: z.string(), fields: z.array(z.string()).min(1).max(256) }).strict().parse(req.body)
        const value = await read(sourceSubjectFromActor(actor), parsed.id, parsed.fields)
        return value ? { allowed: true, value } : { allowed: false }
      } }); res.json(value)
    } catch { res.status(403).json({ error: 'source_access_denied' }) }
  })
  app.all(`${input.pathPrefix ?? ''}/mcp`, async (req, res) => {
    try {
      const { actor } = await authorizeConnectorRequest({ ...requestAuth(req), authorize: async actor => ({ allowed: await actorKnown(pool, sourceSubjectFromActor(actor)), value: null }) })
      if(req.body?.method==='tools/call'){
        const intent=req.body.params?._meta?.[SOURCE_PROTOCOL_VERSION]
        if((actor.actor.kind==='service'||actor.executionKind==='programmatic')&&!['read','mutate'].includes(intent?.intent)){res.status(403).json({error:'source_access_denied'});return}
        if(intent?.intent==='read'&&req.body.params?.name!=='readRecord'){res.status(403).json({error:'source_access_denied'});return}
        if(intent?.intent==='attended_action'&&(!input.attendedActions||actor.actor.kind!=='human'||actor.executionKind!=='attended'
          ||typeof req.body.params?._meta?.[input.attendedActions.idempotencyMetadataKey]!=='string'))throw new SourceProtocolError('source_access_denied')
        if(intent?.intent==='mutate'){
          const authorization=parseSourceAuthorizationRequest(intent.authorization),actual=req.body.params
          if(!authorization.effect||!effectMatchesRequest(authorization)||authorization.effect.tool!==actual.name
            ||sourceEffectDigest(authorization.effect)!==sourceEffectDigest({tool:actual.name,input:actual.arguments,idempotencyKey:actual.arguments?.idempotencyKey})
            ||authorization.recipients.length!==1||sourceSubjectKey(authorization.recipients[0].subject)!==sourceSubjectKey(sourceSubjectFromActor(actor)))throw new SourceProtocolError('source_access_denied')
          const decision=await authorize(actor,authorization)
          if(decision.decisions.some(item=>!item.allowed))throw new SourceProtocolError('source_access_denied')
        }
      }
      if (req.body?.method === 'tools/list') counters.discoveries++
      const server = new McpServer({ name: 'Independent reference source', version: '1' })
      const subject = sourceSubjectFromActor(actor)
      const readableFields = (await pool.query<{ field: string }>(`SELECT DISTINCT unnest(g.fields) AS field FROM grants g JOIN records r ON r.id=g.record_id
        WHERE g.kind=$1 AND g.account_id=$2 AND 'read'=ANY(g.actions) AND NOT r.withdrawn ORDER BY field`, [subject.kind,subject.id])).rows.map(row => row.field)
      if (readableFields.length) server.registerTool('readRecord', { inputSchema: { id: z.string(), fields: z.array(z.enum(readableFields as [string,...string[]])).min(1).max(256), retentionMode: z.enum(['governed','released_snapshot','ephemeral']).optional(), releaseId: z.string().optional() }, annotations: { readOnlyHint: true } }, async ({ id, fields, retentionMode, releaseId }) => {
        const result = await read(sourceSubjectFromActor(actor), id, fields, retentionMode, releaseId)
        return result ? { content: [{ type: 'text', text: JSON.stringify(result.data) }], _meta: { [SOURCE_PROTOCOL_VERSION]: result.envelope } }
          : { isError: true, content: [{ type: 'text', text: 'source_access_denied' }] }
      })
      server.registerTool('updateRecord', { inputSchema: { id: z.string(), expectedVersion: z.string(), expectedPolicyVersion:z.string().optional(), values: z.record(z.string()),
        idempotencyKey: input.attendedActions ? z.string().min(1).max(256).optional() : z.string().min(1).max(256) } }, async (args,extra) => {
        try {
          const key=input.attendedActions?extra._meta?.[input.attendedActions.idempotencyMetadataKey]:args.idempotencyKey
          if(typeof key!=='string')throw new Error('idempotency_required')
          const result = await update(actor, args.id, args.expectedVersion, args.values, key,args.expectedPolicyVersion)
          if(input.attendedActions){
            const projection=await read(subject,args.id,Object.keys(args.values))
            if(projection)return {content:[{type:'text',text:JSON.stringify(projection.data)}],_meta:{[SOURCE_PROTOCOL_VERSION]:projection.envelope}}
          }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch { return { isError: true, content: [{ type: 'text', text: 'source_effect_unavailable' }] } }
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.once('close', () => { void transport.close(); void server.close() })
      await server.connect(transport); await transport.handleRequest(req, res, req.body)
    } catch { res.status(403).json({ error: 'source_access_denied' }) }
  })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${input.pathPrefix ?? ''}`, counters, setAfterRead: (next?: () => Promise<void>) => { afterRead = next }, setAfterEffect: (next?: () => Promise<void>) => { afterEffect = next },setBeforeEffect:(next?:()=>Promise<void>)=>{beforeEffect=next},
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}
