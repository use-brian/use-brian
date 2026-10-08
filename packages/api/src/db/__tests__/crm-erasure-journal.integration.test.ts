import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {getPool,getAppPool} from '../client.js'
import {captureCrmErasure} from '../../crm-operations/erasure-journal.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),app=getAppPool()
async function fixture() {
  const user=randomUUID(),workspace=randomUUID(),contact=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[user])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Recovery fixture',$2)",[workspace,user])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,user])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,source,created_by_user_id) VALUES($1::uuid,$2,'person','Private original name',$1::text,'manual',$3)",[contact,workspace,user])
  return {user,workspace,contact}
}
describe('[COMP:operations/crm-recovery] Transactional erasure effects',()=>{
  afterAll(async()=>{await pool.end();await app.end()})
  it('registers durable workflow authority receipts and admission tables in fresh schema recovery', async () => {
    const tables = ['workspace_file_workflow_admissions','workflow_task_event_receipts','workflow_task_pause_admissions',
      'workflow_knowledge_event_receipts','workflow_page_event_receipts','workflow_page_event_observations']
    const rows = (await pool.query(`SELECT t.table_name,cardinality(t.key_columns)>0 AS keyed,
      EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=('public.'||t.table_name)::regclass
        AND g.tgname='crm_recovery_capture' AND g.tgenabled='O') AS captured
      FROM crm_erasure_journal_targets t WHERE t.table_name=ANY($1::text[]) ORDER BY t.table_name`,[tables])).rows
    expect(rows).toEqual(tables.sort().map(table_name=>({table_name,keyed:true,captured:true})))
  })
  it('captures only changed after-values and keys, with rollback and transaction-local isolation',async()=>{
    const f=await fixture(),client=await pool.connect()
    try {
      expect((await client.query('SELECT count(*)::int n FROM crm_erasure_journal WHERE workspace_id=$1',[f.workspace])).rows[0].n).toBe(0)
      await client.query('BEGIN');await captureCrmErasure(client)
      await client.query("UPDATE entities SET display_name='Removed' WHERE id=$1",[f.contact])
      await client.query('ROLLBACK')
      expect((await client.query('SELECT count(*)::int n FROM crm_erasure_journal WHERE workspace_id=$1',[f.workspace])).rows[0].n).toBe(0)
      await client.query('BEGIN');await captureCrmErasure(client)
      await client.query("UPDATE entities SET display_name='Removed' WHERE id=$1",[f.contact])
      await client.query('DELETE FROM entities WHERE id=$1',[f.contact]);await client.query('COMMIT')
      const rows=(await client.query('SELECT operation,row_key,effect FROM crm_erasure_journal WHERE workspace_id=$1 AND table_name=\'entities\' ORDER BY sequence',[f.workspace])).rows
      expect(rows).toEqual([{operation:'update',row_key:{id:f.contact},effect:expect.objectContaining({display_name:'Removed'})},{operation:'delete',row_key:{id:f.contact},effect:null}])
      expect(JSON.stringify(rows)).not.toContain('Private original name')
      expect(JSON.stringify(rows)).not.toContain('canonical_id')
      expect((await client.query("SELECT current_setting('app.crm_erasure_capture',true) value")).rows[0].value).not.toBe('on')
    } finally {client.release()}
  })
  it('captures cascade deletions and composite primary keys',async()=>{
    const f=await fixture(),client=await pool.connect()
    try {
      await client.query(`BEGIN;
        CREATE TABLE public.assurance_recovery_parent(workspace_id uuid,source_key text,content text,PRIMARY KEY(workspace_id,source_key));
        CREATE TABLE public.assurance_recovery_child(id uuid PRIMARY KEY,workspace_id uuid,source_key text,
          FOREIGN KEY(workspace_id,source_key) REFERENCES public.assurance_recovery_parent(workspace_id,source_key) ON DELETE CASCADE);
        SELECT crm_install_erasure_capture()`)
      const child=randomUUID()
      await client.query("INSERT INTO public.assurance_recovery_parent VALUES($1,'fixture','Private parent payload')",[f.workspace])
      await client.query("INSERT INTO public.assurance_recovery_child VALUES($1,$2,'fixture')",[child,f.workspace])
      await captureCrmErasure(client)
      await client.query('DELETE FROM public.assurance_recovery_parent WHERE workspace_id=$1',[f.workspace])
      const rows=(await client.query("SELECT table_name,operation,row_key,effect FROM crm_erasure_journal WHERE workspace_id=$1 ORDER BY sequence",[f.workspace])).rows
      expect(rows).toEqual(expect.arrayContaining([
        {table_name:'assurance_recovery_parent',operation:'delete',row_key:{workspace_id:f.workspace,source_key:'fixture'},effect:null},
        {table_name:'assurance_recovery_child',operation:'delete',row_key:{id:child},effect:null},
      ]))
      expect(JSON.stringify(rows)).not.toContain('Private parent payload')
    } finally {await client.query('ROLLBACK');client.release()}
  })
  it('refuses journal edits and hides protected evidence from an unrelated application principal',async()=>{
    const f=await fixture(),client=await pool.connect()
    try {await client.query('BEGIN');await captureCrmErasure(client);await client.query('DELETE FROM entities WHERE id=$1',[f.contact]);await client.query('COMMIT')}
    finally {client.release()}
    await expect(pool.query('DELETE FROM crm_erasure_journal WHERE workspace_id=$1',[f.workspace])).rejects.toThrow('immutable')
    expect((await app.query('SELECT * FROM crm_erasure_journal WHERE workspace_id=$1',[f.workspace])).rows).toEqual([])
    await expect(app.query("INSERT INTO crm_erasure_journal(workspace_id,table_name,operation,row_key) VALUES($1,'entities','delete','{}')",[f.workspace])).rejects.toThrow(/row-level security/)
  })
  it('refuses an unkeyed captured mutation instead of losing recovery evidence',async()=>{
    const client=await pool.connect()
    try {
      await client.query('BEGIN; CREATE TABLE public.assurance_unkeyed_fixture(value text); SELECT crm_install_erasure_capture(); INSERT INTO public.assurance_unkeyed_fixture VALUES(\'private\')')
      await captureCrmErasure(client)
      await expect(client.query('DELETE FROM public.assurance_unkeyed_fixture')).rejects.toThrow('primary key')
    } finally {await client.query('ROLLBACK');client.release()}
  })
})
