/** Isolated PG18 engine; no runtime credentials or live database access.
 * Execute the actual 8272 compiler against unmodified production member source
 * and real pg_proc rows. Full native predecessor/repin replay belongs to fixture CI.
 */
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
const migrations = new URL('../../../migrations/', import.meta.url)
const migration = await readFile(new URL('8272_native_helper_attestation_cost.sql', migrations), 'utf8')
const original = await readFile(new URL('8183_native_turn_requirements.sql', migrations), 'utf8')
const root = original.slice(original.indexOf('CREATE FUNCTION native_turn_helpers_current()'), original.indexOf('\n\n\nCREATE FUNCTION native_turn_parent'))
const member = original.slice(original.indexOf('CREATE FUNCTION native_turn_completed_point('), original.indexOf('CREATE FUNCTION native_turn_completed_scope('))
const compiler = migration.slice(migration.indexOf('CREATE TABLE public.native_turn_helper_attestations('), migration.indexOf('DO $native_helper_attestation_pins$'))
const signature = 'native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)'
let db: PGlite
async function valid() {
  return (await db.query<{ valid: boolean }>('SELECT public.native_turn_helpers_current() IS TRUE AS valid')).rows[0].valid
}
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`CREATE ROLE app_user; CREATE ROLE fixture_owner;
    GRANT CREATE ON SCHEMA public TO fixture_owner; SET ROLE fixture_owner;
    CREATE TABLE sessions(id uuid);
    CREATE TABLE native_turn_contract_helpers(signature text PRIMARY KEY,fingerprint text NOT NULL);
    ALTER TABLE native_turn_contract_helpers ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON native_turn_contract_helpers FROM PUBLIC,app_user;
    ${member}${root}
    INSERT INTO native_turn_contract_helpers SELECT '${signature}',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
      FROM pg_proc p WHERE oid='${signature}'::regprocedure;
    DO $$ DECLARE body text; BEGIN
      SELECT prosrc INTO body FROM pg_proc WHERE oid='native_turn_helpers_current()'::regprocedure;
      body:=replace(body,'count(*)>0','array_agg(h.signature ORDER BY h.signature)=ARRAY[''${signature}'']::text[]');
      EXECUTE 'CREATE OR REPLACE FUNCTION native_turn_helpers_current() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path=pg_catalog,public,pg_temp AS '||quote_literal(body);
    END $$;
    CREATE TEMP TABLE attestation_predecessors AS SELECT oid,prosrc original,prosrc expected FROM pg_proc
      WHERE oid='native_turn_helpers_current()'::regprocedure;`)
  expect(await valid()).toBe(true)
  await db.exec(compiler)
  await db.exec(`INSERT INTO native_turn_helper_attestations(signature,expected_text)
    SELECT h.signature,to_jsonb(p)::text FROM native_turn_contract_helpers h JOIN pg_proc p ON p.oid=to_regprocedure(h.signature);`)
  expect(await valid()).toBe(true)
}, 30_000)
afterAll(async () => { await db?.close() })

describe.sequential('[COMP:api/native-chat-read-cost] exact generated attestation', () => {
  it('binds generated values to actual unmodified production source and complete metadata', async () => {
    const result = await db.query<{ valid: boolean }>(`SELECT bool_and(
      c.expected_text=to_jsonb(p)::text AND c.expected_body=p.prosrc
      AND c.expected_metadata=to_jsonb(p)-'prosrc'
      AND c.original_fingerprint=h.fingerprint
      AND c.original_fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')) AS valid
      FROM native_turn_helper_attestations c JOIN native_turn_contract_helpers h USING(signature)
      JOIN pg_proc p ON p.oid=to_regprocedure(h.signature)`)
    expect(result.rows[0].valid).toBe(true)
    // This body is not a test substitute: it comes verbatim from 8183.
    expect(member).toContain('native_turn_requirement_unresolved')
  })
  it('immutable byte escaping hashes the exact UTF8 JSON bytes, including escapes and Unicode', async () => {
    await db.exec('BEGIN')
    try {
      for (const value of ['back\\slash', '\\x1234', 'octal\\123', 'é雪😀', '\n\t\r', '\\u0000']) {
        const text = JSON.stringify({ prosrc: value })
        const result = await db.query<{ valid: boolean }>(`INSERT INTO native_turn_helper_attestations(signature,expected_text)
          VALUES('escape()', $1) ON CONFLICT(signature) DO UPDATE SET expected_text=excluded.expected_text
          RETURNING original_fingerprint=encode(sha256(convert_to(expected_text,'UTF8')),'hex') AS valid`, [text])
        expect(result.rows[0].valid).toBe(true)
      }
    } finally { await db.exec('ROLLBACK') }
    expect(await valid()).toBe(true)
  })
  it('serializes zero full pg_proc/source JSON values per runtime guard call', async () => {
    const { rows } = await db.query<{ prosrc: string }>(`SELECT prosrc FROM pg_proc WHERE oid='native_turn_helpers_current()'::regprocedure`)
    const body = rows[0].prosrc
    expect(body).not.toMatch(/to_jsonb\(p\)|convert_to\(|sha256\(/)
    expect(body).toContain('p.prosrc IS DISTINCT FROM c.expected_body')
    const catalog = (await db.query<{ attname: string }>(`SELECT attname FROM pg_attribute
      WHERE attrelid='pg_proc'::regclass AND attnum>0 ORDER BY attnum`)).rows.map(row => row.attname)
    const pairs = [...body.matchAll(/'([a-z]+)',p\.([a-z]+)/g)].map(match => [match[1], match[2]])
    expect(pairs).toEqual(catalog.filter(name => name !== 'prosrc').map(name => [name, name]))
    const calls = await db.query<{ valid: boolean; calls: number }>(`SELECT bool_and(native_turn_helpers_current()) valid,count(*)::int calls FROM generate_series(1,25)`)
    expect(calls.rows[0]).toEqual({ valid: true, calls: 25 })
  })
  it.each([
    ['body', `DO $$ DECLARE body text; BEGIN SELECT pg_get_functiondef('${signature}'::regprocedure) INTO body;
      EXECUTE replace(body,'native_turn_requirement_unresolved','tampered_requirement'); END $$`],
    ['metadata', `ALTER FUNCTION ${signature} COST 101`],
    ['owner', `ALTER FUNCTION ${signature} OWNER TO app_user`],
    ['function ACL', `GRANT EXECUTE ON FUNCTION ${signature} TO app_user`],
    ['copied member', `ALTER FUNCTION ${signature} RENAME TO copied_original_point; ${member}`],
    ['removed primary key', 'ALTER TABLE native_turn_helper_attestations DROP CONSTRAINT native_turn_helper_attestations_pkey'],
    ['missing registry row', 'DELETE FROM native_turn_contract_helpers'],
    ['changed registry fingerprint', `UPDATE native_turn_contract_helpers SET fingerprint=repeat('0',64)`],
    ['missing compiled row', 'DELETE FROM native_turn_helper_attestations'],
    ['changed compiled payload', `UPDATE native_turn_helper_attestations SET expected_text=(expected_text::jsonb||'{"procost":101}'::jsonb)::text`],
    ['extra compiled row', `INSERT INTO native_turn_helper_attestations(signature,expected_text) SELECT 'extra()',expected_text FROM native_turn_helper_attestations`],
    ['generated expression removed', 'ALTER TABLE native_turn_helper_attestations ALTER COLUMN expected_body DROP EXPRESSION'],
    ['column ACL', 'GRANT SELECT(expected_body) ON native_turn_helper_attestations TO app_user'],
    ['relation ACL', 'GRANT SELECT ON native_turn_helper_attestations TO app_user'],
    ['RLS disabled', 'ALTER TABLE native_turn_helper_attestations DISABLE ROW LEVEL SECURITY'],
    ['policy', 'CREATE POLICY unexpected ON native_turn_helper_attestations USING(true)'],
    ['rule', 'CREATE RULE unexpected AS ON DELETE TO native_turn_helper_attestations DO INSTEAD NOTHING'],
    ['trigger', `CREATE FUNCTION unexpected_attestation_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER unexpected BEFORE UPDATE ON native_turn_helper_attestations FOR EACH ROW EXECUTE FUNCTION unexpected_attestation_trigger()`],
    ['extra column', 'ALTER TABLE native_turn_helper_attestations ADD COLUMN unexpected text'],
    ['dropped column', 'ALTER TABLE native_turn_helper_attestations ADD COLUMN unexpected text; ALTER TABLE native_turn_helper_attestations DROP COLUMN unexpected'],
    ['copied table', `ALTER TABLE native_turn_helper_attestations RENAME TO original_attestations;
      CREATE TABLE native_turn_helper_attestations(LIKE original_attestations INCLUDING ALL);
      INSERT INTO native_turn_helper_attestations(signature,expected_text) SELECT signature,expected_text FROM original_attestations;
      ALTER TABLE native_turn_helper_attestations ENABLE ROW LEVEL SECURITY`],
    ['later cohort', `INSERT INTO native_turn_contract_helpers SELECT 'native_turn_helpers_current()',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
      FROM pg_proc p WHERE oid='native_turn_helpers_current()'::regprocedure`],
  ])('fails closed on %s without changing the baseline', async (_name, sql) => {
    await db.exec('BEGIN')
    try {
      // Owner mutation needs membership; do not change the guard/table owner.
      if (_name === 'owner') await db.exec('RESET ROLE; GRANT app_user TO fixture_owner; GRANT CREATE ON SCHEMA public TO app_user; SET ROLE fixture_owner')
      await db.exec(sql)
      expect(await valid()).toBe(false)
    } finally { await db.exec('ROLLBACK') }
    expect(await valid()).toBe(true)
  })
  it('does not allow generated fingerprints/body/metadata to be written independently', async () => {
    for (const column of ['original_fingerprint', 'expected_body', 'expected_metadata']) {
      await expect(db.exec(`UPDATE native_turn_helper_attestations SET ${column}=NULL`)).rejects.toThrow(/generated|DEFAULT/i)
    }
    expect(await valid()).toBe(true)
  })
})
