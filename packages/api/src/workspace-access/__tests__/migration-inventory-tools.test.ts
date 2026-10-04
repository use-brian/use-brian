import {readFileSync} from 'node:fs'
import {expect,it,vi} from 'vitest'
import type {ToolContext} from '@use-brian/core'
import {createWorkspaceMigrationTools} from '../migration-tools.js'
import {migrationInventoryInput} from '../migration-inventory.js'
const mocks=vi.hoisted(()=>({inspectMigrationInventory:vi.fn(),getMigrationInventory:vi.fn()}))
vi.mock('../migration-inventory.js',async original=>({...await original<typeof import('../migration-inventory.js')>(),...mocks}))
it('uses verified human for metadata browsing or explicit bounded reconciliation, with closed inputs',async()=>{
  const [tool]=createWorkspaceMigrationTools(),id='10000000-0000-4000-8000-000000000001'
  const context={userId:'billing',workspaceId:'workspace',workspaceActorUserId:'verified'} as ToolContext
  await tool.execute({planId:id,inventory:{family:'sessions'}},context)
  expect(mocks.getMigrationInventory).toHaveBeenCalledWith('workspace','verified',id,{family:'sessions'})
  await tool.execute({planId:id,inventory:{family:'sessions',reconcile:true}},context)
  expect(mocks.inspectMigrationInventory).toHaveBeenCalledWith('workspace','verified',id,{family:'sessions'})
  expect(await tool.execute({planId:id,inventory:{family:'sessions'}},{...context,workspaceActorUserId:undefined})).toMatchObject({isError:true})
  for(const inventory of [{family:'sessions',actorUserId:id},{family:'sessions; SELECT *'},{family:'credentials'}])expect(tool.inputSchema.safeParse({planId:id,inventory}).success).toBe(false)
  expect(tool.inputSchema.safeParse({inventory:{family:'sessions'}}).success).toBe(false)
  expect(migrationInventoryInput.safeParse({family:'sessions',after:id}).success).toBe(false)
})
it('fixed adapters never read whole source rows, credentials, token hashes, instructions or bodies',()=>{
  const source=readFileSync(new URL('../migration-inventory.ts',import.meta.url),'utf8')
  expect(source).not.toMatch(/to_jsonb\(r\)|read_scope_(review_)?source|r\.(credentials|token|token_hash|key_hash|key_prefix|instructions|config|definition|frozen_plan|compact_summary|system_prompt|content|body)\b/)
  // Events are read only through explicit metadata paths; never whole event objects.
  expect(source).not.toMatch(/jsonb_array_elements\(r\.events\)|r\.proof\s*(?:AS|,)|r\.proof->'snapshot'/)
  expect(source).toContain("CASE WHEN r.principal_type IN('user','group','workspace','published') THEN r.principal_ref ELSE NULL END")
})
