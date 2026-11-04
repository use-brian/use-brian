import {afterEach,describe,expect,it,vi} from 'vitest'
import {createOrganizationUpgradeWorker} from '../organization-upgrade-worker.js'

vi.mock('../../db/client.js',()=>({getPool:vi.fn()}))
vi.mock('../organization-cutover.js',()=>({completeOrganizationUpgrade:vi.fn()}))
import {getPool} from '../../db/client.js'
import {completeOrganizationUpgrade} from '../organization-cutover.js'
import {runOrganizationUpgrades} from '../organization-upgrade-worker.js'

afterEach(()=>{vi.useRealTimers();vi.clearAllMocks()})
describe('[COMP:api/organization-upgrade-worker] automatic maintenance lifecycle',()=>{
 it('runs without a user request, avoids overlapping ticks and drains on shutdown',async()=>{
  vi.useFakeTimers()
  let finish!:()=>void
  const run=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve}))
  const worker=createOrganizationUpgradeWorker({run,intervalMs:1000})
  worker.start();worker.start()
  await vi.advanceTimersByTimeAsync(5000)
  expect(run).toHaveBeenCalledTimes(1)
  let stopped=false
  const shutdown=worker.stop().then(()=>{stopped=true})
  await Promise.resolve();expect(stopped).toBe(false)
  finish();await shutdown
  await vi.advanceTimersByTimeAsync(5000)
  expect(run).toHaveBeenCalledTimes(1)
 })
 it('retries a failed tick automatically',async()=>{
  vi.useFakeTimers()
  const run=vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(undefined)
  const onError=vi.fn(),worker=createOrganizationUpgradeWorker({run,onError,intervalMs:1000})
  worker.start();await vi.advanceTimersByTimeAsync(1000)
  expect(onError).toHaveBeenCalledTimes(1);expect(run).toHaveBeenCalledTimes(2)
  await worker.stop()
 })
 it('continues other workspaces after a blocker and persists retry diagnostics separately from completion',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[]})
  query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{workspace_id:'one',attempts:0},{workspace_id:'two',attempts:2}]})
  vi.mocked(getPool).mockReturnValue({query} as never)
  vi.mocked(completeOrganizationUpgrade).mockResolvedValueOnce({status:'blocked',blockers:[{code:'readiness_scope_review'}]})
   .mockResolvedValueOnce({status:'already_ready',receiptId:'receipt'})
  await runOrganizationUpgrades()
  expect(completeOrganizationUpgrade).toHaveBeenNthCalledWith(1,'one')
  expect(completeOrganizationUpgrade).toHaveBeenNthCalledWith(2,'two')
  expect(query.mock.calls[2][1]).toEqual(['one','blocked','[{"code":"readiness_scope_review"}]',60000])
  expect(query.mock.calls[3][1]).toEqual(['two','completed','[]',240000])
 })
})
