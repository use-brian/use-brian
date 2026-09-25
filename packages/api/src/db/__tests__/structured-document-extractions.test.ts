import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
vi.mock('../office-artifacts.js', () => ({ defaultOfficeDbQuery: vi.fn() }))
import { createStructuredExtractionStore } from '../structured-document-extractions.js'
import type { OfficeDbQuery } from '../office-artifacts.js'

describe('[COMP:api/structured-document-store] structured extraction SQL contract', () => {
  function setup() { const query = vi.fn(async () => ({rows:[]})); return {query,store:createStructuredExtractionStore(query as OfficeDbQuery)} }
  it('claims only the actor queue, atomically, without erasing uncertain submitting', async () => {
    const {store,query} = setup()
    await store.claim('actor','token',120000)
    const [actor,sql,params] = query.mock.calls[0] as unknown as [string,string,unknown[]]
    expect(actor).toBe('actor'); expect(params).toEqual(['actor','token',120000])
    expect(sql).toContain('user_id=$1'); expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain('lease_expires_at<=now()'); expect(sql).not.toContain("SET status=")
  })
  it('fences every checkpoint by actor, token, active status and live expiry', async () => {
    const {store,query} = setup()
    expect(await store.update('actor','job','old-token','running',{status:'archiving',retryMs:5000})).toBeNull()
    const [,sql,params] = query.mock.calls[0] as unknown as [string,string,unknown[]]
    expect(sql).toContain('user_id=$1 AND id=$2 AND lease_token=$3 AND status=$4 AND lease_expires_at>now()')
    expect(sql).toContain('lease_token=NULL'); expect(sql).toContain('next_attempt_at=')
    expect(params.slice(0,4)).toEqual(['actor','job','old-token','running'])
  })
  it('cannot resurrect terminal jobs or bypass submitting to complete', async () => {
    const {store,query} = setup()
    await expect(store.update('a','j','t','completed',{status:'queued'})).rejects.toThrow('invalid_transition')
    await expect(store.update('a','j','t','queued',{status:'completed'})).rejects.toThrow('invalid_transition')
    expect(query).not.toHaveBeenCalled()
  })
  it('start only queues prepared jobs and get is explicitly actor scoped', async () => {
    const {store,query} = setup()
    await store.enqueue('actor','job'); await store.get('actor','job')
    const calls = query.mock.calls as unknown as [string,string,unknown[]][]
    expect(calls[0][1]).toContain("WHEN status='prepared' THEN 'queued' ELSE status")
    expect(calls.every(c => c[1].includes('user_id=$1 AND id=$2'))).toBe(true)
  })
  it('migration enables actor/member RLS with owner discovery, scoped FKs and no trigger', () => {
    const sql = readFileSync(new URL('../../../migrations/557_structured_document_extractions.sql',import.meta.url),'utf8')
    expect(sql).toContain('ALTER TABLE structured_document_extractions ENABLE ROW LEVEL SECURITY')
    expect(sql).not.toContain('ALTER TABLE structured_document_extractions FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('ALTER TABLE structured_document_fill_proposals FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("current_setting('app.current_user_id',true)")
    expect(sql).toContain('REFERENCES workspace_members(workspace_id,user_id)')
    expect(sql).toContain('REFERENCES workspace_files(workspace_id,id)')
    expect(sql).toContain("status <> 'completed'")
    expect(sql).toContain('134217728'); expect(sql).not.toMatch(/CREATE TRIGGER/i)
  })
})

// Explicit opt-in embedded Postgres only; no external database connection.
const pgliteModule = process.env.STRUCTURED_TEST_PGLITE_MODULE
it.skipIf(!pgliteModule)('allows non-superuser owner discovery without GUC while isolating app actors', async () => {
  const { PGlite } = await import(/* @vite-ignore */ pgliteModule!)
  const pg = new PGlite()
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
  try {
    await pg.exec(`
      CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE workspaces(id uuid PRIMARY KEY);
      CREATE TABLE assistants(id uuid PRIMARY KEY);
      CREATE TABLE workspace_members(workspace_id uuid,user_id uuid,UNIQUE(workspace_id,user_id));
      CREATE TABLE workspace_files(id uuid PRIMARY KEY,workspace_id uuid NOT NULL);
      CREATE TABLE office_artifacts(id uuid PRIMARY KEY,workspace_id uuid NOT NULL);
      CREATE TABLE office_artifact_versions(id uuid PRIMARY KEY,artifact_id uuid NOT NULL);
    `)
    await pg.exec(readFileSync(new URL('../../../migrations/3943_office_collaboration.sql',import.meta.url),'utf8'))
    await pg.exec(readFileSync(new URL('../../../migrations/557_structured_document_extractions.sql',import.meta.url),'utf8'))
    await pg.exec(`
      CREATE ROLE extraction_system_owner NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE extraction_app NOSUPERUSER NOBYPASSRLS;
      ALTER TABLE structured_document_extractions OWNER TO extraction_system_owner;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO extraction_system_owner, extraction_app;
      INSERT INTO users VALUES ('${id(1)}'),('${id(2)}');
      INSERT INTO workspaces VALUES ('${id(3)}');
      INSERT INTO workspace_members VALUES ('${id(3)}','${id(1)}'),('${id(3)}','${id(2)}');
      INSERT INTO workspace_files VALUES ('${id(4)}','${id(3)}');
      INSERT INTO structured_document_extractions(id,user_id,workspace_id,source_file_id,pdf_sha256,context,status)
      VALUES ('${id(5)}','${id(1)}','${id(3)}','${id(4)}','${'a'.repeat(64)}','{}','queued'),
             ('${id(6)}','${id(2)}','${id(3)}','${id(4)}','${'a'.repeat(64)}','{}','queued');
      SET ROLE extraction_system_owner;
    `)
    expect((await pg.query("SELECT current_setting('app.current_user_id',true) AS actor")).rows[0].actor).toBeNull()
    const role = (await pg.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    expect(role).toEqual({rolsuper:false,rolbypassrls:false})
    expect((await pg.query("SELECT tableowner FROM pg_tables WHERE tablename='structured_document_extractions'")).rows[0].tableowner).toBe('extraction_system_owner')
    const pending = `SELECT DISTINCT user_id FROM structured_document_extractions
      WHERE status IN ('queued','submitting','running','archiving') AND next_attempt_at<=now()
      AND (lease_expires_at IS NULL OR lease_expires_at<=now()) ORDER BY user_id`
    expect((await pg.query(pending)).rows).toEqual([{user_id:id(1)},{user_id:id(2)}])
    // Even when using the owner pool, ordinary store reads keep explicit actor predicates.
    const ownerStore = createStructuredExtractionStore((async (_user: string,sql: string,params: unknown[]) => pg.query(sql,params)) as OfficeDbQuery)
    expect(await ownerStore.get(id(1),id(6))).toBeNull()
    await pg.exec('RESET ROLE; SET ROLE extraction_app')
    expect((await pg.query(pending)).rows).toEqual([])
    await pg.query("SELECT set_config('app.current_user_id',$1,false)",[id(1)])
    expect((await pg.query(pending)).rows).toEqual([{user_id:id(1)}])
    expect((await pg.query('SELECT id FROM structured_document_extractions WHERE id=$1',[id(6)])).rows).toEqual([])
    await pg.query("SELECT set_config('app.current_user_id',$1,false)",[id(2)])
    expect((await pg.query(pending)).rows).toEqual([{user_id:id(2)}])
  } finally { await pg.close() }
}, 30000)
