import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
vi.mock('../office-artifacts.js', () => ({ defaultOfficeDbQuery: vi.fn() }))
import { createStructuredFillProposalStore, type StructuredFillProposalInput } from '../structured-fill-proposals.js'
import type { OfficeDbQuery } from '../office-artifacts.js'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const input: StructuredFillProposalInput = {
  userId:uuid(1),workspaceId:uuid(2),artifactId:uuid(3),baseVersionId:uuid(4),expectedSeq:1,
  assistantId:uuid(5),extractionId:uuid(6),evidenceHash:'a'.repeat(64),
  command:{type:'batch',commands:[]},preview:[{targetId:uuid(9),value:'0012'}],
  lineage:[{recordId:'record:1',cellId:'cell:1',targetId:uuid(9)}],body:'Unreviewed source evidence. 0012',targetIds:[uuid(9)],
}
const migration = () => readFileSync(new URL('../../../migrations/557_structured_document_extractions.sql',import.meta.url),'utf8')

describe('[COMP:api/structured-document-store] structured fill proposal SQL contract', () => {
  function setup() { const query=vi.fn(async (_actor: string,_sql: string,_params: unknown[]) => ({rows:[]})); return {query,store:createStructuredFillProposalStore(query as OfficeDbQuery)} }
  it('uses one atomic reservation/thread/message/suggestion statement with locked live preconditions', async () => {
    const {query,store}=setup(); expect(await store.save(input)).toBeNull(); expect(query).toHaveBeenCalledTimes(1)
    const [actor,sql,params]=query.mock.calls[0]
    expect(actor).toBe(input.userId); expect(params[4]).toBe(1)
    for (const part of ["a.lifecycle_state='active'",'a.head_version_id=$4 AND c.seq=$5','FOR UPDATE OF a,c',"e.status='completed'",'INSERT INTO structured_document_fill_proposals','INSERT INTO office_comment_threads','INSERT INTO office_comment_messages','INSERT INTO office_suggestions',"'assistant'",'WHERE p.payload_hash=EXCLUDED.payload_hash']) expect(sql).toContain(part)
    expect(sql).not.toMatch(/advisory|UPDATE office_collab_documents|UPDATE office_artifacts/)
    expect(params[12]).toBe(input.body); expect(JSON.parse(params[11] as string)).toEqual(input.lineage)
  })
  it('binds full payload, canonicalizes key order and domain-separates stable UUIDs', async () => {
    const {query,store}=setup(); await store.save(input)
    await store.save({...input,command:{commands:[],type:'batch'}})
    await store.save({...input,body:'Different explanation'})
    const [a,b,c]=query.mock.calls.map(call=>call[2])
    expect(a[8]).toBe(b[8]); expect(a[8]).not.toBe(c[8])
    expect(a.slice(14)).toEqual(b.slice(14)); expect(a.slice(14)).toEqual(c.slice(14))
    expect(new Set(a.slice(14)).size).toBe(3)
    for (const id of a.slice(14)) expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  })
  it('rejects unbounded or non-JSON payloads before any DB call', async () => {
    const {query,store}=setup()
    for (const patch of [{body:''},{body:'x'.repeat(20001)},{body:'bad\0body'},{targetIds:[]},{targetIds:[uuid(9),uuid(9)]},{expectedSeq:0},{command:undefined},{preview:{x:NaN}}]) await expect(store.save({...input,...patch})).rejects.toThrow('invalid_proposal_payload')
    expect(query).not.toHaveBeenCalled()
  })
  it('scopes reads and migration references to actor/workspace', async () => {
    const {query,store}=setup(); await store.get(input.userId,uuid(10)); expect(query.mock.calls[0][1]).toContain('WHERE user_id=$1 AND id=$2')
    const sql=migration(); expect(sql).toContain('ALTER TABLE structured_document_fill_proposals FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('REFERENCES structured_document_extractions(workspace_id,user_id,id)')
    expect(sql).toContain('REFERENCES office_suggestions(workspace_id,artifact_id,id) DEFERRABLE INITIALLY DEFERRED')
    expect(sql).toContain('UNIQUE(user_id,workspace_id,extraction_id,artifact_id,evidence_hash)')
  })
})

// Opt-in local embedded Postgres. Never connects to an external database.
const pgliteModule = process.env.STRUCTURED_TEST_PGLITE_MODULE
it.skipIf(!pgliteModule)('[COMP:api/structured-document-store] executes migration and atomic proposal inserts in ephemeral PGLite', async () => {
  const {PGlite} = await import(/* @vite-ignore */ pgliteModule!)
  const pg = new PGlite()
  try {
    await pg.exec(`
      CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE workspaces(id uuid PRIMARY KEY);
      CREATE TABLE assistants(id uuid PRIMARY KEY);
      CREATE TABLE workspace_members(workspace_id uuid,user_id uuid,UNIQUE(workspace_id,user_id));
      CREATE TABLE workspace_files(id uuid PRIMARY KEY,workspace_id uuid NOT NULL);
      CREATE TABLE office_artifacts(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,head_version_id uuid,lifecycle_state text,family text,mode text);
      CREATE TABLE office_artifact_versions(id uuid PRIMARY KEY,artifact_id uuid NOT NULL);
    `)
    await pg.exec(readFileSync(new URL('../../../migrations/3943_office_collaboration.sql',import.meta.url),'utf8'))
    await pg.exec(migration())
    await pg.exec(`
      INSERT INTO users VALUES ('${uuid(1)}'),('${uuid(11)}');
      INSERT INTO workspaces VALUES ('${uuid(2)}');
      INSERT INTO assistants VALUES ('${uuid(5)}');
      INSERT INTO workspace_members VALUES ('${uuid(2)}','${uuid(1)}'),('${uuid(2)}','${uuid(11)}');
      INSERT INTO workspace_files VALUES ('${uuid(7)}','${uuid(2)}'),('${uuid(8)}','${uuid(2)}');
      INSERT INTO office_artifacts VALUES ('${uuid(3)}','${uuid(2)}','${uuid(4)}','active','spreadsheet','artifact');
      INSERT INTO office_artifact_versions VALUES ('${uuid(4)}','${uuid(3)}');
      INSERT INTO office_collab_documents(artifact_id,workspace_id,ydoc,state_vector,canonical_hash,base_version) VALUES ('${uuid(3)}','${uuid(2)}','\\x','\\x','${'b'.repeat(64)}',1);
      INSERT INTO structured_document_extractions(id,user_id,workspace_id,source_file_id,pdf_sha256,context,status,remote_job_id,records_file_id,records_sha256,document_id,page_numbers,image_files)
      VALUES ('${uuid(6)}','${uuid(1)}','${uuid(2)}','${uuid(7)}','${'c'.repeat(64)}','{}','completed','remote','${uuid(8)}','${'d'.repeat(64)}','document','[1]','[{"page":1}]');
      CREATE ROLE proposal_actor;
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO proposal_actor;
      SET ROLE proposal_actor;
    `)
    const query: OfficeDbQuery = async <T>(actor: string,sql: string,params: unknown[]) => {
      await pg.query("SELECT set_config('app.current_user_id',$1,false)",[actor])
      return await pg.query(sql,params) as {rows:T[]}
    }
    const store=createStructuredFillProposalStore(query)
    const first=await store.save(input); expect(first).toBeTruthy()
    expect(await store.save(input)).toEqual(first)
    expect(await store.save({...input,body:'conflicting payload'})).toBeNull()
    expect(await store.get(uuid(11),first!.id)).toBeNull()
    expect(await store.save({...input,userId:uuid(11)})).toBeNull()
    await pg.exec('RESET ROLE')
    for (const table of ['structured_document_fill_proposals','office_comment_threads','office_comment_messages','office_suggestions']) expect((await pg.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(1)
    await pg.exec(`UPDATE office_collab_documents SET seq=2; SET ROLE proposal_actor`)
    expect(await store.save({...input,evidenceHash:'e'.repeat(64)})).toBeNull()
    expect(await store.save(input)).toEqual(first) // exact retry, not a new stale proposal
    await pg.exec(`RESET ROLE; UPDATE office_artifacts SET head_version_id=NULL; SET ROLE proposal_actor`)
    expect(await store.save({...input,expectedSeq:2,evidenceHash:'f'.repeat(64)})).toBeNull()
    // A failing dependent Office insert rolls back reservation and thread too.
    await pg.exec(`RESET ROLE; UPDATE office_artifacts SET head_version_id='${uuid(4)}'; ALTER TABLE office_comment_messages ADD CONSTRAINT synthetic_reject CHECK(body <> 'reject this message'); SET ROLE proposal_actor`)
    await expect(store.save({...input,expectedSeq:2,evidenceHash:'f'.repeat(64),body:'reject this message'})).rejects.toThrow()
    await pg.exec('RESET ROLE')
    expect((await pg.query('SELECT count(*)::int AS n FROM structured_document_fill_proposals')).rows[0].n).toBe(1)
    expect((await pg.query('SELECT count(*)::int AS n FROM office_comment_threads')).rows[0].n).toBe(1)
    await pg.exec(`DELETE FROM workspace_members WHERE user_id='${uuid(1)}'; SET ROLE proposal_actor`)
    expect(await store.get(uuid(1),first!.id)).toBeNull()
    expect(await store.save({...input,expectedSeq:2,evidenceHash:'f'.repeat(64)})).toBeNull()
  } finally { await pg.close() }
}, 30000)
