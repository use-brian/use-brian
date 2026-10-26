/** Actual maintained-rig UI, no auth injection. [COMP:examples/application-references] */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {referenceCopy,referenceLocales} from '../../examples/application-platform/shared/browser-copy.mjs'
const runId=process.argv[2],viewport=process.argv[3]
assert.match(runId??'',/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);assert.ok(['desktop','phone'].includes(viewport))
const folder=resolve('output/application-platform',runId),config=JSON.parse(readFileSync(join(folder,'operations-browser-inputs.json'),'utf8'))
assert.match(config.session,/^[a-zA-Z0-9_-]+$/)
assert.match(config.nativeSessionPath,/^\.rig\/admin-\d+\/session\.json$/)
const command=(...args)=>execFileSync('agent-browser',['--config',join(folder,'browser-config.json'),'--session',config.session,...args],{encoding:'utf8',timeout:20000,env:{...process.env,AGENT_BROWSER_IDLE_TIMEOUT_MS:'300000'}})
const evaluate=source=>{const result=JSON.parse(command('--json','eval',source));assert.equal(result.success,true);return JSON.parse(result.data.result)}
const state=()=>evaluate('JSON.stringify({status:document.getElementById("status")?.textContent,statusKey:document.getElementById("status")?.dataset.status,text:document.getElementById("data")?.textContent,signedIn:!document.getElementById("signout")?.disabled})')
async function until(predicate){const deadline=Date.now()+20000;let value;do{value=state();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,250))}while(Date.now()<deadline);throw new Error('Expected current UI state unavailable: '+JSON.stringify(value))}
const artifacts=join(folder,'browser-artifacts');mkdirSync(artifacts,{recursive:true})
test(`[COMP:examples/application-references] ${viewport} actual member purchase create submit approve and canonical company readback`,async()=>{
 command('set','viewport',viewport==='phone'?'360':'1280',viewport==='phone'?'844':'900')
 assert.equal(state().signedIn,true,'Complete genuine application PKCE consent first')
 for(const locale of referenceLocales){
 command('click',`#languages [data-locale="${locale}"]`)
 assert.equal(state().signedIn,true,'Language change preserves the genuine session')
 const copy=referenceCopy[locale]
 const shell=evaluate('JSON.stringify({lang:document.documentElement.lang,title:document.title,heading:document.querySelector("h1").textContent,create:document.querySelector("#purchase button").textContent})')
 assert.deepEqual(shell,{lang:locale,title:copy.operations,heading:copy.operations,create:copy.create})
 const title='Fictional browser purchase '+randomUUID().slice(0,8)
 for(const [name,value]of Object.entries({title,companyId:config.companyId,budget:'10.00',lineTitle:'Fictional exact decimal line',quantity:'2',unitCost:'0.10'}))command('fill',`#purchase [name="${name}"]`,value)
 command('scrollintoview','#purchase button');command('click','#purchase button');await until(value=>value.statusKey==='saved');command('click','#refresh');await until(value=>value.text.includes(title)&&value.text.includes(copy.draft))
 const clickAction=label=>evaluate(`JSON.stringify((()=>{const row=[...document.querySelectorAll('#data article')].find(row=>row.textContent.includes(${JSON.stringify(title)}));const button=[...row.querySelectorAll('button')].find(button=>button.dataset.action===${JSON.stringify(label)});if(!button)throw new Error('Expected current semantic control missing');button.click();return true})())`)
 clickAction('submit_request');await until(value=>value.statusKey==='saved');command('click','#refresh');await until(value=>value.text.includes(title)&&value.text.includes(copy.submitted))
 clickAction('approve_order');await until(value=>value.statusKey==='saved');command('click','#refresh');const final=await until(value=>value.text.includes(title)&&value.text.includes(copy.ordered))
 assert.ok(final.text.includes(config.companyId));assert.ok(final.text.includes('10.00'))
 const requestId=evaluate(`JSON.stringify([...document.querySelectorAll('#data article')].find(row=>row.textContent.includes(${JSON.stringify(title)})).querySelector('strong').textContent)`)
 assert.match(requestId,/^[0-9a-f]{8}-[0-9a-f-]{27}$/i)
 // Brian's registered typed query reads the exact browser-created record on the same normal backend.
 // This supported native session stays in this trusted Node process and never enters browser state.
 const native=JSON.parse(readFileSync(config.nativeSessionPath,'utf8'))
 const response=await fetch(config.apiOrigin+'/api/applications/workspaces/'+config.workspaceId+'/modules/mcp?moduleKey=purchasing',{method:'POST',headers:{Authorization:'Bearer '+native.accessToken,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'nativeModuleQuery',arguments:{queryKey:'get',input:{type:config.type,id:requestId}}}}),signal:AbortSignal.timeout(15000)})
 assert.equal(response.status,200)
 const body=await response.text(),line=body.split('\n').find(value=>value.startsWith('data: ')),rpc=JSON.parse(line?line.slice(6):body)
 assert.equal(rpc.error,undefined);assert.notEqual(rpc.result?.isError,true)
 const brian=JSON.parse(rpc.result.content[0].text)
 assert.equal(brian.ref.id,requestId);assert.equal(brian.values.company.value,config.companyId);assert.equal(brian.values.state.value,'ordered');assert.equal(brian.values.total.value,'0.2')

 const geometry=evaluate('JSON.stringify({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll("button")].filter(x=>x.offsetParent!==null).map(x=>x.getBoundingClientRect().height)})')
 assert.equal(geometry.overflow,false);if(viewport==='phone')assert.ok(geometry.buttons.every(height=>height>=44))
 command('screenshot',join(artifacts,'operations-'+locale+'-'+viewport+'.png'),'--full')
 writeFileSync(join(artifacts,'operations-'+locale+'-'+viewport+'.json'),JSON.stringify({locale,viewport,title,requestId,companyId:config.companyId,geometry,observed:final,brianReadback:brian},null,2)+'\n')
 }
})
