/** Actual verified nonmember portal observation. [COMP:examples/application-references] */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {referenceCopy,referenceLocales} from '../../examples/application-platform/shared/browser-copy.mjs'
const runId=process.argv[2];assert.match(runId??'',/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/)
const folder=resolve('output/application-platform',runId),config=JSON.parse(readFileSync(join(folder,'portal-browser-inputs.json'),'utf8'));assert.match(config.session,/^[a-zA-Z0-9_-]+$/);assert.ok(Number.isInteger(config.fixturePort)&&config.fixturePort>=1024&&config.fixturePort<=65535);for(const key of ['userId','workspaceId','appId','grantId'])assert.match(config[key],/^[0-9a-f]{8}-[0-9a-f-]{27}$/i)
const command=(...args)=>execFileSync('agent-browser',['--config',join(folder,'browser-config.json'),'--session',config.session,...args],{encoding:'utf8',timeout:20000,env:{...process.env,AGENT_BROWSER_IDLE_TIMEOUT_MS:'300000'}})
const evaluate=source=>{const result=JSON.parse(command('--json','eval',source));assert.equal(result.success,true);return JSON.parse(result.data.result)}
const state=()=>evaluate('JSON.stringify({status:document.getElementById("status")?.textContent,statusKey:document.getElementById("status")?.dataset.status,text:document.getElementById("data")?.textContent,signedIn:!document.getElementById("signout")?.disabled,records:[...document.querySelectorAll("#data article strong")].map(x=>x.textContent)})')
async function until(predicate){const end=Date.now()+15000;let value;do{value=state();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,250))}while(Date.now()<end);throw Error('Expected current portal UI state unavailable: '+JSON.stringify(value))}
const artifacts=join(folder,'browser-artifacts');mkdirSync(artifacts,{recursive:true})
test('[COMP:examples/application-references] genuine verified nonmember portal admits only granted customer fields at desktop and phone then clears after current revoke',async()=>{
 assert.equal(state().signedIn,true,'Complete a current genuine customer PKCE exchange before portal reads')
 const membership=execFileSync('docker',['exec','usebrian-admin-test-'+config.fixturePort,'psql','-U','brian','-d','usebrian_admin_test','-tA','-c',`SELECT count(*) FROM workspace_members WHERE user_id='${config.userId}'::uuid`],{encoding:'utf8',timeout:10000});assert.equal(membership.trim(),'0')
 for(const locale of referenceLocales){
 command('click',`#languages [data-locale="${locale}"]`);assert.equal(state().signedIn,true,'Language change preserves the genuine customer session')
 const copy=referenceCopy[locale];assert.deepEqual(evaluate('JSON.stringify({lang:document.documentElement.lang,title:document.title,heading:document.querySelector("h1").textContent})'),{lang:locale,title:copy.portal,heading:copy.portal})
 for(const viewport of ['desktop','phone']){
  command('set','viewport',viewport==='phone'?'360':'1280',viewport==='phone'?'844':'900');command('click','#refresh')
  const observed=await until(value=>value.status===copy.current&&value.statusKey==='current');assert.deepEqual(observed.records,[config.ownId]);assert.ok(observed.text.includes('Fictional permitted customer request'));assert.ok(!observed.text.includes(config.foreignId));assert.ok(!observed.text.includes('Fictional different customer request'));assert.ok(!observed.text.includes('fictional-private-cost-519'));assert.ok(!observed.text.includes('privateCost'))
  const geometry=evaluate('JSON.stringify({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll("button")].filter(x=>x.offsetParent!==null).map(x=>x.getBoundingClientRect().height)})');assert.equal(geometry.overflow,false);if(viewport==='phone')assert.ok(geometry.buttons.every(height=>height>=44))
  command('screenshot',join(artifacts,'portal-'+locale+'-'+viewport+'.png'),'--full');writeFileSync(join(artifacts,'portal-'+locale+'-'+viewport+'.json'),JSON.stringify({locale,viewport,geometry,observed,verifiedUserId:config.userId,member:false},null,2)+'\n')
 }
 }
 const session=JSON.parse(readFileSync('.rig/admin-'+config.fixturePort+'/session.json','utf8'));assert.notEqual(session.user.id,config.userId)
 const response=await fetch(config.apiOrigin+'/api/applications/workspaces/'+config.workspaceId+'/management/commands',{method:'POST',headers:{Authorization:'Bearer '+session.accessToken,Origin:'http://localhost:3003','Content-Type':'application/json'},body:JSON.stringify({kind:'grant.revoke',appId:config.appId,grantId:config.grantId}),signal:AbortSignal.timeout(10000)});assert.equal(response.status,200)
 for(const locale of referenceLocales){
 command('click',`#languages [data-locale="${locale}"]`);command('click','#refresh');const denied=await until(value=>value.status===referenceCopy[locale].unavailable&&value.statusKey==='unavailable')
 assert.equal(denied.text,'');assert.deepEqual(denied.records,[])
 command('set','offline','on');assert.equal(state().text,'');assert.equal(state().status,referenceCopy[locale].offline);command('set','offline','off');assert.equal(state().status,referenceCopy[locale].online);command('click','#refresh');await until(value=>value.statusKey==='unavailable');assert.equal(state().text,'')
 command('screenshot',join(artifacts,'portal-revoked-'+locale+'-phone.png'),'--full')
 }
})
