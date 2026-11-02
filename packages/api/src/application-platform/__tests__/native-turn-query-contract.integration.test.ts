import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool } from '../../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const signature = 'application_query_scope_union_contains(jsonb,jsonb,integer)'
const migration = await readFile(new URL('../../../migrations/8190_native_turn_query_contract.sql', import.meta.url), 'utf8')
const bridge = migration.replace(/^BEGIN;\n/m, '').replace(/\nCOMMIT;\s*$/, '')
const oldBody = migration.split('$canonical$')[1]
// Later canonical successors legitimately change the native reader roster. Replay
// this exact transition in the maintained pre-8196 upgrade fixture only.
const upgradeBoundary = process.env.BRIAN_NATIVE_PUBLICATION_UPGRADE_BOUNDARY === '8195'
  || (await pool.query(`SELECT to_regprocedure('public.publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)') IS NULL AS predecessor`)).rows[0].predecessor
afterAll(async () => { await pool.end() })

describe.sequential('[COMP:api/native-turn-frame] current query helper compatibility', () => {
  it('leaves the complete native reader contract current after all migrations', async () => {
    expect((await pool.query('SELECT native_turn_helpers_current() valid')).rows[0].valid).toBe(true)
  })
})

describe.skipIf(!upgradeBoundary).sequential('[COMP:api/native-turn-frame] canonical query successor authentication (8195 upgrade profile)', () => {
  it.each(['canonical', 'body', 'metadata', 'acl', 'predecessor-pin', 'missing-pin', 'other-helper', 'guard', 'manifest-acl', 'manifest-rule', 'owner'] as const)(
    'authenticates the exact transition with %s state', async change => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`UPDATE native_turn_contract_helpers SET fingerprint=(SELECT encode(sha256(convert_to(
          (to_jsonb(p)||jsonb_build_object('prosrc',$2::text))::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=$1::regprocedure)
          WHERE signature=$1`, [signature, oldBody])
        if (change === 'body') await client.query(`CREATE OR REPLACE FUNCTION application_query_scope_union_contains(original jsonb,current_scopes jsonb,budget integer)
          RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $test$
          BEGIN RETURN '{"contains":true,"used":1}'::jsonb;END $test$`)
        if (change === 'metadata') await client.query(`ALTER FUNCTION ${signature} VOLATILE`)
        if (change === 'acl') await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO app_user`)
        if (change === 'predecessor-pin') await client.query('UPDATE native_turn_contract_helpers SET fingerprint=repeat(\'0\',64) WHERE signature=$1', [signature])
        if (change === 'other-helper') await client.query('ALTER FUNCTION native_turn_key(jsonb) VOLATILE')
        if (change === 'missing-pin') await client.query('DELETE FROM native_turn_contract_helpers WHERE signature=$1', [signature])
        if (change === 'guard') await client.query(`CREATE OR REPLACE FUNCTION native_turn_helpers_current() RETURNS boolean
          LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS 'SELECT true'`)
        if (change === 'manifest-acl') await client.query('GRANT UPDATE(fingerprint) ON native_turn_contract_helpers TO app_user')
        if (change === 'manifest-rule') await client.query('CREATE RULE ignore_native_pin_update AS ON UPDATE TO native_turn_contract_helpers DO INSTEAD NOTHING')
        if (change === 'owner') await client.query(`ALTER FUNCTION ${signature} OWNER TO app_user`)

        if (change === 'canonical') {
          const before = (await client.query('SELECT signature,fingerprint FROM native_turn_contract_helpers ORDER BY signature')).rows
          await client.query(bridge)
          const after = (await client.query('SELECT signature,fingerprint FROM native_turn_contract_helpers ORDER BY signature')).rows
          expect(after.filter((row, index) => row.fingerprint !== before[index].fingerprint).map(row => row.signature)).toEqual([signature])
          expect((await client.query('SELECT native_turn_helpers_current() valid')).rows[0].valid).toBe(true)
        } else {
          const reason = ['predecessor-pin', 'missing-pin'].includes(change) ? 'predecessor_pin_changed' : change === 'other-helper' ? 'reader_contract_changed' : change === 'guard' ? 'guard_changed' : change.startsWith('manifest-') ? 'manifest_changed' : 'successor_changed'
          await expect(client.query(bridge)).rejects.toThrow(`native_turn_query_${reason}`)
        }
      } finally { await client.query('ROLLBACK'); client.release() }
    },
  )
})
