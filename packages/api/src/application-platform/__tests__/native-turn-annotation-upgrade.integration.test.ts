import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from '../../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const migration = await readFile(new URL('../../../migrations/8196_native_turn_annotation_publication.sql', import.meta.url), 'utf8')
const annotationUpgrade = migration.replace(/^BEGIN;\n/m, '').replace(/\nCOMMIT;\s*$/, '')
const invalidationMigration = await readFile(new URL('../../../migrations/8195_native_publication_invalidation_contract.sql', import.meta.url), 'utf8')
const invalidationUpgrade = invalidationMigration.replace(/^BEGIN;\n/m, '').replace(/\nCOMMIT;\s*$/, '')
const historicalTriggers = await readFile(new URL('./fixtures/native-invalidation-predecessor.sql', import.meta.url), 'utf8')
// The canonical forward bridge must refuse later executable versions. The
// maintained runner executes this profile before installing migration 8196.
const upgradeBoundary = process.env.BRIAN_NATIVE_PUBLICATION_UPGRADE_BOUNDARY === '8195'
  || (await pool.query(`SELECT to_regprocedure('public.publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)') IS NULL AS predecessor`)).rows[0].predecessor
const guardQuery = `SELECT native_turn_helpers_current() native,
  native_turn_publication_contract() publication,application_native_worklist_helpers_current() worklist,
  application_native_dependency_batch_helpers_current() dependency,
  application_native_field_reference_helpers_current() reference,application_memory_statement_helpers_current() memory`
const healthyGuards = { native: true, publication: true, worklist: true, dependency: true, reference: true, memory: true }
afterAll(async () => { await pool.end() })

async function replaceBody(client: PoolClient, signature: string, nextBody: string) {
  const previous = (await client.query<{ body: string; definition: string }>(
    'SELECT prosrc body,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid=$1::regprocedure', [signature],
  )).rows[0]
  // Callback replacement preserves any dollar signs in SQL function bodies.
  await client.query(previous.definition.replace(previous.body, () => nextBody))
}

async function inRollback(action: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN; SET LOCAL statement_timeout='120s'")
    await action(client)
  } finally { await client.query('ROLLBACK'); client.release() }
}

describe.sequential('[COMP:api/native-turn-frame] annotation publication guard compatibility', () => {
  it('keeps all six authority and structural guards current after migrations', async () => {
    expect((await pool.query(guardQuery)).rows[0]).toEqual(healthyGuards)
  })
})

describe.skipIf(!upgradeBoundary).sequential('[COMP:api/native-turn-frame] authenticated annotation publication (8196 upgrade profile)', () => {
  it.each(['absent', 'historical-dual-trigger'] as const)('authenticates the canonical %s predecessor and exact nested guard row', async profile => {
    await inRollback(async client => {
      expect((await client.query("SELECT to_regclass('public.native_crm_current_cohorts') value")).rows[0].value).toBeNull()
      if (profile === 'historical-dual-trigger') {
        await client.query(historicalTriggers)
        await client.query(invalidationUpgrade)
      }
      expect((await client.query(guardQuery)).rows[0]).toEqual(healthyGuards)
      await client.query(annotationUpgrade)
      expect((await client.query(guardQuery)).rows[0]).toEqual(healthyGuards)
      const nested = (await client.query<{ exact: boolean }>(`SELECT position(quote_literal(dependency.prosrc) IN reference.prosrc)>0 exact
        FROM pg_proc dependency,pg_proc reference
        WHERE dependency.oid='application_native_dependency_batch_helpers_current()'::regprocedure
          AND reference.oid='application_native_field_reference_helpers_current()'::regprocedure`)).rows[0]
      expect(nested.exact).toBe(true)
      const enrolled = (await client.query<{ count: number }>(`SELECT count(*)::integer count FROM native_turn_contract_helpers
        WHERE signature=ANY($1::text[])`, [[
        'native_turn_field_reference(uuid,uuid,uuid,text)',
        'publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)',
      ]])).rows[0]
      expect(enrolled.count).toBe(2)
    })
  }, 180_000)

  it('refuses an unknown consumer of a changed helper pin', async () => {
    await inRollback(async client => {
      await client.query(`DO $test$ DECLARE pin text;BEGIN
        SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO pin
          FROM pg_proc p WHERE oid='native_turn_event_frame(uuid,uuid)'::regprocedure;
        EXECUTE format('CREATE FUNCTION public.fictional_annotation_pin_consumer() RETURNS text LANGUAGE sql AS %L','SELECT '||quote_literal(pin)||'::text');
      END $test$`)
      expect((await client.query(guardQuery)).rows[0]).toEqual(healthyGuards)
      await expect(client.query(annotationUpgrade)).rejects.toThrow('native_annotation_unauthenticated_pin_consumer')
    })
  }, 180_000)

  it('rejects coordinated helper, guard and mutable manifest forgery', async () => {
    await inRollback(async client => {
      await replaceBody(client, 'native_turn_event_frame(uuid,uuid)', 'SELECT NULL::uuid')
      await replaceBody(client, 'native_turn_helpers_current()', 'SELECT true')
      await client.query(`UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
        FROM pg_proc p WHERE p.oid=to_regprocedure(h.signature)`)
      // A mutable guard and manifest both claim success; independent canonical
      // code authentication must still reject this coordinated replacement.
      expect((await client.query('SELECT native_turn_helpers_current() valid')).rows[0].valid).toBe(true)
      await expect(client.query(annotationUpgrade)).rejects.toThrow('native_invalidation_canonical:')
    })
  }, 180_000)
})
