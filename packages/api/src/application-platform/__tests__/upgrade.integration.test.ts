import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, queryWithRLS } from '../../db/client.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { ApplicationPlatformService } from '../service.js'
import { ApplicationManagementService } from '../management.js'
import { createCanonicalGenericApplicationModule } from '../generic-adapter.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
if(!process.env.BRIAN_UPGRADE_OBSERVATION)throw Error('Run through actual upgrade-rehearsal.mjs')
const witness=JSON.parse(await readFile(process.env.BRIAN_UPGRADE_OBSERVATION,'utf8'))
const ids=witness.ids,owner=getPool()
afterAll(async()=>{await getAppPool().end();await owner.end()})
describe('[COMP:api/application-platform-acceptance] actual prefeature upgrade with old reads and current clients',()=>{
 it('crosses the real prefeature boundary once while the nonowner old reader remains active',async()=>{
  expect(witness.mode).toBe('upgrade');expect(witness.callbacks).toBe(1);expect(witness.reads.length).toBeGreaterThanOrEqual(3)
  expect(witness.reads[0].featurePresent).toBe(false);expect(witness.reads.some((read:{featurePresent:boolean})=>read.featurePresent)).toBe(true)
  expect(witness.reads.every((read:{runtimeRole:string})=>read.runtimeRole==='app_user')).toBe(true)
  const role=await getAppPool().query(`SELECT rolsuper,rolbypassrls,rolinherit,(SELECT count(*)::int FROM pg_auth_members WHERE member=pg_roles.oid OR roleid=pg_roles.oid) AS memberships,((SELECT count(*) FROM pg_class WHERE relowner=pg_roles.oid)+(SELECT count(*) FROM pg_proc WHERE proowner=pg_roles.oid)+(SELECT count(*) FROM pg_namespace WHERE nspowner=pg_roles.oid))::int AS owned FROM pg_roles WHERE rolname=current_user`)
  expect(role.rows).toEqual([{rolsuper:false,rolbypassrls:false,rolinherit:false,memberships:0,owned:0}])
  const ledger=await owner.query("SELECT name FROM _migrations WHERE name IN('8000_application_clients_and_grants.sql','8002_application_record_contract.sql') ORDER BY name")
  expect(ledger.rows).toHaveLength(2)
 })
 it('preserves original IDs, links, values, queue state, schedule and membership ceilings',async()=>{
  const actual=(await owner.query(`SELECT json_build_object(
   'record',(SELECT json_build_object('id',id,'data',data,'created_by',created_by) FROM entity_instances WHERE id=$1),
   'link',(SELECT json_build_object('id',id,'source_id',source_id,'target_id',target_id) FROM entity_links WHERE id=$2),
   'approval',(SELECT json_build_object('id',id,'status',status,'arguments',arguments,'approval_payload',approval_payload) FROM pending_approvals WHERE id=$3),
   'job',(SELECT json_build_object('id',id,'enabled',enabled,'schedule',schedule,'instructions',instructions,'next_run_at',next_run_at) FROM scheduled_jobs WHERE id=$4),
   'grant',(SELECT json_build_object('user_id',user_id,'role',role,'clearance',clearance) FROM workspace_members WHERE workspace_id=$5 AND user_id=$6)) AS state`,[ids.record,ids.link,ids.approval,ids.job,ids.workspace,ids.user])).rows[0].state
  expect(actual).toEqual(witness.before)
 })
 it('reads the preserved generic record through the current canonical native client and refuses foreign identity',async()=>{
  const store=createDbDocEntityStore({actorUserId:ids.user})
  const record=await store.getEntity(ids.workspace,ids.record)
  expect(record?.id).toBe(ids.record);expect(record?.data).toEqual({title:{kind:'text',value:'Fictional legacy value'}})
  expect((await queryWithRLS('00000000-0000-0000-0000-000000000001','SELECT id FROM entity_instances WHERE id=$1',[ids.record])).rows).toEqual([])
 })
 it('keeps activation opt-in and global qualification honest after upgrade',async()=>{
  const management=new ApplicationManagementService(new ApplicationPlatformService([createCanonicalGenericApplicationModule()]))
  const overview=await management.overview(ids.user,ids.workspace)
  expect(overview.readiness).toMatchObject({qualified:false,canActivate:false})
  expect((await owner.query('SELECT id FROM application_clients WHERE workspace_id=$1',[ids.workspace])).rows).toEqual([])
 })
})
