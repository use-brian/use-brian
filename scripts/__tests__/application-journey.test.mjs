import {test} from 'node:test'
import assert from 'node:assert/strict'
import {validateOrigin,main,runNativeReference,safeStartAcknowledgement,runSourceReference} from '../application-platform/reference-operations.mjs'

test('[COMP:operations/application-journey] refuses secret-bearing/remote-cleartext targets and implicit mutation',async()=>{
  for(const value of ['http://api.example','https://user:password@api.example','https://api.example/path','https://api.example/?token=secret','https://api.example/#secret'])assert.throws(()=>validateOrigin(value))
  assert.equal(validateOrigin('http://127.0.0.1:3000'),'http://127.0.0.1:3000')
  await assert.rejects(main(['native','--api','https://api.example','--workspace','fictional'],{}),/--apply/)
})
test('[COMP:operations/application-journey] missing SDK build fails before any management mutation',async()=>{
  let writes=0
  await assert.rejects(runNativeReference({command(){writes++}},{loadSdk:async()=>{throw new Error('missing SDK build')}}),/missing SDK/)
  assert.equal(writes,0)
})

test('[COMP:operations/application-journey] start acknowledgement never forwards readable or unexpected protected values',()=>{
  const runId='00000000-0000-4000-8000-000000000001'
  assert.deepEqual(safeStartAcknowledgement({runId,accepted:true,effect:'committed',outputUnavailable:true,status:'failed',error:'private source value',steps:[{output:'private'}],finalOutput:'private'}),{runId,accepted:true,effect:'committed',outputUnavailable:true})
  assert.throws(()=>safeStartAcknowledgement({error:'private'}),/outcome may be committed/)
})
test('[COMP:operations/application-journey] failed setup revokes known bootstrap without replaying a start',async()=>{
  const calls=[]
  const api={async command(c){calls.push(c);if(c.kind==='grant.review')return{id:'review',canIssue:true};if(c.kind==='grant.apply')return{grantId:'grant'};if(c.kind==='credential.review')return{id:'key-review',canIssue:true};if(c.kind==='credential.deliver')return{credentialId:'key',secretAvailable:true,secret:'never printed'};if(c.kind==='source.binding.review')throw new Error('refused');return{}}}
  await assert.rejects(runSourceReference(api,{workspaceId:'workspace',appId:'app',serviceUserId:'service',instanceId:'instance',tenant:'tenant',audience:'https://source.example',recordId:'record',fields:['description'],profileId:'profile'}),e=>e.recovery.bootstrapCredentialId==='key'&&e.recovery.startOutcome==='not_requested')
  assert.equal(calls.filter(c=>c.kind==='credential.revoke'&&c.credentialId==='key').length,1)
})
