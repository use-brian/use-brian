import {describe,it,expect} from 'vitest'
import {EngineeringCaptureReceiptSchema,EngineeringHistoryCommandSchema,CaptureConfigurationSchema} from '../engineering-history.js'
describe('[COMP:shared/engineering-history] archive wire protocol',()=>{
 it('rejects legacy prose, unknown contracts and extraction acknowledgements',()=>{
  expect(EngineeringCaptureReceiptSchema.safeParse('success')).toMatchObject({success:false})
  const receipt={contractVersion:1,processingPurpose:'archive_only',outcome:'duplicate',receiptStatus:'queued',deliveryStatus:'pending',indexStatus:'pending'}
  expect(EngineeringCaptureReceiptSchema.safeParse(receipt).success).toBe(true)
  expect(EngineeringCaptureReceiptSchema.safeParse({...receipt,contractVersion:2}).success).toBe(false)
  expect(EngineeringCaptureReceiptSchema.safeParse({...receipt,processingPurpose:'extract'}).success).toBe(false)
 })
 it('keeps local emitter observation separate from server configuration',()=>{
  const config={connectionId:'fixture-connection',contractVersion:1,receiptContractVersion:1,processingPurpose:null,ready:false,permittedEventKinds:[],audience:[],limits:{maxEventBytes:1,maxExportEvents:1},localEmitterObserved:false}
  expect(CaptureConfigurationSchema.safeParse(config).success).toBe(true)
  expect(CaptureConfigurationSchema.safeParse({...config,localEmitterObserved:true}).success).toBe(false)
 })
 it('rejects unknown history actions and unbounded queries',()=>{
  expect(EngineeringHistoryCommandSchema.safeParse({action:'launch'}).success).toBe(false)
  expect(EngineeringHistoryCommandSchema.safeParse({action:'search',query:{limit:1000}}).success).toBe(false)
 })
})
