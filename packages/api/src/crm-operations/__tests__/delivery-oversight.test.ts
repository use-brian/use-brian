import { describe, expect, it, vi } from 'vitest'
import { createCrmOperationsService } from '../service.js'
import type { CrmOperationsContext, CrmOperationsCommand } from '@use-brian/core'
const id='11111111-1111-4111-8111-111111111111'
const context:CrmOperationsContext={workspaceId:id,actor:{kind:'user',userId:id},authority:{role:'member',canWrite:false,canConfigure:false,trustedIdentitySources:[]}}
describe('[COMP:api/crm-delivery-oversight] canonical command admission',()=>{
 it('CO07 read-only input cannot open a transaction or invoke prohibited writers',async()=>{
  const transaction=vi.fn(), deliveries={send:vi.fn()}
  const service=createCrmOperationsService({transaction},{deliveries:deliveries as never})
  await expect(service.execute(context,{kind:'refresh_delivery_assessment',operationId:id,commitmentId:id,expectedVersion:1})).rejects.toMatchObject({code:'not_authorized'})
  expect(transaction).not.toHaveBeenCalled();expect(deliveries.send).not.toHaveBeenCalled()
 })
 it('CO07 transport actor spoofing and command execution fields fail before storage',async()=>{
  const transaction=vi.fn(),service=createCrmOperationsService({transaction})
  await expect(service.execute({...context,authority:{...context.authority,canWrite:true}}, {kind:'refresh_delivery_assessment',operationId:id,commitmentId:id,expectedVersion:1,actor:{kind:'user',userId:id},send:true} as unknown as CrmOperationsCommand)).rejects.toThrow()
  expect(transaction).not.toHaveBeenCalled()
 })
})
