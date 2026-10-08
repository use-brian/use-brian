import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import express from 'express'
import pg from 'pg'
import { simpleParser } from 'mailparser'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { CrmOperationsCommandSchema, type CampaignContext, type CrmOperationsContext } from '@use-brian/core'
import { feedParagraph } from '@use-brian/doc-model'
import type { CampaignEmailMetadata } from '@use-brian/shared'
import { encryptCredentials } from '../credential-crypto.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createCrmDeliveryProvider } from '../../crm-operations/delivery-providers.js'
import { createCrmDeliveryService } from '../../crm-operations/delivery-service.js'
import { createCampaignEmailService } from '../../content-planning/email.js'
import { createCampaignDispatchService } from '../../campaigns/dispatch.js'
import { campaignPublicEmailRoutes, createCampaignPublicEmailService } from '../../campaigns/public-email.js'
import { createCampaignService } from '../../campaigns/service.js'
import { createCampaignTrackingStore } from '../campaign-tracking-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const encryptionKey = Buffer.alloc(32, 41)
const privateKey = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

type SmtpSink = {
  port: number
  messages: Buffer[]
  close(): Promise<void>
}

async function smtpSink(closeAfterData = false): Promise<SmtpSink> {
  const messages: Buffer[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.write('220 loopback.example ESMTP\r\n')
    let buffer = Buffer.alloc(0), inData = false, authStep = 0
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          messages.push(Buffer.from(buffer.subarray(0, end)))
          buffer = buffer.subarray(end + 5)
          inData = false
          if (closeAfterData) { socket.destroy(); return }
          socket.write('250 2.0.0 accepted\r\n')
          continue
        }
        const end = buffer.indexOf('\r\n')
        if (end < 0) return
        const line = buffer.subarray(0, end).toString('utf8')
        buffer = buffer.subarray(end + 2)
        if (authStep === 1) { authStep = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); continue }
        if (authStep === 2) { authStep = 0; socket.write('235 2.7.0 authenticated\r\n'); continue }
        if (/^(EHLO|HELO) /i.test(line)) socket.write('250-loopback.example\r\n250 AUTH PLAIN LOGIN\r\n')
        else if (/^AUTH PLAIN/i.test(line)) socket.write('235 2.7.0 authenticated\r\n')
        else if (/^AUTH LOGIN/i.test(line)) { authStep = 1; socket.write('334 VXNlcm5hbWU6\r\n') }
        else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write('250 2.1.0 ok\r\n')
        else if (/^DATA$/i.test(line)) { inData = true; socket.write('354 end with <CRLF>.<CRLF>\r\n') }
        else if (/^RSET$/i.test(line)) socket.write('250 2.0.0 reset\r\n')
        else if (/^QUIT$/i.test(line)) { socket.end('221 2.0.0 bye\r\n'); return }
        else socket.write('250 2.0.0 ok\r\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Loopback SMTP did not bind')
  return {
    port: address.port,
    messages,
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

function sanitizedMimeEvidence(source: string, recipients: Array<{ email: string }>): string {
  let result = source
  for (const recipient of recipients) result = result.replaceAll(recipient.email, 'recipient@example.com')
  return result
    .replace(/^Date:.*$/gim, 'Date: [sanitized fixture time]')
    .replace(/^Message-ID:.*$/gim, 'Message-ID: <sanitized-fixture@example.com>')
    .replace(/\/e\/(?:[A-Za-z0-9_-]|=\r?\n){20,}/g, '/e/[opaque-click-token]')
    .replace(/\/c\/unsubscribe\/(?:[A-Za-z0-9_-]|=\r?\n){20,}/g, '/c/unsubscribe/[opaque-unsubscribe-token]')
}

type Fixture = Awaited<ReturnType<typeof fixture>>
async function fixture(sink: SmtpSink, count = 1, beforeAudience?: (f: { workspaceId: string; userId: string; contacts: Array<{ id: string; email: string }> }) => Promise<void>) {
  const userId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID(), sessionId = randomUUID()
  const connectorInstanceId = randomUUID(), campaignId = randomUUID(), placementId = randomUUID(), segmentId = randomUUID()
  await pool.query(`INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::uuid::text)`, [userId])
  await pool.query(`INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Campaign SMTP fixture','test',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, userId])
  await pool.query(`INSERT INTO assistants(id,name,workspace_id,kind,owner_user_id) VALUES($1,'Campaign assistant',$2,'primary',$3)`, [assistantId, workspaceId, userId])
  await pool.query(`INSERT INTO sessions(id,user_id,assistant_id,workspace_id,channel_type,channel_id,title,mode,visibility)
    VALUES($1::uuid,$2,$3,$4,'web',$1::uuid::text,'[email] Fixture','draft','workspace')`, [sessionId, userId, assistantId, workspaceId])
  const credentials = encryptCredentials({ type: 'imap', email: 'sender@example.com', appPassword: 'fixture-password',
    imapHost: '127.0.0.1', imapPort: 1143, smtpHost: '127.0.0.1', smtpPort: sink.port }, encryptionKey)
  await pool.query(`INSERT INTO connector_instance(id,scope,workspace_id,provider,label,connected,connected_email,credentials,credentials_type)
    VALUES($1,'workspace',$2,'imap','Loopback SMTP',true,'sender@example.com',$3,'imap')`, [connectorInstanceId, workspaceId, credentials])
  const contacts: Array<{ id: string; email: string }> = []
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID(), email = `recipient-${randomUUID()}@example.com`
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,attributes,created_by_user_id,source)
      VALUES($1,$2,'person',$3,$4,$5::jsonb,$6,'manual')`, [id, workspaceId, `Fixture Recipient ${index + 1}`, email,
      JSON.stringify({ email, first_name: `Person${index + 1}` }), userId])
    contacts.push({ id, email })
  }
  const crmContext: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId },
    authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
  const crm = createCrmOperationsService(createDbCrmOperationsStore())
  const run = (command: unknown) => crm.execute(crmContext, CrmOperationsCommandSchema.parse(command))
  await run({ kind: 'save_consent_purpose', purposeKey: 'updates', label: 'Updates', wordingVersion: '1', wording: 'Synthetic update consent.', applicableChannels: ['email'] })
  await run({ kind: 'save_managed_mailbox_policy', connectorInstanceId, providerKey: 'outreach', expectedVersion: 0, confirmed: true, managed: true, purposeKeys: ['updates'] })
  for (const contact of contacts) await run({ kind: 'record_consent', contactId: contact.id, purposeKey: 'updates', action: 'granted', source: 'fixture' })
  await pool.query(`INSERT INTO crm_segments(id,workspace_id,segment_key,name,entity_kind,predicate)
    VALUES($1,$2,'campaign_fixture','Campaign recipients','person',$3::jsonb)`, [segmentId, workspaceId,
    JSON.stringify({ type: 'group', combinator: 'and', items: [{ type: 'rule', family: 'base', field: 'email', operator: 'is_not_empty' }] })])
  const publicOrigin = 'http://127.0.0.1:4400', linkPublicId = randomUUID().replaceAll('-', '')
  const linkDestination = `https://destination.example/offer?utm_source=newsletter&utm_medium=email&utm_campaign=fixture&utm_content=email_body&brian_link=${linkPublicId}`
  const metadata: CampaignEmailMetadata = { subject: 'Hello {{first_name}}', preheader: 'A fixture update', senderId: connectorInstanceId,
    audience: { segmentId, segmentVersion: 1 }, purposeKey: 'updates', personalization: [{ field: 'first_name', required: true }],
    tracking: { links: true, website: true } }
  const content = { schemaVersion: 2, title: 'Fixture email', privateBrief: '', text: '', postFormat: 'post', threadSegments: [],
    article: { sourceUrl: '', title: '', description: '' }, media: [], email: metadata,
    composition: { version: 1, segments: [{ id: randomUUID(), content: [feedParagraph(`Read the update at ${publicOrigin}/r/${linkPublicId}`)] }] } }
  await pool.query(`INSERT INTO feed_post_working_copies(session_id,revision,mutation_id,content) VALUES($1,1,$2,$3::jsonb)`, [sessionId, randomUUID(), JSON.stringify(content)])
  await pool.query(`INSERT INTO campaigns(id,workspace_id,owner_user_id,name,objective,timezone,primary_conversion_kind)
    VALUES($1,$2,$3,'Fixture campaign','Prove safe SMTP','UTC','enquiry_submitted')`, [campaignId, workspaceId, userId])
  await pool.query(`INSERT INTO campaign_placements(id,workspace_id,campaign_id,session_id,channel,placement_kind,placement_key,created_by)
    VALUES($1,$2,$3,$4,'email','email_body','email_body',$5)`, [placementId, workspaceId, campaignId, sessionId, userId])
  await pool.query(`INSERT INTO campaign_links(workspace_id,campaign_id,placement_id,public_id,destination_url,destination_hash,utm_snapshot,created_by)
    VALUES($1,$2,$3,$4,$5,repeat('a',64),$6::jsonb,$7)`, [workspaceId, campaignId, placementId, linkPublicId, linkDestination,
    JSON.stringify({ source: 'newsletter', medium: 'email', campaign: 'fixture', content: 'email_body' }), userId])
  const sitePublicId = randomUUID().replaceAll('-', '')
  await pool.query(`INSERT INTO campaign_sites(workspace_id,public_id,name,allowed_origins,conversion_definitions,storage_mode,cookie_domain,site_group_key,created_by)
    VALUES($1,$2,'SMTP destination','["https://destination.example"]','[{"key":"enquiry_submitted","label":"Enquiry","enabled":true}]','first_party','.destination.example','smtp_fixture',$3)`,
  [workspaceId, sitePublicId, userId])
  const provider = createCrmDeliveryProvider({ encryptionKey, emailProvider: () => null,
    campaignMail: { dkim: { domainName: 'example.com', keySelector: 'fixture', privateKey } } })
  const deliveries = createCrmDeliveryService(provider)
  const email = createCampaignEmailService({ deliveries })
  const dispatch = createCampaignDispatchService({ deliveries, email, publicOrigin, oneClickEnabled: true, leaseSeconds: 30 })
  const campaigns = createCampaignService(undefined, undefined, email, dispatch)
  const context: CampaignContext = { workspaceId, actor: { kind: 'user', userId },
    authority: { role: 'owner', canRead: true, canWrite: true, canConfigure: true, canSend: true } }
  await beforeAudience?.({ workspaceId, userId, contacts })
  const audience = await email.audience(workspaceId, placementId, { credentialKind: 'user', credentialId: userId })
  const scheduledAt = new Date(Date.now() - 1_000).toISOString()
  const prepared = await campaigns.execute(context, { idempotencyKey: `prepare-${randomUUID()}`, command: {
    kind: 'prepare_dispatch', campaignId, placementId, approvedRevision: 1, metadata, scheduledAt,
    recipients: audience.eligible as never,
  } })
  const dispatchId = (prepared.result.dispatch as { dispatchId: string }).dispatchId
  await campaigns.execute(context, { idempotencyKey: `schedule-${randomUUID()}`, command: { kind: 'schedule_dispatch', dispatchId, scheduledAt } })
  return { userId, workspaceId, assistantId, sessionId, connectorInstanceId, contacts, campaignId, placementId, metadata,
    content, dispatchId, context, crmContext, run, email, dispatch, campaigns, publicOrigin, linkPublicId, linkDestination, sitePublicId }
}

afterAll(async () => { await pool.end() })

describe('[COMP:campaigns/dispatch] approved SMTP dispatch and recovery', () => {
  it('sends isolated envelopes through actual loopback SMTP with frozen content, click capability, unsubscribe, and signed one-click headers', async () => {
    const sink = await smtpSink()
    try {
      const f = await fixture(sink, 2)
      const laterId = randomUUID(), laterEmail = `later-${randomUUID()}@example.com`
      await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,attributes,created_by_user_id,source)
        VALUES($1,$2,'person','Later match',$3,$4::jsonb,$5,'manual')`, [laterId, f.workspaceId, laterEmail, JSON.stringify({ email: laterEmail, first_name: 'Later' }), f.userId])
      await f.run({ kind: 'record_consent', contactId: laterId, purposeKey: 'updates', action: 'granted', source: 'fixture' })
      expect(await f.dispatch.tick()).toBe(1)
      expect(await f.dispatch.tick()).toBe(1)
      expect(await f.dispatch.tick()).toBe(0)
      expect(sink.messages).toHaveLength(2)
      const parsed = await Promise.all(sink.messages.map(raw => simpleParser(raw)))
      const recipients = parsed.map(message => (Array.isArray(message.to) ? message.to : message.to ? [message.to] : [])
        .flatMap(address => address.value.map(item => item.address)))
      expect(recipients.map(addresses => addresses[0]).sort()).toEqual(f.contacts.map(contact => contact.email).sort())
      expect(recipients.every(addresses => addresses.length === 1)).toBe(true)
      for (const [index, raw] of sink.messages.entries()) {
        const source = raw.toString('utf8')
        expect(source).toMatch(/^DKIM-Signature:/m)
        const dkimHeader = source.match(/^DKIM-Signature:[\s\S]*?(?=\r?\n[^ \t])/m)?.[0].replace(/\r?\n[ \t]+/g, '') ?? ''
        expect(dkimHeader.toLowerCase()).toContain('list-unsubscribe:list-unsubscribe-post')
        expect(source).toMatch(/^List-Unsubscribe:\r?\n <http:\/\/127\.0\.0\.1:4400\/c\/unsubscribe\//m)
        expect(source).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m)
        expect(source).toContain('/e/')
        expect(source).not.toContain(`/r/`)
        expect(parsed[index]!.html).toContain('Unsubscribe')
      }
      const firstSource = sink.messages[0]!.toString('utf8')
      const clickToken = firstSource.match(/\/e\/([A-Za-z0-9_-]{20,})/)?.[1]
      expect(clickToken).toBeTruthy()
      const tracking = createCampaignTrackingStore()
      const publicApp = express().use(campaignPublicEmailRoutes({ tracking }))
      const clicked = await request(publicApp).get(`/e/${clickToken}?brian_test=1`)
        .set('user-agent', 'Mozilla/5.0 fixture browser').redirects(0).expect(307)
      expect(clicked.headers.location).toBe(f.linkDestination)
      await vi.waitFor(async () => {
        const count = (await pool.query(`SELECT count(*)::int AS count FROM campaign_events e JOIN campaign_links l ON l.id=e.link_id
          WHERE l.public_id=$1 AND e.event_type='redirect_request'`, [f.linkPublicId])).rows[0].count
        expect(count).toBe(1)
      })
      const issued = await tracking.issueCredential(f.workspaceId, (await tracking.listSites(f.workspaceId))[0]!.id, f.userId)
      const principal = await tracking.authenticateCredential(issued.secret)
      const conversion = await tracking.recordTrustedConversion(principal!, {
        version: 1, siteId: f.sitePublicId, conversionKind: 'enquiry_submitted', externalOutcomeId: 'smtp-click-fixture',
        occurredAt: new Date().toISOString(), attribution: { version: 1, linkId: f.linkPublicId }, test: true, metadata: {},
      })
      expect(conversion.attribution).toMatchObject({ state: 'attributed', firstTouch: { linkId: expect.any(String) } })
      const evidenceDir = process.env.CAMPAIGN_EVIDENCE_DIR
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true })
        await writeFile(`${evidenceDir}/smtp-capture.eml`, sanitizedMimeEvidence(firstSource, f.contacts))
        await writeFile(`${evidenceDir}/smtp-acceptance.json`, `${JSON.stringify({
          status: 'passed', messages: sink.messages.length, separateRecipientEnvelopes: true, dkimSigned: true,
          oneClickHeaders: true, clickRedirect: f.linkDestination.replace(f.linkPublicId, '[link-id]'),
          clickToConversion: conversion.attribution.state === 'attributed', unsupportedProviderMetricsRemainUnavailable: true,
        }, null, 2)}\n`)
      }
      expect((await pool.query(`SELECT count(*)::int AS count FROM campaign_email_recipients WHERE dispatch_id=$1`, [f.dispatchId])).rows[0].count).toBe(2)
      expect((await f.dispatch.read(f.workspaceId, f.dispatchId)).counts).toMatchObject({ total: 2, accepted: 2, pending: 0, uncertain: 0 })
      expect(JSON.stringify(await f.dispatch.read(f.workspaceId, f.dispatchId))).toContain('unavailable')
    } finally { await sink.close() }
  })

  it('preserves an uncertain post-DATA outcome and never resends it after worker restart', async () => {
    const sink = await smtpSink(true)
    try {
      const f = await fixture(sink)
      expect(await f.dispatch.tick()).toBe(1)
      expect(sink.messages).toHaveLength(1)
      expect((await f.dispatch.read(f.workspaceId, f.dispatchId)).counts).toMatchObject({ uncertain: 1 })
      const restarted = createCampaignDispatchService({
        deliveries: createCrmDeliveryService(createCrmDeliveryProvider({ encryptionKey, emailProvider: () => null,
          campaignMail: { dkim: { domainName: 'example.com', keySelector: 'fixture', privateKey } } })),
        email: f.email, publicOrigin: f.publicOrigin, oneClickEnabled: true,
      })
      expect(await restarted.tick()).toBe(0)
      expect(sink.messages).toHaveLength(1)
    } finally { await sink.close() }
  })

  it('blocks stale member and sender authority before SMTP handoff', async () => {
    const sink = await smtpSink()
    try {
      const memberRevoked = await fixture(sink)
      await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [memberRevoked.workspaceId, memberRevoked.userId])
      expect(await memberRevoked.dispatch.tick()).toBe(1)
      expect((await memberRevoked.dispatch.read(memberRevoked.workspaceId, memberRevoked.dispatchId)).counts).toMatchObject({ suppressed: 1 })
      expect(sink.messages).toHaveLength(0)

      const senderRevoked = await fixture(sink)
      await pool.query(`UPDATE connector_instance SET connected=false WHERE id=$1`, [senderRevoked.connectorInstanceId])
      expect(await senderRevoked.dispatch.tick()).toBe(1)
      expect((await senderRevoked.dispatch.read(senderRevoked.workspaceId, senderRevoked.dispatchId)).counts).toMatchObject({ rejected: 1 })
      expect(sink.messages).toHaveLength(0)
    } finally { await sink.close() }
  })

  it('makes GET non-mutating and stops paused, cancelled, and unsubscribed recipients without rewriting accepted evidence', async () => {
    const sink = await smtpSink()
    try {
      const f = await fixture(sink, 2)
      await f.campaigns.execute(f.context, { idempotencyKey: `pause-${randomUUID()}`, command: { kind: 'pause_dispatch', dispatchId: f.dispatchId } })
      expect(await f.dispatch.tick()).toBe(0)
      await f.campaigns.execute(f.context, { idempotencyKey: `resume-${randomUUID()}`, command: {
        kind: 'schedule_dispatch', dispatchId: f.dispatchId,
        scheduledAt: String((await f.dispatch.read(f.workspaceId, f.dispatchId)).dispatch.scheduledAt),
      } })
      expect(await f.dispatch.tick()).toBe(1)
      const pending = (await pool.query<{ id: string; contactId: string }>(`SELECT id,contact_id AS "contactId" FROM campaign_email_recipients
        WHERE dispatch_id=$1 AND state='pending'`, [f.dispatchId])).rows[0]!
      const token = `unsubscribe_${randomUUID().replaceAll('-', '')}`
      await pool.query(`INSERT INTO campaign_unsubscribe_tokens(workspace_id,recipient_id,purpose_key,token_hash,all_marketing,expires_at)
        VALUES($1,$2,'updates',$3,true,clock_timestamp()+interval '1 day')`, [f.workspaceId, pending.id, createHash('sha256').update(token).digest('hex')])
      const publicEmail = createCampaignPublicEmailService()
      expect(await publicEmail.preview(token)).toMatchObject({ alreadyUsed: false })
      expect((await pool.query(`SELECT count(*)::int AS count FROM association_consent_events WHERE workspace_id=$1 AND contact_id=$2 AND action='withdrawn'`,
        [f.workspaceId, pending.contactId])).rows[0].count).toBe(0)
      expect(await publicEmail.unsubscribe(token, 'purpose')).toMatchObject({ unsubscribed: true, alreadyUsed: false })
      expect(await publicEmail.unsubscribe(token, 'purpose')).toMatchObject({ unsubscribed: true, alreadyUsed: true })
      expect(await f.dispatch.tick()).toBe(1)
      expect(sink.messages).toHaveLength(1)
      expect((await f.dispatch.read(f.workspaceId, f.dispatchId)).counts).toMatchObject({ accepted: 1, rejected: 1 })

      const cancelled = await fixture(sink)
      await cancelled.campaigns.execute(cancelled.context, { idempotencyKey: `cancel-${randomUUID()}`, command: { kind: 'cancel_dispatch', dispatchId: cancelled.dispatchId } })
      expect(await cancelled.dispatch.tick()).toBe(0)
      expect((await cancelled.dispatch.read(cancelled.workspaceId, cancelled.dispatchId)).counts).toMatchObject({ cancelled: 1 })
      expect(sink.messages).toHaveLength(1)
    } finally { await sink.close() }
  })

  it('captures each recipient floor at approval, inherits it on unsubscribe and withholds counts from readers outside it', async () => {
    const sink = await smtpSink()
    try {
      const cedar = randomUUID(), outsider = randomUUID()
      const f = await fixture(sink, 1, async ({ workspaceId, userId, contacts }) => {
        await pool.query(`INSERT INTO workspace_groups(id,workspace_id,kind,name,created_by,compartment_key,key)
          VALUES($1::uuid,$2,'team','Cedar',$3,$4,$1::text)`, [cedar, workspaceId, userId, `team:${cedar}`])
        await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Cedar','team',$3)", [workspaceId, `team:${cedar}`, cedar])
        await pool.query(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin)
          VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING`, [workspaceId, cedar, userId])
        await pool.query('UPDATE entities SET sensitivity=$2,compartments=$3 WHERE id=$1', [contacts[0]!.id, 'confidential', [`team:${cedar}`]])
        await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [workspaceId])
      })
      const recipient = (await pool.query<{ id: string; contactId: string; scope: { compartments: string[] } | null; sources: Array<{ resourceId: string }> | null }>(
        `SELECT id,contact_id AS "contactId",scope_snapshot AS scope,scope_sources AS sources FROM campaign_email_recipients WHERE dispatch_id=$1`, [f.dispatchId])).rows[0]!
      expect(recipient.scope?.compartments).toEqual([`team:${cedar}`])
      expect(recipient.sources?.map(source => source.resourceId)).toEqual([recipient.contactId])

      const owner = { credentialKind: 'user' as const, credentialId: f.userId }
      expect((await f.dispatch.read(f.workspaceId, f.dispatchId, owner)).counts).toMatchObject({ total: 1 })
      await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [outsider])
      await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [f.workspaceId, outsider])
      const hidden = await f.dispatch.read(f.workspaceId, f.dispatchId, { credentialKind: 'user', credentialId: outsider })
      expect(Object.values(hidden.counts).every(value => value === null)).toBe(true)

      const token = `unsubscribe_${randomUUID().replaceAll('-', '')}`
      await pool.query(`INSERT INTO campaign_unsubscribe_tokens(workspace_id,recipient_id,purpose_key,token_hash,all_marketing,expires_at)
        VALUES($1,$2,'updates',$3,true,clock_timestamp()+interval '1 day')`, [f.workspaceId, recipient.id, createHash('sha256').update(token).digest('hex')])
      expect(await createCampaignPublicEmailService().unsubscribe(token, 'purpose')).toMatchObject({ unsubscribed: true })
      const withdrawal = (await pool.query<{ scope: unknown; sources: unknown }>(`SELECT scope_snapshot AS scope,scope_sources AS sources
        FROM association_consent_events WHERE workspace_id=$1 AND contact_id=$2 AND action='withdrawn'`, [f.workspaceId, recipient.contactId])).rows[0]!
      expect(withdrawal.scope).toEqual(recipient.scope)
      expect(withdrawal.sources).toEqual(recipient.sources)
      // tick() is workspace-global: leave no scheduled job behind for later cases.
      await f.campaigns.execute(f.context, { idempotencyKey: `cancel-${randomUUID()}`, command: { kind: 'cancel_dispatch', dispatchId: f.dispatchId } })
    } finally { await sink.close() }
  })

  it('invalidates immutable approval when the canonical Feed revision changes', async () => {
    const sink = await smtpSink()
    try {
      const f = await fixture(sink)
      await pool.query(`UPDATE feed_post_working_copies SET revision=revision+1,mutation_id=$2 WHERE session_id=$1`, [f.sessionId, randomUUID()])
      expect((await f.dispatch.read(f.workspaceId, f.dispatchId)).dispatch).toMatchObject({ state: 'cancelled' })
      expect(await f.dispatch.tick()).toBe(0)
    } finally { await sink.close() }
  })
})
