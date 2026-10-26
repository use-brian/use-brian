/** Standalone loopback source. Independent ACL, never Brian provider-table access. */
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { createSourceStore } from './store.mjs'
export async function createReferenceSourceServer({file,tenant,trust,transportToken,authenticateSourceUser,sdk,dispatchCommands=false}) {
 if(!transportToken||transportToken.length<24||!trust||typeof authenticateSourceUser!=='function')throw new Error('Source deployment configuration is required')
 sdk??=await import('@use-brian/brian-app/connector')
 const store=createSourceStore(file,{tenant,dispatchCommands,sdk}),verifyActor=sdk.createConnectorActorVerifier({...trust,consumeReplay:store.consumeReplay})
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.setHeader('X-Content-Type-Options','nosniff')
  let chunks=[],size=0
  try {
   for await(const chunk of req){size+=chunk.length;if(size>512*1024)throw new Error('too_large');chunks.push(chunk)}
   const request={method:req.method,target:req.url,body:Buffer.concat(chunks)},assertion=req.headers['x-usebrian-actor-assertion']
   const authenticateTransport=async()=>{const header=req.headers.authorization,actual=Buffer.from(typeof header==='string'?header:''),expected=Buffer.from('Bearer '+transportToken);return actual.length===expected.length&&timingSafeEqual(actual,expected)}
   let result
   const endpoint=/^\/usebrian\/source\/(capabilities|authorize|reconcile)$/.exec(req.url)
   if(endpoint){result=await sdk.handleSourceSidecar({endpoint:endpoint[1],request,assertion,authenticateTransport,verifyActor},{capabilities:store.capabilities,authorize:store.authorize,reconcile:store.reconcile})}
   else if(dispatchCommands&&req.method==='POST'&&req.url==='/mcp'){
    const authorized=await sdk.authorizeConnectorRequest({request,assertion,authenticateTransport,verifyActor,authorize:async actor=>({allowed:true,value:actor})})
    await store.capabilities(authorized.actor)
    const body=JSON.parse(request.body.toString('utf8'))
    if(body.method==='notifications/initialized'){res.statusCode=202;res.end();return}
    let value
    if(body.method==='initialize')value={protocolVersion:body.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'Independent durable dispatch source',version:'1'}}
    else if(body.method==='tools/list'){const catalog=await store.catalog(authorized.actor);value={tools:[{name:'readRecord',description:'Read explicitly selected source fields.',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{id:{type:'string'},fields:{type:'array',items:{type:'string'},minItems:1}},required:['id','fields'],additionalProperties:false}},{name:'dispatchRecord',description:'Enqueue selected source fields in the source outbox without changing the parent record.',annotations:{readOnlyHint:false},inputSchema:{type:'object',properties:{type:{type:'string'},id:{type:'string'},fields:{type:'array',items:{type:'string'},minItems:1},expectedVersion:{type:'string'},expectedPolicyVersion:{type:'string'},destination:{const:'source_outbox'},idempotencyKey:{type:'string'}},required:['type','id','fields','expectedVersion','expectedPolicyVersion','destination','idempotencyKey'],additionalProperties:false}}]};value.tools.push({name:'updateRecord',description:'Change selected source fields with exact content and policy versions.',annotations:{readOnlyHint:false},inputSchema:{type:'object',properties:{type:{type:'string'},id:{type:'string'},expectedVersion:{type:'string'},expectedPolicyVersion:{type:'string'},values:{type:'object',additionalProperties:{type:'string'},minProperties:1},idempotencyKey:{type:'string'}},required:['type','id','expectedVersion','expectedPolicyVersion','values','idempotencyKey'],additionalProperties:false}});value.tools=value.tools.filter(tool=>tool.name==='readRecord'?catalog.readFields.length:catalog.mutateFields.length);for(const tool of value.tools){if(tool.inputSchema.properties.fields)tool.inputSchema.properties.fields.items.enum=tool.name==='readRecord'?catalog.readFields:catalog.mutateFields;if(tool.name==='updateRecord')tool.inputSchema.properties.values={type:'object',properties:Object.fromEntries(catalog.mutateFields.map(field=>[field,{type:'string',maxLength:8192}])),additionalProperties:false,minProperties:1}}}
    else if(body.method==='tools/call'){
     const intent=body.params?._meta?.['ub.source.v1'],input=body.params?.arguments
     if(body.params?.name==='readRecord'&&intent?.intent==='read'){
      if(!input||Object.keys(input).sort().join(',')!=='fields,id')throw new Error('invalid_input')
      const read=await store.read(authorized.actor,{...input,retentionMode:'governed'})
      value={content:[{type:'text',text:JSON.stringify(read.data)}],_meta:{'ub.source.v1':read.envelope}}
     }else if(['dispatchRecord','updateRecord'].includes(body.params?.name)&&intent?.intent==='mutate'){
      if(body.params.name!==intent.authorization?.effect?.tool)throw new Error('source_access_denied')
      const receipt=await store.dispatch(authorized.actor,input,intent.authorization)
      value={content:[{type:'text',text:JSON.stringify(receipt)}]}
     }else throw new Error('source_access_denied')
    }else{result={jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'Unsupported source method'}}}
    if(value)result={jsonrpc:'2.0',id:body.id,result:value}
   }
   else if(dispatchCommands&&req.method==='POST'&&req.url==='/http/read'){
    const authorized=await sdk.authorizeConnectorRequest({request,assertion,authenticateTransport,verifyActor,authorize:async actor=>({allowed:true,value:actor})})
    const body=JSON.parse(request.body.toString('utf8'));if(!body||Object.keys(body).sort().join(',')!=='fields,id')throw new Error('invalid_input')
    result=await store.read(authorized.actor,{...body,retentionMode:'governed'})
   }
   else if(req.method==='POST'&&['/records/read','/records/command'].includes(req.url)){
    const authorized=await sdk.authorizeConnectorRequest({request,assertion,authenticateTransport,verifyActor,authorize:async actor=>({allowed:true,value:actor})})
    const body=JSON.parse(request.body.toString('utf8'))
    if(req.url==='/records/read'){
     if(!body||Object.keys(body).sort().join(',')!=='fields,id,retentionMode,type'||!['governed','released_snapshot','ephemeral'].includes(body.retentionMode))throw new Error('invalid_input')
     result=await store.read(authorized.actor,body)
    }else{if(!body||Object.keys(body).sort().join(',')!=='idempotencyKey,input'||typeof body.idempotencyKey!=='string'||!body.idempotencyKey||body.idempotencyKey.length>128)throw new Error('invalid_input');result=await store.command(authorized.actor,body.idempotencyKey,body.input)}
   }else if(req.method==='POST'&&req.url==='/ui/records/read'){
    const user=await authenticateSourceUser(req);if(!user?.accountId)throw new Error('authentication_required')
    const body=JSON.parse(request.body.toString('utf8'));result=await store.readForAccount(user.accountId,body)
   }else{res.statusCode=404;res.end('{"error":"not_found"}');return}
   res.end(JSON.stringify(result))
  }catch(error){res.statusCode=['source_access_denied','transport_unauthorized'].includes(error?.code)?403:503;res.end(JSON.stringify({error:res.statusCode===403?'source_access_denied':'source_unavailable'}))}
  finally{chunks=[]}
 })
 server.requestTimeout=5000;server.headersTimeout=5000
 return{server,store,async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});return 'http://127.0.0.1:'+server.address().port},async close(){server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve))}}
}
