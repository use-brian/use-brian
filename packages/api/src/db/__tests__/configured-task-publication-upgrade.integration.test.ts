/** [COMP:api/configured-capture-authority] Authenticated successor candidate.
 * Runs only on an explicitly disposable ordinary-owner fixture. A pre-8296
 * fixture installs the generated candidate without altering the migration tree;
 * a maintained 8296 fixture verifies its already installed canonical source. */
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, mkdirSync, readdirSync, symlinkSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool } from '../client.js'
const { assertLocalFixture }=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
const head=await import(new URL('../../../scripts/conversation-store/installation-authentication-8296.mjs',import.meta.url).href)
const directory=fileURLToPath(new URL('../../../scripts/conversation-store/',import.meta.url))
const migrations=fileURLToPath(new URL('../../../migrations/',import.meta.url))
await assertLocalFixture()
process.env.PG_POOL_MAX='1'
afterAll(async()=>{await getPool().end()})
describe('[COMP:api/configured-capture-authority] authenticated task successor',()=>{
 it('installs only after full tuned predecessor proof, authenticates 396 functions, and rejects changed private ACL',async()=>{
  const root=mkdtempSync(join(tmpdir(),'configured-task-upgrade-')),client=await getPool().connect()
  let candidate=false
  try{
   expect((await client.query("SELECT r.rolsuper,r.rolbypassrls,current_user=pg_get_userbyid(c.relowner) AS owner FROM pg_roles r,pg_class c WHERE r.rolname=current_user AND c.oid='public.workspaces'::regclass")).rows[0]).toEqual({rolsuper:false,rolbypassrls:false,owner:true})
   const installed=(await client.query("SELECT to_regprocedure('public.configured_task_source_commit_allowed(uuid,uuid,text,jsonb)') IS NOT NULL AS installed")).rows[0].installed
   if(!installed){
    candidate=true;mkdirSync(join(root,'migrations'))
    for(const name of readdirSync(migrations))if(name!=='8296_configured_task_publication.sql')symlinkSync(join(migrations,name),join(root,'migrations',name))
    const generated=join(root,'migrations','8296_configured_task_publication.sql')
    execFileSync(process.execPath,[directory+'build-configured-task-publication.mjs','--output',generated],{stdio:'pipe'})
    console.log(JSON.stringify({configuredTaskUpgradeStage:'install-generated-candidate'}))
    await client.query(readFileSync(generated,'utf8'))
   }
   const options=candidate?{sourceRoot:root}:undefined
   console.log(JSON.stringify({configuredTaskUpgradeStage:'authenticate',fullInstalledQualification:!candidate}))
   const first=await head.authenticateConversationInstallation(client,options)
   expect(first.functions).toBe(396);expect(first.witnessCurrent).toBe(true)
   expect(await head.authenticateConversationInstallation(client,options)).toEqual(first)
   expect((await client.query('SELECT native_turn_helpers_current() AS current')).rows[0].current).toBe(true)
   const source=await head.currentInstallationAuthenticationSource(options)
   await client.query('BEGIN')
   await client.query('GRANT EXECUTE ON FUNCTION public.configured_task_source_commit_allowed(uuid,uuid,text,jsonb) TO app_user')
   await expect(client.query(source.sql)).rejects.toThrow()
   await client.query('ROLLBACK')
   expect(await head.authenticateConversationInstallation(client,options)).toEqual(first)
   console.log(JSON.stringify({configuredTaskUpgradeStage:'complete',candidateOnly:candidate,receipt:first}))
  }finally{await client.query('ROLLBACK');client.release();rmSync(root,{recursive:true,force:true})}
 },120000)
})
