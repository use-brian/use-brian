/** [COMP:platform/local-rig] [COMP:api/native-turn-frame] Installed canonical contract boundary. */
import {afterAll,describe,expect,it} from 'vitest'
import {getAppPool,getPool,rollbackAndRelease} from '../db/client.js'
const {assertLocalFixture}=await import(new URL('../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
const {runtimeRoleSql}=await import(new URL('../../../../scripts/crm/runtime-role.mjs',import.meta.url).href)
await assertLocalFixture()
const verify=(await runtimeRoleSql('verify')).replace(/^BEGIN;\n/,'').replace(/\nCOMMIT;\n$/,'')
afterAll(async()=>{await getAppPool().end();await getPool().end()})
describe.sequential('[COMP:platform/local-rig] canonical runtime installation',()=>{
 it('verifies the installed owner with the old Memory comparator absent',async()=>{
  expect((await getPool().query("SELECT to_regprocedure('application_memory_statement_helpers_current()') old,native_turn_helpers_current() current")).rows[0]).toEqual({old:null,current:true})
  await getPool().query(verify)
  expect((await getAppPool().query("SELECT has_table_privilege(current_user,'native_turn_contract_helpers','SELECT,INSERT,UPDATE,DELETE') exposed")).rows[0].exposed).toBe(false)
 })
 for(const change of ['root body','root cost','root ACL','leaf body','leaf cost','leaf ACL','registry ACL','missing member','missing migration'] as const){
  it(`refuses ${change} before invoking an unknown executable`,async()=>{
   const client=await getPool().connect()
   try{
    await client.query('BEGIN')
    const signature=change.startsWith('root')?'native_turn_helpers_current()':'application_memory_field_keys()'
    if(change.endsWith('body')){
     const fn=(await client.query('SELECT pg_get_functiondef(oid) definition,prosrc FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0]
     const replacement=change.startsWith('root')?"SELECT pg_temp.fictional_unknown_guard()":fn.prosrc+'\n-- Fictional unreviewed leaf body'
     await client.query("CREATE FUNCTION pg_temp.fictional_unknown_guard() RETURNS boolean LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fictional_unknown_guard_invoked';END$$")
     await client.query(fn.definition.replace(fn.prosrc,()=>replacement))
    }else if(change.endsWith('cost'))await client.query(`ALTER FUNCTION ${signature} COST 101`)
    else if(change==='registry ACL')await client.query('GRANT SELECT ON native_turn_contract_helpers TO app_user')
    else if(change.endsWith('ACL'))await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO app_user`)
    else if(change==='missing member')await client.query("DELETE FROM native_turn_contract_helpers WHERE signature='application_memory_field_keys()'")
    else await client.query("DELETE FROM _migrations WHERE name='8269_canonical_conversation_publication.sql'")
    await expect(client.query(verify)).rejects.toThrow(/Unknown fixture (canonical|Memory) guard/)
   }finally{await rollbackAndRelease(client)}
   await getPool().query(verify)
  })
 }
})
