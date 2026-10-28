/** Actual native phone registration and saved-review cancellation. [COMP:app-web/application-admin] */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
const runId=process.argv[2];assert.match(runId??'',/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/)
const folder=resolve('output/application-platform',runId),config=JSON.parse(readFileSync(join(folder,'operations-browser-inputs.json'),'utf8'));assert.match(config.workspaceId,/^[0-9a-f]{8}-[0-9a-f-]{27}$/i)
const command=(...args)=>execFileSync('agent-browser',['--config',join(folder,'browser-config.json'),'--session','renewed-management-review',...args],{encoding:'utf8',timeout:20000})
const evaluate=source=>{const result=JSON.parse(command('--json','eval',source));assert.equal(result.success,true);return JSON.parse(result.data.result)}
const state=()=>evaluate('JSON.stringify({text:document.querySelector("section[aria-label=\\"Application management\\"]")?.textContent??"",dialog:document.querySelector("[role=alertdialog]")?.textContent??"",kinds:window.__managementProbe?.kinds??[],responses:window.__managementProbe?.responses??[],reads:window.__managementProbe?.reads??0,options:[...document.querySelectorAll("[role=option]")].map(x=>x.textContent??"")})')
async function until(predicate){const end=Date.now()+15000;let value;do{value=state();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,200))}while(Date.now()<end);throw Error('Expected current management UI state unavailable: '+JSON.stringify(value))}
const click=text=>evaluate(`JSON.stringify((()=>{const button=[...document.querySelectorAll('section[aria-label="Application management"] button')].find(x=>x.textContent===${JSON.stringify(text)});if(!button)throw Error('Current review control unavailable');button.click();return true})())`)
const artifacts=join(folder,'browser-artifacts');mkdirSync(artifacts,{recursive:true})
test('[COMP:app-web/application-admin] actual phone native registration saves through canonical management and cancels the exact saved activation confirmation',async()=>{
 command('open','http://localhost:3003/api/auth/local-session');evaluate("JSON.stringify(document.cookie='locale=en; path=/; SameSite=Lax')");command('set','viewport','360','844');command('open','http://localhost:3003/w/'+config.workspaceId+'/studio/programmatic-access/applications')
 await until(value=>value.text.includes('Register application')&&value.text.includes('Review activation'))
 evaluate(`JSON.stringify((()=>{const original=window.fetch.bind(window),probe=window.__managementProbe={kinds:[],responses:[],reads:0};window.fetch=async(input,init)=>{const path=new URL(typeof input==='string'?input:input.url??String(input),location.href).pathname;const kind=init?.method==='POST'&&path.endsWith('/management/commands')?JSON.parse(init.body).kind:null;if(kind)probe.kinds.push(kind);const response=await original(input,init);if(kind)probe.responses.push({kind,status:response.status});if(!init?.method&&path.endsWith('/management')&&response.ok)probe.reads++;return response};return true})())`)
 const name='Fictional native phone app '+randomUUID().slice(0,8),section='section[aria-label="Application management"]'
 command('fill',section+' input[name="name"]',name);command('fill',section+' textarea[name="origins"]','http://localhost:4188');command('fill',section+' textarea[name="redirects"]','http://localhost:4188/operations/index.html');command('scrollintoview',section+' form:first-of-type button[type=submit]');command('click',section+' form:first-of-type button[type=submit]')
 const saved=await until(value=>value.responses.some(item=>item.kind==='register'&&item.status===200)&&value.text.includes(name)&&value.text.includes('Operation receipt'));assert.ok(saved.kinds.includes('register'));click('Close');await until(value=>value.reads>0&&value.text.includes('Register application'));command('click',section+' [role=combobox][aria-label=Application]');await until(value=>value.options.some(option=>option.includes(name)));command('press','Escape')
 click('Review activation');await until(value=>value.text.includes('Confirm this exact saved review')&&value.text.includes('Apply reviewed change'))
 click('Apply reviewed change');const dialog=await until(value=>value.dialog.includes('Confirm this exact saved review'));assert.ok(dialog.dialog.includes('Cancel'))
 evaluate(`JSON.stringify((()=>{const button=[...document.querySelectorAll('[role=alertdialog] button')].find(x=>x.textContent==='Cancel');if(!button)throw Error('Current native cancel unavailable');button.click();return true})())`)
 const cancelled=await until(value=>value.dialog==='');assert.ok(cancelled.kinds.includes('activation.review'));assert.equal(cancelled.kinds.includes('activation.apply'),false)
 const geometry=evaluate('JSON.stringify({overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll("section[aria-label=\\"Application management\\"] button")].filter(x=>x.offsetParent!==null).map(x=>x.getBoundingClientRect().height)})');assert.equal(geometry.overflow,false);assert.ok(geometry.buttons.length&&geometry.buttons.every(height=>height>=44))
 command('screenshot',join(artifacts,'management-review-cancelled-phone.png'),'--full');writeFileSync(join(artifacts,'management-review-cancelled-phone.json'),JSON.stringify({observed:cancelled,name,geometry,scope:'Native registration receipt stayed visible until Close, current picker refreshed, and saved activation confirmation was cancelled; no activation apply or secret issuance claim'},null,2)+'\n')
})
