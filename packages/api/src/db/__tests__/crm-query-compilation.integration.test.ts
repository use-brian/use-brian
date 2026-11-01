import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyRLSGucs, getAppPool, getPool } from '../client.js'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'

const enabled = Boolean(process.env.BRIAN_ASSURANCE_FIXTURE)
const owner = getPool()
const origin = { kind: 'native', moduleKey: 'native' }

describe.skipIf(!enabled).sequential('[COMP:crm/query-compilation] default-native policy equivalence', () => {
  beforeAll(async () => {
    const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
    await assertLocalFixture()
    await owner.query('CREATE SCHEMA crm_query_comparison')
    await owner.query(await readFile(new URL('./fixtures/native-query-compilation-before.sql', import.meta.url), 'utf8'))
    await owner.query(`CREATE FUNCTION crm_query_comparison.actual_catalog(uuid,jsonb,text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS 'SELECT public.application_generic_query_catalog_policy($1,$2,$3)';
      CREATE FUNCTION crm_query_comparison.actual_metadata(uuid,text,text[]) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS 'SELECT public.application_native_query_field_metadata($1,$2,$3)';
      CREATE FUNCTION crm_query_comparison.actual_context(uuid,text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS 'SELECT public.application_native_query_context_before_public_share($1,$2)';`)
    await owner.query('GRANT USAGE ON SCHEMA crm_query_comparison TO app_user')
  })
  afterAll(async () => { if (enabled) await owner.query('DROP SCHEMA crm_query_comparison CASCADE'); await getAppPool().end(); await owner.end() })

  it('preserves complete catalog JSON, revisions, custom metadata, selected-field rejection and current member masks', async () => {
    const f = await persistentContextFixture(), client = await getAppPool().connect()
    try {
      for (const kind of ['person', 'company', 'deal']) await owner.query(`INSERT INTO crm_field_definitions(workspace_id,entity_kind,field_key,label,field_type)
        VALUES($1,$2,'fixture_value','Fictional value','text'),($1,$2,'archived_value','Archived fictional value','number')`, [f.workspaceId, kind])
      await owner.query("UPDATE crm_field_definitions SET archived_at=now() WHERE workspace_id=$1 AND field_key='archived_value'", [f.workspaceId])
      await client.query('BEGIN'); await applyRLSGucs(client, f.firstId)
      for (const type of ['person', 'company', 'deal', 'task', 'unsupported']) {
        const pair = (await client.query(`SELECT crm_query_comparison.actual_catalog($1,$2,$3) AS actual,
          crm_query_comparison.catalog($1,$2,$3) AS prior`, [f.workspaceId, origin, type])).rows[0]
        expect(pair.actual).toEqual(pair.prior)
        if (type !== 'unsupported') expect(pair.actual).toMatchObject({ registered: true, held: false, nativeDefault: true })
        const context = (await client.query(`SELECT crm_query_comparison.actual_context($1,$2) AS actual,
          crm_query_comparison.context($1,$2) AS prior`, [f.workspaceId, type])).rows[0]
        expect(context.actual).toEqual(context.prior)
        if (type !== 'unsupported') expect(context.actual).not.toBeNull()
        for (const fields of [[], ['name'], ['amount'], ['custom.fixture_value'], ['custom.archived_value'], ['name', 'name'], ['unknown'], null]) {
          const metadata = (await client.query(`SELECT crm_query_comparison.actual_metadata($1,$2,$3) AS actual,
            crm_query_comparison.metadata($1,$2,$3) AS prior`, [f.workspaceId, type, fields])).rows[0]
          expect(metadata.actual).toEqual(metadata.prior)
        }
      }
      await client.query('ROLLBACK')
      await owner.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.firstId])
      await client.query('BEGIN'); await applyRLSGucs(client, f.firstId)
      const revoked = (await client.query(`SELECT crm_query_comparison.actual_context($1,'person') AS actual,
        crm_query_comparison.context($1,'person') AS prior`, [f.workspaceId])).rows[0]
      expect(revoked).toEqual({ actual: null, prior: null })
    } finally { await client.query('ROLLBACK'); client.release(); await f.cleanup() }
  })

  it('preserves refusal when the current custom vocabulary exceeds the 128-field contract', async () => {
    const f = await persistentContextFixture()
    try {
      await owner.query(`INSERT INTO crm_field_definitions(workspace_id,entity_kind,field_key,label,field_type)
        SELECT $1,'person','fixture_'||i,'Fictional field','text' FROM generate_series(1,129) i`, [f.workspaceId])
      const result = (await owner.query(`SELECT crm_query_comparison.actual_catalog($1,$2,'person') AS actual,
        crm_query_comparison.catalog($1,$2,'person') AS prior`, [f.workspaceId, origin])).rows[0]
      expect(result).toEqual({ actual: null, prior: null })
    } finally { await f.cleanup() }
  })
})
