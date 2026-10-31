import {readFile} from 'node:fs/promises'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {persistentContextFixture} from '../../application-platform/__tests__/fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const migration=await readFile(new URL('../../../migrations/8149_existing_workspace_policy_epochs.sql',import.meta.url),'utf8')
const migrationBody=migration.replace(/^BEGIN;\s*/m,'').replace(/COMMIT;\s*$/,'')

describe.sequential('[COMP:api/policy-epoch] existing workspace epoch upgrade',()=>{
 const fixtures:Awaited<ReturnType<typeof persistentContextFixture>>[]=[]
 afterEach(async()=>{for(const fixture of fixtures.splice(0))await fixture.cleanup()})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){const fixture=await persistentContextFixture();fixtures.push(fixture);return fixture}
 async function epochs(){return(await getPool().query<{workspaceId:string;revision:string}>(
  'SELECT workspace_id AS "workspaceId",revision::text FROM application_policy_workspace_epochs ORDER BY workspace_id')).rows}

 it('upgrades missing epochs with an ordinary owner role while preserving existing revisions and visible Memory',async()=>{
  const legacy=await setup(),current=await setup(),store=createDbMemoryStore()
  await legacy.memory('Fictional ordinary workspace fact')
  await legacy.memory('Fictional confidential workspace fact',null,'confidential')
  const currentRevision=(await epochs()).find(row=>row.workspaceId===current.workspaceId)!.revision
  // Recreate an existing workspace at the pre-epoch upgrade boundary. All
  // native data/visibility remains intact; only its missing metadata is absent.
  await legacy.pool.query('DELETE FROM application_policy_workspace_epochs WHERE workspace_id=$1',[legacy.workspaceId])
  const old=await legacy.modelContext(legacy.firstId)
  const before=await store.getIndex(old.execution.security.access,false,old)
  expect(before.map(row=>row.summary)).toEqual(['Fictional ordinary workspace fact'])
  await expect(old.execution.security.authority.assertCurrent()).resolves.toBeUndefined()

  // Membership in the actual owner role supplies ordinary object ownership,
  // without SUPERUSER or BYPASSRLS privileges. The migration needs neither.
  const owner=(await legacy.pool.query<{name:string}>('SELECT current_user AS name')).rows[0].name
  const ownerIdentifier='"'+owner.replaceAll('"','""')+'"'
  await legacy.pool.query('CREATE ROLE fixture_epoch_upgrade_owner NOLOGIN NOSUPERUSER NOBYPASSRLS')
  try{
   await legacy.pool.query('GRANT '+ownerIdentifier+' TO fixture_epoch_upgrade_owner')
   const client=await legacy.pool.connect()
   try{
    await client.query('BEGIN');await client.query('SET LOCAL ROLE fixture_epoch_upgrade_owner')
    expect((await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
     .toEqual({rolsuper:false,rolbypassrls:false})
    await client.query(migrationBody);await client.query('COMMIT')
   }finally{await client.query('ROLLBACK');client.release()}
  }finally{await legacy.pool.query('DROP ROLE fixture_epoch_upgrade_owner')}

  const repaired=await epochs(),initialized=repaired.find(row=>row.workspaceId===legacy.workspaceId)
  expect(BigInt(initialized!.revision)).toBeGreaterThan(0n)
  expect(repaired.find(row=>row.workspaceId===current.workspaceId)!.revision).toBe(currentRevision)
  expect((await legacy.pool.query(`SELECT count(*)::int AS missing FROM workspaces w
   WHERE NOT EXISTS(SELECT 1 FROM application_policy_workspace_epochs e WHERE e.workspace_id=w.id)`)).rows[0].missing).toBe(0)
  await legacy.pool.query(migration)
  expect(await epochs()).toEqual(repaired)
  const fresh=await legacy.modelContext(legacy.firstId)
  expect(await store.getIndex(fresh.execution.security.access,false,fresh)).toEqual(before)
  await expect(old.execution.security.authority.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
  await expect(fresh.execution.security.authority.assertCurrent()).resolves.toBeUndefined()
  await legacy.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[legacy.workspaceId,legacy.firstId])
  await expect(fresh.execution.security.authority.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
  const narrowed=await legacy.modelContext(legacy.firstId)
  expect(await store.getIndex(narrowed.execution.security.access,false,narrowed)).toEqual([])
 })

 it('keeps epoch rows and the revision sequence private to the host after upgrade',async()=>{
  const fixture=await setup()
  await fixture.pool.query(migration)
  expect((await getAppPool().query(`SELECT rolsuper,rolbypassrls,
   has_table_privilege(current_user,'application_policy_workspace_epochs','SELECT') AS can_read,
   has_table_privilege(current_user,'application_policy_workspace_epochs','INSERT') AS can_insert,
   has_sequence_privilege(current_user,'application_policy_revision_seq','USAGE') AS can_allocate
   FROM pg_roles WHERE rolname=current_user`)).rows[0])
   .toEqual({rolsuper:false,rolbypassrls:false,can_read:false,can_insert:false,can_allocate:false})
  await expect(getAppPool().query('SELECT revision FROM application_policy_workspace_epochs WHERE workspace_id=$1',[fixture.workspaceId]))
   .rejects.toMatchObject({code:'42501'})
  const another=await setup()
  expect((await epochs()).some(row=>row.workspaceId===another.workspaceId&&BigInt(row.revision)>0n)).toBe(true)
 })
})
