import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const fixtureRuntimeRole = new URL(process.env.DATABASE_URL_APP!).username
if (!['app_user','assurance_app'].includes(fixtureRuntimeRole)) throw Error('Unexpected maintained fixture runtime role')
const owner = new pg.Client({ connectionString: process.env.DATABASE_URL })
const runtime = new pg.Client({ connectionString: process.env.DATABASE_URL_APP })
beforeAll(async () => { await owner.connect(); await runtime.connect() })
afterAll(async () => { await runtime.end(); await owner.end() })
describe('[COMP:api/application-platform-acceptance] actual installed runtime privilege floor', () => {
  it('records owner privileges and requires a separate nonowner nonbypass runtime without memberships', async () => {
    const result = await runtime.query(`SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit,
      (SELECT count(*)::int FROM pg_auth_members WHERE member=pg_roles.oid OR roleid=pg_roles.oid) AS memberships,
      (SELECT count(*)::int FROM pg_class WHERE relowner=pg_roles.oid) AS owned FROM pg_roles WHERE rolname=current_user`)
    expect(result.rows).toEqual([{ rolname:fixtureRuntimeRole,rolsuper:false,rolbypassrls:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,memberships:0,owned:0 }])
    const installation = await owner.query('SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
    expect(installation.rows[0]).toEqual({role:'assurance_owner',rolsuper:true,rolbypassrls:true})
    console.log(JSON.stringify({installationRole:installation.rows[0],runtimeRole:result.rows[0]}))
  })
  it('executes the public guarded port and denies private functions and migration-revoked tables', async () => {
    expect((await runtime.query("SELECT application_native_crm_configuration_protected('00000000-0000-0000-0000-000000000000') AS allowed")).rows).toEqual([{allowed:false}])
    await expect(runtime.query("SELECT application_scoped_qualified_before_frontend('00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000')")).rejects.toMatchObject({code:'42501'})
    for (const relation of ['connector_actor_signing_keys','connector_actor_key_events','external_source_resources','external_source_observations','external_source_authorizations','application_native_configuration_operations','application_native_configuration_execution','session_message_annotation_heads','_migrations']) {
      await expect(runtime.query(`SELECT 1 FROM public.${relation} LIMIT 1`)).rejects.toMatchObject({code:'42501'})
    }
  })
})
