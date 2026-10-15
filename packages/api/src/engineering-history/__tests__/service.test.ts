import {describe,it,expect} from 'vitest'
import {archiveDigest} from '../../db/engineering-history-store.js'
import {createProgrammaticCaptureRouter} from '../../ingest/programmatic-capture.js'
describe('[COMP:api/engineering-history] archive event contract',()=>{
 it('does not normalize whitespace and canonicalizes metadata key order for identity',()=>{
  expect(archiveDigest({content:' \n'})).not.toBe(archiveDigest({content:'\n'}))
  expect(archiveDigest({content:'x',metadata:{a:1,b:2}})).toBe(archiveDigest({content:'x',metadata:{b:2,a:1}}))
 })
 it('requires native configuration without reaching any fallback',async()=>{
  let calls=0
  const capture=createProgrammaticCaptureRouter({store:{resolveTargetSystem:async()=>null} as never,ingest:async()=>{calls++;return {} as never}})
  await expect(capture({workspaceId:'w'} as never,{eventId:'e',content:'text'})).rejects.toThrow('not configured')
  expect(calls).toBe(0)
 })
})
