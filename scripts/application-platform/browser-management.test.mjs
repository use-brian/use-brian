/** Actual native management locale/phone observation. [COMP:app-web/application-admin] */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
const runId=process.argv[2];assert.match(runId??'',/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/)
const folder=resolve('output/application-platform',runId),config=JSON.parse(readFileSync(join(folder,'portal-browser-inputs.json'),'utf8'))
assert.match(config.workspaceId,/^[0-9a-f]{8}-[0-9a-f-]{27}$/i)
const command=(...args)=>execFileSync('agent-browser',['--config',join(folder,'browser-config.json'),'--session','renewed-management',...args],{encoding:'utf8',timeout:20000})
const evaluate=source=>{const result=JSON.parse(command('--json','eval',source));assert.equal(result.success,true);return JSON.parse(result.data.result)}
const artifacts=join(folder,'browser-artifacts');mkdirSync(artifacts,{recursive:true})
const path='http://localhost:3003/w/'+config.workspaceId+'/studio/programmatic-access/applications'
function copy(locale){const source=readFileSync('apps/app-web/src/lib/i18n/dictionaries/'+locale+'.ts','utf8').split('applicationManagement: {')[1].split(/\n\s*},/)[0];return Object.fromEntries([...source.matchAll(/"([^"]+)": ("(?:[^"\\]|\\.)*")/g)].map(match=>[match[1],JSON.parse(match[2])]))}
function observed(title){return evaluate(`JSON.stringify((()=>{const section=[...document.querySelectorAll('section')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(title)});return {text:section?.textContent??'',width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,buttons:section?[...section.querySelectorAll('button')].filter(x=>x.offsetParent!==null).map(x=>({text:x.textContent,height:x.getBoundingClientRect().height})):[]}})())`)}
async function until(title,needle){const end=Date.now()+15000;let value;do{value=observed(title);if(value.text.includes(needle))return value;await new Promise(resolve=>setTimeout(resolve,200))}while(Date.now()<end);throw Error('Current management state missing: '+JSON.stringify(value))}
test('[COMP:app-web/application-admin] actual native management renders all four locales at desktop and phone with current review controls',async()=>{
 for(const locale of ['en','ja','zh','zh-cn']){
  const t=copy(locale);assert.ok(t.title&&t.reviewActivation)
  evaluate(`JSON.stringify(document.cookie='locale=${locale==='zh-cn'?'zh-CN':locale}; path=/; SameSite=Lax')`)
  for(const viewport of ['desktop','phone']){
   command('set','viewport',viewport==='phone'?'360':'1280',viewport==='phone'?'844':'900');command('open',path)
   const value=await until(t.title,t.reviewActivation);assert.ok(value.text.includes(t.register));assert.ok(!value.text.includes(t.unqualified));assert.equal(value.overflow,false)
   if(viewport==='phone')assert.ok(value.buttons.length&&value.buttons.every(button=>button.height>=44),'Native management phone buttons must be44px')
   command('screenshot',join(artifacts,'management-'+locale+'-'+viewport+'.png'),'--full');writeFileSync(join(artifacts,'management-'+locale+'-'+viewport+'.json'),JSON.stringify({locale,viewport,...value},null,2)+'\n')
  }
 }
})
