import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { CrmOperationsCommandSchema, crmOperationsSha256, type CrmOperationsContext } from '@use-brian/core'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createAssociationStore } from '../association-store.js'
import { ConsentInputSchema } from '../../association/domain.js'
import { exportCrmOperationsPrivacy } from '../../crm-operations/privacy.js'
import { WORKSPACE_FLUSH_TABLES } from '../workspace-flush.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const service = createCrmOperationsService(createDbCrmOperationsStore(pool))
const reads = createDbCrmIntakeReadStore()
const save = (change: Record<string,unknown> = {}) => CrmOperationsCommandSchema.parse({ kind: 'save_consent_purpose', purposeKey: 'updates', label: 'Updates', wordingVersion: '1', wording: 'Default fixture wording', ...change })
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), contactId = randomUUID()
  await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Wording fixture',$2)`, [workspaceId,userId])
  await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [workspaceId,userId])
  await pool.query(`INSERT INTO entities (id,workspace_id,kind,display_name,created_by_user_id,source) VALUES ($1,$2,'person','Fixture person',$3,'manual')`, [contactId,workspaceId,userId])
  const context: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId }, authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
  const purpose = (await service.execute(context, save({ defaultLocale: 'en', localeWordings: { ja: '同意します', 'zh-CN': '我同意' } }))).record
  return { workspaceId,userId,contactId,context,purpose }
}
function consent(contactId: string, change: Record<string,unknown> = {}) {
  return CrmOperationsCommandSchema.parse({ kind: 'record_consent', contactId, purposeKey: 'updates', action: 'granted', source: 'fixture', ...change })
}

describe('[COMP:crm/operations-store] Actual immutable localized consent wording', () => {
  afterAll(async () => pool.end())
  it('freezes every default/locale attribute, allows metadata edits, and retains settings when omitted', async () => {
    const f = await fixture()
    expect(f.purpose.wordingVersionId).toEqual(expect.any(String))
    for (const change of [{ wording: 'Changed default' }, { defaultLocale: null }, { localeWordings: { ja: '変更' } }]) {
      await expect(service.execute(f.context, save({ purposeId: f.purpose.id, ...change })))
        .rejects.toMatchObject({ code: 'conflict', details: { reason: 'wording_version_immutable' } })
    }
    const label = await service.execute(f.context, save({ purposeId: f.purpose.id, label: 'Renamed' }))
    expect(label.record).toMatchObject({ label: 'Renamed', defaultLocale: 'en', localeWordings: { ja: '同意します' }, wordingVersionId: f.purpose.wordingVersionId })
    const next = await service.execute(f.context, save({ purposeId: f.purpose.id, wordingVersion: '2', wording: 'Next default', defaultLocale: null, localeWordings: {} }))
    expect(next.record).toMatchObject({ defaultLocale: null, localeWordings: {} })
    expect(next.record.wordingVersionId).not.toBe(f.purpose.wordingVersionId)
    const versions = await pool.query(`SELECT version,wording_snapshot FROM crm_consent_purpose_versions WHERE workspace_id=$1 ORDER BY version`, [f.workspaceId])
    expect(versions.rows).toEqual([{ version: '1', wording_snapshot: 'Default fixture wording' }, { version: '2', wording_snapshot: 'Next default' }])
    await expect(pool.query(`UPDATE crm_consent_purpose_versions SET wording_snapshot='Changed' WHERE id=$1`, [f.purpose.wordingVersionId])).rejects.toMatchObject({ constraint: 'crm_consent_wording_immutable' })
  })

  it('admits one wording when concurrent edits reuse the same new version', async () => {
    const f = await fixture()
    const outcomes = await Promise.allSettled(['First wording','Second wording'].map((wording) => service.execute(f.context,save({ purposeId: f.purpose.id,wordingVersion: '2',wording }))))
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((item) => item.status === 'rejected')).toMatchObject({ reason: { code: 'conflict',details: { reason: 'wording_version_immutable' } } })
    const current = (await reads.listConsentPurposes(f.workspaceId)).purposes[0]!
    const evidence = (await service.execute(f.context,consent(f.contactId))).record
    expect(evidence).toMatchObject({ wording: current.wording,wordingVersionId: current.wordingVersionId })
    expect((await pool.query('SELECT count(*)::int AS count FROM crm_consent_purpose_versions WHERE workspace_id=$1',[f.workspaceId])).rows[0].count).toBe(2)
  })

  it('resolves exact server wording, hashes and fallback locale, preserving evidence and replay across edits', async () => {
    const f = await fixture()
    const input = consent(f.contactId, { locale: 'ja', provider: 'fixture', providerEventId: 'localized' })
    const recorded = (await service.execute(f.context,input)).record
    expect(recorded).toMatchObject({ wording: '同意します', wordingHash: crmOperationsSha256('同意します'), wordingLocale: 'ja', wordingVersionId: f.purpose.wordingVersionId })
    const fallback = (await service.execute(f.context,consent(f.contactId,{ locale: 'zh' }))).record
    expect(fallback).toMatchObject({ wording: 'Default fixture wording', wordingLocale: 'en', wordingHash: crmOperationsSha256('Default fixture wording') })
    await service.execute(f.context,save({ purposeId: f.purpose.id, wordingVersion: '2', localeWordings: { ja: '新しい同意文' } }))
    expect(await service.execute(f.context,input)).toMatchObject({ duplicate: true, record: recorded })
    await expect(service.execute(f.context,consent(f.contactId,{ locale: 'en', provider: 'fixture', providerEventId: 'localized' }))).rejects.toMatchObject({ code: 'idempotency_conflict' })
    const compliance = await reads.getConsent(f.workspaceId,f.contactId,f.context.actor)
    expect(compliance.events).toContainEqual(expect.objectContaining({ id: recorded.id, wording: '同意します', wordingLocale: 'ja', wordingVersionId: f.purpose.wordingVersionId }))
    expect((await reads.listConsentPurposes(f.workspaceId)).purposes[0]).toMatchObject({ wordingVersion: '2', localeWordings: { ja: '新しい同意文' } })
    const exported = await exportCrmOperationsPrivacy(f.context)
    expect(exported.tables.crm_consent_purpose_versions).toHaveLength(2)
    // Exercise this migration's flush ordering independently of older unrelated
    // hosted-only tables in the full workspace flush registry. Consent events
    // cascade from entities before catalog versions and purposes are deleted.
    const cleanup = await pool.connect()
    try {
      await cleanup.query('BEGIN')
      for (const table of WORKSPACE_FLUSH_TABLES.filter((name) => ['entities','crm_consent_purpose_versions','crm_consent_purposes'].includes(name))) {
        const removed = await cleanup.query(`DELETE FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])
        if (table === 'crm_consent_purpose_versions') expect(removed.rowCount).toBe(2)
      }
      await cleanup.query('COMMIT')
    } finally { await cleanup.query('ROLLBACK'); cleanup.release() }
    expect((await pool.query('SELECT id FROM crm_consent_purpose_versions WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  })

  it('binds fixed and enumerated intake locales to the saved definition, with atomic invalid-input rejection', async () => {
    const f = await fixture()
    for (const fixed of [true,false]) {
      const definitionKey = fixed ? 'fixed' : 'selected'
      await service.execute(f.context, CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition', definitionKey, label: 'Fixture intake', definition: {
        identityPolicy: 'new_or_review', fields: [
          { key: 'name', label: 'Name', type: 'text', required: true, mapping: { kind: 'base_field', field: 'name' } },
          { key: 'agree', label: 'Agree', type: 'boolean', required: true, mapping: { kind: 'submission_only' } },
          { key: 'language', label: 'Language', type: 'text', required: true, options: ['ja','zh-CN'], mapping: { kind: 'submission_only' } },
        ], consentMappings: [{ fieldKey: 'agree', grantedValue: true, purposeKey: 'updates', ...(fixed ? { locale: 'ja' } : { localeFieldKey: 'language' }) }],
      } }))
      const request = { kind: 'record_submission',definitionKey,idempotencyKey: 'submission',fields: { name: 'Fixture person',agree: true,language: 'zh-CN' } }
      const submission = await service.execute(f.context,CrmOperationsCommandSchema.parse(request))
      expect((await reads.getConsent(f.workspaceId,String(submission.record.contactId),f.context.actor)).events[0]).toMatchObject({ wordingLocale: fixed ? 'ja' : 'zh-CN', wording: fixed ? '同意します' : '我同意' })
      const before = (await pool.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[f.workspaceId])).rows[0]
      await expect(service.execute(f.context,CrmOperationsCommandSchema.parse({ ...request, idempotencyKey: 'bad',fields: { ...request.fields,language: 'xx' } }))).rejects.toMatchObject({ code: 'invalid_input' })
      expect((await pool.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[f.workspaceId])).rows[0]).toEqual(before)
    }
  })

  it('preserves catalogued legacy versions and keeps uncatalogued historical claims explicitly unlinked', async () => {
    const f = await fixture(), legacy = createAssociationStore(pool)
    await service.execute(f.context,save({ purposeId: f.purpose.id,wordingVersion: '2',wording: 'Current text' }))
    const actor = { credentialKind: 'user' as const,credentialId: f.userId,actingUserId: f.userId }
    const old = await legacy.appendConsent(f.workspaceId,ConsentInputSchema.parse({ contactId: f.contactId,purpose: 'updates',wordingVersion: '1',action: 'granted',source: 'fixture',locale: 'ja' }),actor)
    expect(old.record).toMatchObject({ wordingVersionId: f.purpose.wordingVersionId,wording: '同意します',wordingHash: crmOperationsSha256('同意します'),wordingLocale: 'ja' })
    const input = ConsentInputSchema.parse({ contactId: f.contactId,purpose: 'legacy',wordingVersion: 'old',action: 'granted',source: 'fixture' })
    expect((await legacy.appendConsent(f.workspaceId,input,actor)).record).toMatchObject({ wording: null,wordingHash: null,wordingVersionId: null,wordingLocale: null })
    await expect(legacy.appendConsent(f.workspaceId,{ ...input,locale: 'ja' },actor)).rejects.toMatchObject({ code: 'conflict' })
    await expect(legacy.appendConsent(f.workspaceId,{ ...input,purpose: 'updates',wordingVersion: 'missing' },actor)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('applies real app-role isolation and workspace/purpose-safe version foreign keys', async () => {
    const f = await fixture(), other = await fixture()
    const memberId = randomUUID()
    await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)',[memberId])
    await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'member')`,[f.workspaceId,memberId])
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL_APP })
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.system_bypass','false',true),set_config('app.current_user_id',$1,true)`,[memberId])
      expect((await client.query('SELECT id FROM crm_consent_purpose_versions')).rows).toEqual([{ id: f.purpose.wordingVersionId }])
      await expect(client.query(`INSERT INTO crm_consent_purpose_versions(workspace_id,purpose_id,version,wording_snapshot,wording_hash) VALUES ($1,$2,'forbidden','Fixture',$3)`,[f.workspaceId,f.purpose.id,crmOperationsSha256('Fixture')])).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.system_bypass','false',true),set_config('app.current_user_id',$1,true)`,[f.userId])
      await client.query(`UPDATE crm_consent_purposes SET active_wording_version='admin-version' WHERE id=$1`,[f.purpose.id])
      await client.query('COMMIT')
    } finally { await client.end() }
    const event = (await service.execute(f.context,consent(f.contactId))).record
    await expect(pool.query(`UPDATE association_consent_events SET wording_version_id=$2 WHERE id=$1`,[event.id,other.purpose.wordingVersionId])).rejects.toMatchObject({ code: '23503' })
    expect((await pool.query('SELECT count(*)::int AS count FROM crm_consent_purpose_versions WHERE workspace_id=$1',[f.workspaceId])).rows[0].count).toBe(2)
  })

  it('upgrades combined wording and ambiguous historical labels without inventing provenance', async () => {
    const client = await pool.connect(), schema = `wording_${randomUUID().replaceAll('-','')}`
    try {
      await client.query(`CREATE SCHEMA ${schema}`)
      await client.query(`SET search_path TO ${schema}`)
      // Isolated pre-502 column shapes; the fixture separately migrates the complete real chain.
      await client.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
        CREATE TABLE workspace_members(workspace_id uuid,user_id uuid,role text);
        CREATE TABLE crm_consent_purposes(workspace_id uuid,id uuid,active_wording_version text,wording_snapshot text,wording_hash text,created_at timestamptz,UNIQUE(workspace_id,id));
        CREATE TABLE association_consent_events(workspace_id uuid,purpose_id uuid,wording_version text,wording_snapshot text,wording_hash text,created_at timestamptz);`)
      const workspace = randomUUID(), purpose = randomUUID()
      await client.query('INSERT INTO workspaces VALUES($1)',[workspace])
      await client.query(`INSERT INTO crm_consent_purposes VALUES($1,$2,'current','Combined legacy text',$3,now())`,[workspace,purpose,crmOperationsSha256('Combined legacy text')])
      for (const [version,wording] of [['old','Old wording'],['ambiguous','First'],['ambiguous','Second'],['current','Overwritten'],['current','Combined legacy text']]) {
        await client.query('INSERT INTO association_consent_events VALUES($1,$2,$3,$4,$5,now())',[workspace,purpose,version,wording,crmOperationsSha256(wording)])
      }
      await client.query(await readFile(new URL('../../../migrations/502_crm_consent_wording_versions.sql',import.meta.url),'utf8'))
      expect((await client.query('SELECT version,default_locale,locale_wordings FROM crm_consent_purpose_versions ORDER BY version')).rows).toEqual([
        { version: 'current',default_locale: null,locale_wordings: {} },{ version: 'old',default_locale: null,locale_wordings: {} },
      ])
      const evidence = (await client.query('SELECT wording_snapshot,wording_version_id FROM association_consent_events')).rows
      expect(evidence.filter((row) => row.wording_version_id).map((row) => row.wording_snapshot).sort()).toEqual(['Combined legacy text','Old wording'])
      expect(evidence).toHaveLength(5)
    } finally {
      await client.query('ROLLBACK')
      await client.query('RESET search_path')
      await client.query(`DROP SCHEMA ${schema} CASCADE`)
      client.release()
    }
  })
})
