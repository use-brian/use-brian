/** [COMP:api/configured-capture-authority] Source-authenticated 8296 renderer. */
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, mkdirSync, readdirSync, symlinkSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
const directory=fileURLToPath(new URL('../../../scripts/conversation-store/',import.meta.url))
const migrations=fileURLToPath(new URL('../../../migrations/',import.meta.url))
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex')
describe('[COMP:api/configured-capture-authority] configured task successor source',()=>{
 it('freezes the actual tuned 8294 predecessor and constructs a read-only 396-function proof',async()=>{
  expect(sha(readFileSync(directory+'installation-authentication-8294.mjs'))).toBe('a7edd5e1084d4261ab20c638f0c69ea6c61d5150b71c2de8fda72c09304f025e')
  const root=mkdtempSync(join(tmpdir(),'configured-task-source-'));mkdirSync(join(root,'migrations'))
  try{
   for(const name of readdirSync(migrations))if(name!=='8296_configured_task_publication.sql')symlinkSync(join(migrations,name),join(root,'migrations',name))
   const generated=join(root,'migrations','8296_configured_task_publication.sql')
   execFileSync(process.execPath,[directory+'build-configured-task-publication.mjs','--output',generated],{stdio:'pipe'})
   const head=await import(directory+'installation-authentication-8296.mjs')
   const source=await head.currentInstallationAuthenticationSource({sourceRoot:root})
   expect(head.currentFunctionCount).toBe(396)
   expect(source.sourceDigest).toBe(sha(readFileSync(generated)))
   expect(()=>head.assertAuthenticationReadOnly(source.sql)).not.toThrow()
   expect(source.sql).toContain('installation_fused_tuning_changed')
   expect(source.sql).toContain('configured_task_source_member_changed')
   expect(source.sql).toContain('configured_task_receipt_schema_changed')
   expect(source.sql).not.toMatch(/a829[04]_publication_expected_current/)
   execFileSync(process.execPath,[directory+'build-configured-task-publication.mjs','--output',generated,'--check'],{stdio:'pipe'})
  }finally{rmSync(root,{recursive:true,force:true})}
 })
 it('enrolls only four private helpers and authenticates ordinary changed functions from immutable declared sources',async()=>{
  const module=await import(directory+'configured-task-publication.mjs')
  expect(module.configuredSignatures).toHaveLength(4)
  expect(module.configuredDeclarations).toHaveLength(6)
  expect(module.configuredOrdinaryPredecessors.map((p:{signature:string})=>p.signature)).toEqual(['application_recheck_native_task_sources()','check_programmatic_publication_commit()'])
  for(const signature of module.configuredSignatures)expect(module.configuredSourceSql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC,app_user;`)
  expect(module.configuredSourceSql).toContain('configured_txid=pg_current_xact_id()')
  expect(module.configuredSourceSql).toContain('configured_backend_pid=pg_backend_pid()')
  expect(module.configuredSourceSql).toContain('public.assert_programmatic_publication_current(ep.programmatic_batch_id,run.id)')
  expect(module.configuredSourceSql).not.toContain('SET CONSTRAINTS')
 })
})
