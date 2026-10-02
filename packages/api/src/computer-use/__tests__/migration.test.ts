import { it,expect } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
it('migration creates metadata-only tables and unknown latch survives revocation',async()=>{
 const db=new PGlite()
 try {
  for(const table of ['users','workspaces','assistants','sessions','tasks','auth_sessions']) await db.exec(`CREATE TABLE ${table}(id uuid PRIMARY KEY); INSERT INTO ${table} VALUES ('00000000-0000-4000-8000-000000000001')`)
  await db.exec(await readFile(new URL('../../../migrations/620_native_computer_sessions.sql',import.meta.url),'utf8'))
  const id='00000000-0000-4000-8000-000000000001'
  await db.query(`INSERT INTO native_computer_sessions(id,user_id,auth_session_id,workspace_id,assistant_id,conversation_id,task_id,device_id,deployment_id,challenge,expires_at) VALUES($1,$1,$1,$1,$1,$1,$1,'device','deployment','challenge',now()+interval '1 minute')`,[id])
  await db.query(`UPDATE native_computer_sessions SET state='execution_unknown',revoked_at=now() WHERE id=$1`,[id])
  await expect(db.query(`INSERT INTO native_computer_sessions(id,user_id,auth_session_id,workspace_id,assistant_id,conversation_id,task_id,device_id,deployment_id,challenge,expires_at) VALUES('00000000-0000-4000-8000-000000000002',$1,$1,$1,$1,$1,$1,'device','deployment','challenge',now()+interval '1 minute')`,[id])).rejects.toThrow('native_computer_device_lease')
  await db.query(`INSERT INTO native_computer_audit(session_id,event) VALUES($1,'created')`,[id])
  for(const table of ['sessions','tasks','assistants','auth_sessions','users','workspaces']) await db.exec(`DELETE FROM ${table}`)
  const retained=await db.query<{state:string;user_id:null;conversation_id:null}>(`SELECT * FROM native_computer_sessions`)
  expect(retained.rows[0].state).toBe('execution_unknown')
  expect(retained.rows[0].user_id).toBeNull()
  expect(retained.rows[0].conversation_id).toBeNull()
  expect((await db.query('SELECT * FROM native_computer_audit')).rows).toHaveLength(1)
  const columns=await db.query<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_name='native_computer_sessions'")
  for(const forbidden of ['goal','text','frame','token','grant'])expect(columns.rows.map(r=>r.column_name)).not.toContain(forbidden)
 } finally {await db.close()}
},30_000)
