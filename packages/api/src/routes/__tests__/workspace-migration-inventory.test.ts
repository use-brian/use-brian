import express from 'express'
import request from 'supertest'
import {expect,it,vi} from 'vitest'
import {workspaceAccessRoutes} from '../workspace-access.js'
import {WorkspaceAccessError} from '../../workspace-access/policy.js'
const mocks=vi.hoisted(()=>({inspectMigrationInventory:vi.fn(),getMigrationInventory:vi.fn()}))
vi.mock('../../workspace-access/migration-inventory.js',()=>mocks)
const w='10000000-0000-4000-8000-000000000001',p='20000000-0000-4000-8000-000000000002'
const path=`/workspaces/${w}/access/migrations/${p}/inventory`
function app(user='verified'){const a=express();a.use(express.json());a.use((req,_res,next)=>{req.userId=user;next()});a.use(workspaceAccessRoutes());return a}
it('binds inventory reads/reconciliation to authenticated actor; no-store and canonical errors',async()=>{
  mocks.getMigrationInventory.mockResolvedValue({inventoryComplete:false})
  mocks.inspectMigrationInventory.mockResolvedValue({quiet:false})
  const response=await request(app()).get(path+'?family=sessions&after=cursor')
  expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('no-store')
  expect(mocks.getMigrationInventory).toHaveBeenCalledWith(w,'verified',p,{family:'sessions',after:'cursor'})
  expect((await request(app()).post(path).send({family:'sessions'})).status).toBe(200)
  expect(mocks.inspectMigrationInventory).toHaveBeenCalledWith(w,'verified',p,{family:'sessions'})
  mocks.inspectMigrationInventory.mockRejectedValueOnce(new WorkspaceAccessError('migration_not_active',409))
  expect((await request(app()).post(path).send({family:'sessions'})).body).toEqual({error:'migration_not_active'})
  expect((await request(app('')).get(path)).status).toBe(401)
  expect((await request(app()).post(path.replace(p,'bad')).send({family:'sessions'})).status).toBe(404)
})
