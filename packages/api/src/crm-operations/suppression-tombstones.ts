/** Retained address suppression in the caller's privacy transaction. [COMP:crm/suppression-tombstones] */
import { createHmac } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { CrmOperationsError, type CrmOperationsCommand, type CrmOperationsContext } from '@use-brian/core/crm/operations-types.js'
import type { CrmPageQuery } from '@use-brian/core/crm/pagination.js'
import type { CrmDeliveryChannel } from '@use-brian/core/crm/sendability.js'
import { readCrmPrivacyPolicy } from './privacy-policy.js'
import { queryCrmPage } from './pagination.js'

type Db = { query<R extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>> }
const version = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/)
const ringSchema = z.object({ activeVersion: version, keys: z.record(version,z.string()) }).strict()
const block = (reason: string) => new CrmOperationsError('conflict','Address suppression requires owner review.',{ reason })
function keyring() {
  try {
    const raw = process.env.CRM_SUPPRESSION_HMAC_KEYRING
    if (!raw || raw.length > 16384) throw new Error()
    const value = ringSchema.parse(JSON.parse(raw)), entries = Object.entries(value.keys)
    if (!entries.length || entries.length > 64 || !Object.hasOwn(value.keys,value.activeVersion)) throw new Error()
    const keys = new Map(entries.map(([name,text]) => {
      const bytes = Buffer.from(text,'base64')
      if (bytes.length !== 32 || bytes.toString('base64') !== text) throw new Error()
      return [name,bytes] as const
    }))
    return { activeVersion: value.activeVersion, keys }
  } catch { throw block('suppression_keyring_unavailable') }
}
function normalize(channel: CrmDeliveryChannel, address: string) {
  const text = address.trim()
  if (channel === 'email') {
    const email = text.toLowerCase()
    if (!z.string().email().max(320).safeParse(email).success) throw block('suppression_address_invalid')
    return email
  }
  if (['phone','sms','whatsapp'].includes(channel)) {
    const number = text.replace(/[\s().-]/g,'')
    if (!/^\+[1-9][0-9]{6,14}$/.test(number)) throw block('suppression_address_invalid')
    return number
  }
  if (!text || text.length > 500 || /[\x00-\x1f\x7f]/.test(text)) throw block('suppression_address_invalid')
  return text
}
function digest(key: Buffer, workspaceId: string, channel: CrmDeliveryChannel, address: string) {
  const workspaceKey = createHmac('sha256',key).update(`crm.address-suppression.workspace.v1\0${workspaceId.toLowerCase()}`).digest()
  return createHmac('sha256',workspaceKey).update(`crm.address-suppression.address.v1\0${channel}\0${normalize(channel,address)}`).digest('hex')
}
function keyCheck(key: Buffer, workspaceId: string) {
  const workspaceKey = createHmac('sha256',key).update(`crm.address-suppression.workspace.v1\0${workspaceId.toLowerCase()}`).digest()
  return createHmac('sha256',workspaceKey).update('crm.address-suppression.key-check.v1').digest('hex')
}
function verifyKey(ring: ReturnType<typeof keyring>, workspaceId: string, name: string, check: string) {
  const key = ring.keys.get(name)
  if (!key) throw block('suppression_retained_key_missing')
  if (keyCheck(key,workspaceId) !== check) throw block('suppression_key_material_mismatch')
}
async function addresses(db: Db, workspaceId: string, contactId: string) {
  const contact = (await db.query<{ email: string | null; phone: string | null }>(
    `SELECT COALESCE(NULLIF(attributes->>'email',''),canonical_id) AS email, NULLIF(attributes->>'phone','') AS phone
       FROM entities WHERE workspace_id=$1 AND id=$2 AND kind='person'`,[workspaceId,contactId])).rows[0]
  if (!contact) return []
  const result: { channel: CrmDeliveryChannel; address: string }[] = []
  if (contact.email) result.push({ channel: 'email',address: contact.email })
  if (contact.phone) for (const channel of ['phone','sms','whatsapp'] as const) result.push({ channel,address: contact.phone })
  const external = await db.query<{ provider: 'telegram' | 'slack'; subject: string }>(
    `SELECT provider,provider_subject AS subject FROM association_external_identities
      WHERE workspace_id=$1 AND contact_id=$2 AND provider IN ('telegram','slack')`,[workspaceId,contactId])
  for (const row of external.rows) result.push({ channel: row.provider,address: row.subject })
  return result
}

/** Caller holds the person lock. All evidence/capture/removal commits together. */
export async function retainCrmAddressSuppression(client: PoolClient, workspaceId: string, contactId: string) {
  const evidence = await client.query<{ channel: string; purpose: string | null; reason: string; occurredAt: string }>(
    `SELECT channel,NULL::text AS purpose,reason_code AS reason,occurred_at::text AS "occurredAt" FROM (
       SELECT DISTINCT ON(channel) * FROM crm_suppression_events WHERE workspace_id=$1 AND contact_id=$2
       ORDER BY channel,occurred_at DESC,created_at DESC,id DESC) s WHERE action='suppressed'
     UNION ALL
     SELECT 'all',e.purpose,'consent_withdrawn',e.occurred_at::text FROM (
       SELECT DISTINCT ON(purpose) * FROM association_consent_events WHERE workspace_id=$1 AND contact_id=$2
       ORDER BY purpose,occurred_at DESC,created_at DESC,id DESC) e
     WHERE e.action='withdrawn'`,[workspaceId,contactId])
  if (!evidence.rows.length) return 0
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`crm-address-suppression:${workspaceId}`])
  const policy = await readCrmPrivacyPolicy(workspaceId,client)
  if (!policy.policy.addressSuppression) throw block('suppression_policy_unconfigured')
  const ring = keyring(), methods = await addresses(client,workspaceId,contactId)
  const retainedVersions = (await client.query<{ version: string; check: string }>(`SELECT DISTINCT key_version AS version,key_check AS check FROM crm_address_suppression_tombstones
    WHERE workspace_id=$1 AND released_at IS NULL AND expires_at>clock_timestamp()`,[workspaceId])).rows
  for (const row of retainedVersions) verifyKey(ring,workspaceId,row.version,row.check)
  const names = [...ring.keys.keys()]
  let count = 0
  for (const row of evidence.rows) {
    const applicable = methods.filter((method) => row.channel === 'all' || row.channel === method.channel)
    if (!applicable.length) throw block('suppression_address_unavailable')
    for (const method of applicable) {
      const hashes = names.map((name) => digest(ring.keys.get(name)!,workspaceId,method.channel,method.address))
      // Rotation cannot create another horizon for the same retained evidence.
      // The workspace lock serializes this check across different active keys.
      const existing = await client.query(`SELECT id FROM crm_address_suppression_tombstones WHERE workspace_id=$1 AND channel=$2
        AND purpose_key IS NOT DISTINCT FROM $3::text AND reason_code=$4 AND occurred_at=$5::timestamptz
        AND (key_version,address_hmac) IN(SELECT * FROM unnest($6::text[],$7::text[]))`,
        [workspaceId,method.channel,row.purpose,row.reason,row.occurredAt,names,hashes])
      if (existing.rows.length) continue
      const result = await client.query(
        `INSERT INTO crm_address_suppression_tombstones(workspace_id,key_version,address_hmac,channel,purpose_key,reason_code,occurred_at,policy_version,created_at,expires_at,key_check)
         SELECT $1,$2,$3,$4,$5,$6,$7::timestamptz,$8,t,t+$9::integer*interval '1 second',$10 FROM (SELECT clock_timestamp() t) stamp
         ON CONFLICT DO NOTHING`,[workspaceId,ring.activeVersion,digest(ring.keys.get(ring.activeVersion)!,workspaceId,method.channel,method.address),
          method.channel,row.purpose,row.reason,row.occurredAt,policy.version,policy.policy.addressSuppression.retentionSeconds,keyCheck(ring.keys.get(ring.activeVersion)!,workspaceId)])
      count += result.rowCount ?? 0
    }
  }
  return count
}

export async function readCrmAddressSuppressions(db: Db, workspaceId: string, channel: CrmDeliveryChannel, address: string, purposeKey: string) {
  const versions = (await db.query<{ version: string; check: string }>(
    `SELECT DISTINCT key_version AS version,key_check AS check FROM crm_address_suppression_tombstones
     WHERE workspace_id=$1 AND channel=$2 AND (purpose_key IS NULL OR purpose_key=$3)
       AND released_at IS NULL AND expires_at>clock_timestamp()`,[workspaceId,channel,purposeKey])).rows
  if (!versions.length) return []
  const ring = keyring()
  for (const row of versions) verifyKey(ring,workspaceId,row.version,row.check)
  const names = [...ring.keys.keys()]
  const hashes = names.map((name) => digest(ring.keys.get(name)!,workspaceId,channel,address))
  const checks = names.map((name) => keyCheck(ring.keys.get(name)!,workspaceId))
  const rows = (await db.query<{ id: string; reasonCode: string; purposeKey: string | null; invalidKey: boolean }>(
    `SELECT id,reason_code AS "reasonCode",purpose_key AS "purposeKey",(key_version,key_check) NOT IN(SELECT * FROM unnest($4::text[],$6::text[])) AS "invalidKey" FROM crm_address_suppression_tombstones
     WHERE workspace_id=$1 AND channel=$2 AND (purpose_key IS NULL OR purpose_key=$3)
       AND released_at IS NULL AND expires_at>clock_timestamp() AND ((key_version,key_check) NOT IN(SELECT * FROM unnest($4::text[],$6::text[])) OR (key_version,address_hmac)
         IN (SELECT * FROM unnest($4::text[],$5::text[]))) ORDER BY created_at,id`,[workspaceId,channel,purposeKey,names,hashes,checks])).rows
  if (rows.some((row) => row.invalidKey)) throw block('suppression_key_material_mismatch')
  return rows.map(({ invalidKey: _invalid, ...row }) => row)
}

export async function retainWorkspaceAddressSuppression(client: PoolClient, workspaceId: string) {
  const people = await client.query<{ id: string }>(`SELECT id FROM entities e WHERE workspace_id=$1 AND kind='person'
    AND (EXISTS(SELECT 1 FROM crm_suppression_events s WHERE s.workspace_id=e.workspace_id AND s.contact_id=e.id)
      OR EXISTS(SELECT 1 FROM association_consent_events c WHERE c.workspace_id=e.workspace_id AND c.contact_id=e.id)) ORDER BY id FOR UPDATE`,[workspaceId])
  for (const person of people.rows) await retainCrmAddressSuppression(client,workspaceId,person.id)
}

/** No address/digest is returned by review or release. */
const publicProjection = `id,channel,purpose_key AS "purposeKey",reason_code AS "reasonCode",key_version AS "keyVersion",
  policy_version AS "policyVersion",occurred_at AS "occurredAt",created_at AS "createdAt",expires_at AS "expiresAt",released_at AS "releasedAt"`

export function listCrmAddressSuppression(db: Db, workspaceId: string, filters: CrmPageQuery = {}) {
  return queryCrmPage(db.query.bind(db), { workspaceId,resource: 'crm.address-suppression',key: 'tombstones',query: filters,
    sql: `SELECT ${publicProjection} FROM crm_address_suppression_tombstones WHERE workspace_id=$1`,params: [workspaceId] })
}

export async function releaseCrmAddressSuppression(client: PoolClient, context: CrmOperationsContext,
  command: Extract<CrmOperationsCommand,{kind:'release_address_suppression'}>) {
  if (context.actor.kind !== 'user') throw new CrmOperationsError('not_authorized','A member must review suppression release.')
  const member = await client.query<{ role: string }>(`SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`,[context.workspaceId,context.actor.userId])
  if (!['owner','admin'].includes(member.rows[0]?.role ?? '')) throw new CrmOperationsError('not_authorized','Current owner or admin membership is required.')
  const row = (await client.query<{ id: string; channel: CrmDeliveryChannel; purpose_key: string | null; reason_code: string; key_version: string; key_check: string; address_hmac: string; occurred_at: Date; created_at: Date; released_at: Date | null; release_evidence_kind: string | null; release_evidence_id: string | null }>(
    `SELECT * FROM crm_address_suppression_tombstones WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[context.workspaceId,command.tombstoneId])).rows[0]
  if (!row) throw new CrmOperationsError('not_found','Suppression record was not found.')
  if (row.released_at && (row.release_evidence_kind !== command.evidenceKind || row.release_evidence_id !== command.evidenceId)) throw block('suppression_release_conflict')
  if (!row.released_at) {
    if (row.reason_code === 'consent_withdrawn') {
      if (command.evidenceKind !== 'consent_event') throw block('suppression_reconsent_required')
      const evidence = (await client.query<{ contactId: string }>(
        `SELECT e.contact_id AS "contactId" FROM association_consent_events e
         JOIN crm_address_suppression_tombstones t ON t.workspace_id=e.workspace_id AND t.id=$4
         WHERE e.workspace_id=$1 AND e.id=$2 AND e.purpose=$3 AND e.action='granted' AND e.actor_kind='user' AND e.acting_user_id IS NOT NULL
           AND e.occurred_at>t.occurred_at AND e.created_at>t.created_at AND e.occurred_at<=clock_timestamp()
           AND NOT EXISTS(SELECT 1 FROM association_consent_events later WHERE later.workspace_id=e.workspace_id AND later.contact_id=e.contact_id
             AND later.purpose=e.purpose AND (later.occurred_at,later.created_at,later.id)>(e.occurred_at,e.created_at,e.id))`,
        [context.workspaceId,command.evidenceId,row.purpose_key,row.id])).rows[0]
      if (!evidence) throw block('suppression_reconsent_required')
      const ring = keyring(), key = ring.keys.get(row.key_version)
      verifyKey(ring,context.workspaceId,row.key_version,row.key_check)
      if (!key) throw block('suppression_retained_key_missing')
      const methods = await addresses(client,context.workspaceId,evidence.contactId)
      if (!methods.some((method) => method.channel===row.channel && digest(key,context.workspaceId,row.channel,method.address)===row.address_hmac)) throw block('suppression_reconsent_address_mismatch')
    } else {
      if (command.evidenceKind !== 'workspace_file') throw block('suppression_release_file_required')
      const file = await client.query(`SELECT id FROM workspace_files WHERE workspace_id=$1 AND id=$2 AND valid_to IS NULL AND retracted_at IS NULL FOR SHARE`,[context.workspaceId,command.evidenceId])
      if (!file.rows.length) throw block('suppression_release_file_unavailable')
    }
    await client.query(`UPDATE crm_address_suppression_tombstones SET released_at=clock_timestamp(),release_evidence_kind=$3,release_evidence_id=$4
      WHERE workspace_id=$1 AND id=$2`,[context.workspaceId,row.id,command.evidenceKind,command.evidenceId])
  }
  return { record: (await client.query(`SELECT ${publicProjection} FROM crm_address_suppression_tombstones WHERE workspace_id=$1 AND id=$2`,[context.workspaceId,row.id])).rows[0], changed: !row.released_at }
}

/** Build a transaction-local address match set without exporting HMAC material
 * or retaining an unbounded collection in application memory. */
export async function prepareCrmSuppressionPrivacy(client:PoolClient,workspaceId:string,contactId:string):Promise<void> {
  await client.query('CREATE TEMP TABLE crm_privacy_suppression_matches(channel text,key_version text,address_hmac text,PRIMARY KEY(channel,key_version,address_hmac)) ON COMMIT DROP')
  const methodsSql = "SELECT 'email'::text AS channel,COALESCE(NULLIF(attributes->>'email',''),canonical_id) AS address FROM entities WHERE workspace_id=$1 AND id=$2 AND kind='person'"
    +" UNION SELECT ch.channel,NULLIF(e.attributes->>'phone','') FROM entities e CROSS JOIN (VALUES('phone'),('sms'),('whatsapp')) ch(channel) WHERE e.workspace_id=$1 AND e.id=$2 AND e.kind='person'"
    +" UNION SELECT provider,provider_subject FROM association_external_identities WHERE workspace_id=$1 AND contact_id=$2 AND provider IN('telegram','slack')"
    +" UNION SELECT 'email',normalized_value FROM entity_external_identities WHERE workspace_id=$1 AND entity_id=$2 AND identity_kind='email'"
  await client.query('DECLARE privacy_suppression_keys NO SCROLL CURSOR FOR SELECT DISTINCT key_version AS version,key_check AS check FROM crm_address_suppression_tombstones WHERE workspace_id=$1 AND channel IN(SELECT channel FROM ('+methodsSql+') methods WHERE address IS NOT NULL)',[workspaceId,contactId])
  let ring:ReturnType<typeof keyring>|undefined
  try {
    for(;;) {
      const row=(await client.query<{version:string;check:string}>('FETCH FORWARD 1 FROM privacy_suppression_keys')).rows[0]
      if(!row) break
      ring ??=keyring()
      verifyKey(ring,workspaceId,row.version,row.check)
    }
  } finally {await client.query('CLOSE privacy_suppression_keys')}
  if(!ring)return
  await client.query('DECLARE privacy_suppression_methods NO SCROLL CURSOR FOR SELECT channel,address FROM ('+methodsSql+') methods WHERE address IS NOT NULL',[workspaceId,contactId])
  try {
    for(;;) {
      const method=(await client.query<{channel:CrmDeliveryChannel;address:string}>('FETCH FORWARD 1 FROM privacy_suppression_methods')).rows[0]
      if(!method)break
      const matches=[...ring.keys].map(([name,key])=>({channel:method.channel,key_version:name,address_hmac:digest(key,workspaceId,method.channel,method.address)}))
      await client.query('INSERT INTO pg_temp.crm_privacy_suppression_matches SELECT channel,key_version,address_hmac FROM jsonb_to_recordset($1::jsonb) AS h(channel text,key_version text,address_hmac text) ON CONFLICT DO NOTHING',[JSON.stringify(matches)])
    }
  } finally {await client.query('CLOSE privacy_suppression_methods')}
}

/** Preview prerequisite; does not expose key material. */
export function assertCrmSuppressionKeyringAvailable():void {keyring()}
