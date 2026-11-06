/** [COMP:api/context-scope-security-matrix] Executed predecessor upgrade proof. */
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { vector } from '@electric-sql/pglite-pgvector'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { migratePglite, preparePgliteRuntimeRole } from '../migrate-pglite.js'

export async function assertHistoricalScopeUpgrade(through: string, last: string): Promise<void> {
  const directory=fileURLToPath(new URL('../../../../packages/api/migrations',import.meta.url))
  const previous=new PGlite({extensions:{vector,pg_trgm}})
  try{
    await previous.waitReady
    await preparePgliteRuntimeRole(previous)
    await migratePglite(previous,directory,{through})
    const workspace='71000000-0000-4000-8000-00000000000'+last
    const owner='72000000-0000-4000-8000-00000000000'+last
    const assistant='73000000-0000-4000-8000-00000000000'+last
    const session='74000000-0000-4000-8000-00000000000'+last
    await previous.query('INSERT INTO users(id,auth_provider_id,name) VALUES($1,$2,$3)',[owner,'completion-'+last,'Existing owner'])
    await previous.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Completion upgrade',$2)",[workspace,owner])
    await previous.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner])
    await previous.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Existing assistant',$2,$3,'standard')",[assistant,workspace,owner])
    await previous.query("INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,status,workspace_id) VALUES($1,$2,$3,'web',$4,'idle',$5)",[session,assistant,owner,'completion-'+last,workspace])
    await previous.query("INSERT INTO workspace_access_policies(workspace_id,classification_mode,reviewed_inventory_revision) VALUES($1,'review',1) ON CONFLICT(workspace_id) DO UPDATE SET classification_mode='review',reviewed_inventory_revision=1",[workspace])
    assert.ok(await migratePglite(previous,directory)>0)
    assert.equal(await migratePglite(previous,directory),0)
    assert.deepEqual((await previous.query('SELECT name FROM workspaces WHERE id=$1',[workspace])).rows,[{name:'Completion upgrade'}])
    assert.deepEqual((await previous.query('SELECT context_binding_origin FROM assistants WHERE id=$1',[assistant])).rows,[{context_binding_origin:'legacy'}])
    assert.deepEqual((await previous.query('SELECT context_binding_origin FROM sessions WHERE id=$1',[session])).rows,[{context_binding_origin:'legacy'}])
    assert.equal((await previous.query<{name:string}>("SELECT name FROM public._migrations WHERE name='603_complete_scope_inventory.sql'")).rows[0].name,'603_complete_scope_inventory.sql')
    assert.equal((await previous.query<{revision:number}>('SELECT scope_review_registry_revision()::int AS revision')).rows[0].revision,2)
    assert.equal((await previous.query<{revision:number}>('SELECT reviewed_inventory_revision::int AS revision FROM workspace_access_policies WHERE workspace_id=$1',[workspace])).rows[0].revision,1)
    await assert.rejects(previous.query("UPDATE assistants SET context_binding_origin='invented' WHERE id=$1",[assistant]))
    assert.deepEqual((await previous.query('SELECT context_binding_origin FROM assistants WHERE id=$1',[assistant])).rows,[{context_binding_origin:'legacy'}])
  }finally{await previous.close()}
}
