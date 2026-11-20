/** [COMP:operations/crm-recovery] Ordinary-owner recovery coverage upgrade. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

const scripts = new URL('../../../../../scripts/', import.meta.url)
const { createLocalFixture, cleanRuntimeEnvironment } = await import(new URL('crm/local-fixture.mjs', scripts).href)
const { inspectDatabase } = await import(new URL('operations/recovery-common.mjs', scripts).href)
const migration = new URL('../../../migrations/8271_refresh_recovery_capture.sql', import.meta.url)

describe('[COMP:operations/crm-recovery] Recovery capture upgrade', () => {
  it('repairs missing capture and stale keys without losing rollback or minimized erasure evidence', async () => {
    const completed = new Error('recovery_capture_upgrade_verified')
    let verified = false
    try {
      await createLocalFixture({
        pgBin: process.env.PG_BIN,
        env: cleanRuntimeEnvironment(process.env),
        ordinaryOwner: true,
        beforeApplyFile: '8271_refresh_recovery_capture.sql',
        beforeApply: async ({ adminUrl }: { adminUrl: string }) => {
          const client = new pg.Client({ connectionString: adminUrl })
          await client.connect()
          try {
            expect((await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
              .toEqual({ rolsuper: false, rolbypassrls: false })
            const existingTriggers = async () => (await client.query(`SELECT to_jsonb(t) metadata FROM pg_trigger t
              JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND t.tgname='crm_recovery_capture'
                AND c.relname NOT LIKE 'fixture_recovery_%' ORDER BY t.oid`)).rows
            const before = await existingTriggers()
            expect(before.length).toBeGreaterThan(0)
            expect((await client.query('SELECT native_turn_helpers_current() current')).rows).toEqual([{ current: true }])
            await client.query(`CREATE TABLE public.fixture_recovery_uncovered(id uuid PRIMARY KEY,workspace_id uuid,payload text);
              CREATE TABLE public.fixture_recovery_stale(workspace_id uuid,source_key text,payload text,PRIMARY KEY(workspace_id,source_key));
              INSERT INTO crm_erasure_journal_targets VALUES('fixture_recovery_stale',ARRAY['source_key'],false);
              CREATE TRIGGER crm_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON public.fixture_recovery_stale
                FOR EACH ROW EXECUTE FUNCTION public.crm_capture_erasure_effect();
              ALTER TABLE public.fixture_recovery_stale DISABLE TRIGGER crm_recovery_capture`)
            await expect(inspectDatabase(client)).rejects.toThrow('Recovery capture schema drift')
            await client.query(await readFile(migration, 'utf8'))
            await expect(inspectDatabase(client)).resolves.toHaveProperty('schemaHash')
            expect(await existingTriggers()).toEqual(expect.arrayContaining(before))
            expect((await client.query('SELECT native_turn_helpers_current() current')).rows).toEqual([{ current: true }])
            const installed = await existingTriggers()
            await client.query(`DROP TRIGGER crm_recovery_capture ON fixture_recovery_uncovered;
              CREATE TRIGGER crm_recovery_capture AFTER INSERT ON fixture_recovery_uncovered
                FOR EACH ROW EXECUTE FUNCTION public.crm_capture_erasure_effect()`)
            await client.query('SELECT crm_install_erasure_capture()')
            expect(await existingTriggers()).toEqual(installed)
            expect((await client.query('SELECT native_turn_helpers_current() current')).rows).toEqual([{ current: true }])
            expect((await client.query("SELECT key_columns FROM crm_erasure_journal_targets WHERE table_name='fixture_recovery_stale'")).rows[0])
              .toEqual({ key_columns: ['workspace_id', 'source_key'] })
            expect((await client.query("SELECT capture_inserts FROM crm_erasure_journal_targets WHERE table_name='crm_address_suppression_tombstones'")).rows[0])
              .toEqual({ capture_inserts: true })
            const workspace = randomUUID(), id = randomUUID()
            await client.query("INSERT INTO fixture_recovery_uncovered VALUES($1,$2,'Private deleted content')", [id, workspace])
            await client.query("INSERT INTO fixture_recovery_stale VALUES($1,'fixture','Private original content')", [workspace])
            const journal = async () => (await client.query(`SELECT table_name,operation,row_key,effect FROM crm_erasure_journal
              WHERE workspace_id=$1 ORDER BY table_name`, [workspace])).rows
            const erase = async () => {
              await client.query("BEGIN; SELECT set_config('app.crm_erasure_capture','on',true)")
              await client.query("UPDATE fixture_recovery_stale SET payload='Redacted' WHERE workspace_id=$1", [workspace])
              await client.query('DELETE FROM fixture_recovery_uncovered WHERE id=$1', [id])
            }
            expect(await journal()).toEqual([])
            await erase()
            await client.query('ROLLBACK')
            expect(await journal()).toEqual([])
            expect((await client.query('SELECT payload FROM fixture_recovery_uncovered WHERE id=$1', [id])).rows)
              .toEqual([{ payload: 'Private deleted content' }])
            await erase()
            await client.query('COMMIT')
            expect(await journal()).toEqual([
              { table_name: 'fixture_recovery_stale', operation: 'update', row_key: { workspace_id: workspace, source_key: 'fixture' }, effect: { payload: 'Redacted' } },
              { table_name: 'fixture_recovery_uncovered', operation: 'delete', row_key: { id }, effect: null },
            ])
            verified = true
          } finally { await client.end() }
          // The fixture owns cleanup; stop before its runner applies the same migration again.
          throw completed
        },
      })
    } catch (error) {
      if (!verified || !(error instanceof Error) || error.cause !== completed) throw error
    }
    expect(verified).toBe(true)
  }, 240_000)
})
