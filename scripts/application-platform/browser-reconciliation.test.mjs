/** Actual committed mutation with lost acknowledgement and explicit current reconcile. [COMP:examples/application-references] */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {referenceCopy,referenceLocales} from '../../examples/application-platform/shared/browser-copy.mjs'
const runId=process.argv[2];assert.match(runId??'',/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/)
const folder=resolve('output/application-platform',runId),config=JSON.parse(readFileSync(join(folder,'operations-browser-inputs.json'),'utf8'))
for(const key of ['appId','workspaceId','companyId'])assert.match(config[key],/^[0-9a-f]{8}-[0-9a-f-]{27}$/i)
assert.ok(Number.isInteger(config.fixturePgPort)&&config.fixturePgPort>=1024&&config.fixturePgPort<=65535)
assert.equal(config.nativeSessionPath,'.rig/admin-'+config.fixturePgPort+'/session.json')
const command=(...args)=>execFileSync('agent-browser',['--config',join(folder,'browser-config.json'),'--session','renewed-reconciliation',...args],{encoding:'utf8',timeout:20000})
const evaluate=source=>{const result=JSON.parse(command('--json','eval',source));assert.equal(result.success,true);return JSON.parse(result.data.result)}
const state=()=>evaluate('JSON.stringify({status:document.getElementById("status")?.textContent??"",statusKey:document.getElementById("status")?.dataset.status,text:document.getElementById("data")?.textContent??"",signedIn:document.getElementById("signout")?!document.getElementById("signout").disabled:false,probe:window.__reconciliationProbe?{calls:window.__reconciliationProbe.calls,responseStatus:window.__reconciliationProbe.responseStatus,reconcileCalls:window.__reconciliationProbe.reconcileCalls,matchingOriginal:window.__reconciliationProbe.matchingOriginal,idempotencyKey:window.__reconciliationProbe.idempotencyKey,recordId:window.__reconciliationProbe.recordId,lineIds:window.__reconciliationProbe.lineIds}:null})')
async function until(predicate){const end=Date.now()+15000;let value;do{value=state();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,200))}while(Date.now()<end);throw Error('Expected current reconciliation UI state unavailable: '+JSON.stringify(value))}
const artifacts=join(folder,'browser-artifacts');mkdirSync(artifacts,{recursive:true})
test('[COMP:examples/application-references] actual phone operation commits once before acknowledgement loss and checks its unchanged command receipt without retry',async()=>{
 command('open','http://localhost:3003/api/auth/local-session');command('open','http://localhost:4188/operations/index.html');command('set','viewport','360','844')
 // Install the loss boundary before the client captures fetch. Actual server dispatch/auth/RLS are unchanged.
 evaluate(`JSON.stringify((()=>{const original=window.fetch.bind(window),probe=window.__reconciliationProbe={calls:0,reconcileCalls:0};window.fetch=async(input,init)=>{const path=new URL(typeof input==='string'?input:input.url??String(input),location.href).pathname;if(init?.method==='POST'&&path==='/api/applications/${config.appId}/commands/create_request'){probe.calls++;const envelope=JSON.parse(init.body);probe.original=JSON.stringify(envelope);probe.idempotencyKey=envelope.idempotencyKey;probe.recordId=envelope.input.id;probe.lineIds=envelope.input.lines.map(line=>line.id);const response=await original(input,init);probe.responseStatus=response.status;if(response.ok&&probe.calls===1)throw new TypeError('Fictional lost acknowledgement after actual server response');return response}if(init?.method==='POST'&&path==='/api/applications/${config.appId}/commands/create_request/reconcile'){probe.reconcileCalls++;probe.matchingOriginal=JSON.stringify(JSON.parse(init.body))===probe.original}return original(input,init)};return true})())`)
 const applicationTab=JSON.parse(command('--json','tab','list')).data.tabs.find(tab=>{const url=new URL(tab.url);return url.origin==='http://localhost:4188'&&url.pathname==='/operations/index.html'});assert.ok(applicationTab,'Current exact static application tab required')
 for(const key of ['apiOrigin','appId','workspaceId','clientId','type'])command('fill',`input[name="${key}"]`,config[key])
 command('click','#configuration button');let allow;const consentDeadline=Date.now()+15000;do{allow=/button "Allow" \[ref=(e\d+)\]/.exec(command('snapshot','-i'))?.[1];if(!allow)await new Promise(resolve=>setTimeout(resolve,200))}while(!allow&&Date.now()<consentDeadline);assert.ok(allow,'Complete current native owner consent without injecting a bearer');command('click','@'+allow)
 command('tab',applicationTab.id??applicationTab.tabId)
 await until(value=>value.signedIn&&value.statusKey==='signedIn')
 const title='Fictional reconciled purchase '+randomUUID().slice(0,8)
 for(const[name,value]of Object.entries({title,companyId:config.companyId,budget:'10.00',lineTitle:'Fictional reconciliation line',quantity:'2',unitCost:'0.10'}))command('fill',`#purchase [name="${name}"]`,value)
 command('scrollintoview','#purchase button');command('click','#purchase button');const uncertain=await until(value=>value.statusKey==='uncertain')
 assert.equal(uncertain.probe.responseStatus,200);assert.equal(uncertain.probe.calls,1);assert.equal(uncertain.text,'')
 for(const locale of referenceLocales){
  command('click',`#languages [data-locale="${locale}"]`);assert.equal(state().status,referenceCopy[locale].uncertain);assert.equal(state().probe.calls,1)
  assert.deepEqual(evaluate('JSON.stringify(Object.fromEntries(new FormData(document.getElementById("purchase"))))'),{title,companyId:config.companyId,budget:'10.00',lineTitle:'Fictional reconciliation line',quantity:'2',unitCost:'0.10'})
  command('screenshot',join(artifacts,'operations-uncertain-'+locale+'-phone.png'),'--full')
 }
 for(const locale of referenceLocales){
  command('click',`#languages [data-locale="${locale}"]`);command('click','#purchase button');assert.equal(state().status,referenceCopy[locale].pendingUncertain);assert.equal(state().probe.calls,1,'Uncertain UI cannot dispatch another mutation')
 }
 const copy=referenceCopy['zh-CN']
 command('scrollintoview','#reconcile');command('click','#reconcile');const confirmed=await until(value=>value.status===copy.confirmed&&value.statusKey==='confirmed')
 assert.equal(confirmed.probe.calls,1);assert.equal(confirmed.probe.reconcileCalls,1);assert.equal(confirmed.probe.matchingOriginal,true)
 command('click','#refresh');const final=await until(value=>value.status===copy.current&&value.statusKey==='current'&&value.text.includes(title));assert.equal(final.probe.calls,1)
 const ids=[final.probe.idempotencyKey,final.probe.recordId,...final.probe.lineIds];for(const id of ids)assert.match(id,/^[0-9a-f]{8}-[0-9a-f-]{27}$/i)
 const query=`WITH r AS(SELECT id FROM application_operation_receipts WHERE application_client_id='${config.appId}'::uuid AND idempotency_key='${final.probe.idempotencyKey}') SELECT json_build_object('receipts',(SELECT count(*) FROM r),'audits',(SELECT count(*) FROM application_command_audit WHERE receipt_id IN(SELECT id FROM r)),'events',(SELECT count(*) FROM application_committed_events WHERE receipt_id IN(SELECT id FROM r)),'records',(SELECT count(*) FROM entity_instances WHERE id IN('${final.probe.recordId}'::uuid,${final.probe.lineIds.map(id=>"'"+id+"'::uuid").join(',')})))`
 const counts=JSON.parse(execFileSync('docker',['exec','usebrian-admin-test-'+config.fixturePgPort,'psql','-U','brian','-d','usebrian_admin_test','-tA','-c',query],{encoding:'utf8',timeout:10000}));assert.deepEqual(counts,{receipts:1,audits:1,events:1,records:2})
 const geometry=evaluate('JSON.stringify({overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll("button")].filter(x=>x.offsetParent!==null).map(x=>x.getBoundingClientRect().height)})');assert.equal(geometry.overflow,false);assert.ok(geometry.buttons.every(height=>height>=44))
 command('screenshot',join(artifacts,'operations-reconciled-phone.png'),'--full');writeFileSync(join(artifacts,'operations-reconciled-phone.json'),JSON.stringify({observed:final,counts,geometry,acknowledgementLoss:'after actual200 before SDKreceivedresponse; realauth/source/RLS unchanged'},null,2)+'\n')
})
