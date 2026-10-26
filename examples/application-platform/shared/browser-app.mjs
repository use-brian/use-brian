import { createApplicationClient, createFetchTransport, createApplicationSignIn } from '@use-brian/brian-app/application'
import { createBrowserSession } from '../shared/browser-session.mjs'
import { resolveReferenceLocale, referenceText } from './browser-copy.mjs'
export function mountReferenceApp(mode) {
const node = id => document.getElementById(id)
let locale = resolveReferenceLocale({ search:location.search, cookie:document.cookie, languages:navigator.languages ?? [navigator.language] }), statusValues = {}
const text = (key, values) => referenceText(locale,key,values)
const translate = () => {
 document.documentElement.lang=locale
 for (const element of document.querySelectorAll('[data-copy]')) element.textContent=text(element.dataset.copy)
 node('languages').setAttribute('aria-label',text('language'))
 for(const button of node('languages').querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.locale===locale))
 node('status').textContent=text(node('status').dataset.status,statusValues)
}
const status = (key, values = {}) => { node('status').dataset.status=key;statusValues=values;node('status').textContent=text(key,values) }
for(const [value,label]of Object.entries({en:'English',ja:'日本語',zh:'繁體中文','zh-CN':'简体中文'})) {
 const button=document.createElement('button');button.type='button';button.dataset.locale=value;button.textContent=label;button.lang=value
 button.onclick=()=>{locale=value;translate()};node('languages').append(button)
}
translate()
let session, signIn, config, popup, timer, pendingCommand
const clear = () => { node('data').replaceChildren() }
const safeError = error => error?.effect === 'uncertain' ? 'uncertain' : 'unavailable'
if (window.opener && new URL(location.href).searchParams.has('state')) {
 const appId = sessionStorage.getItem('public-app-callback-id')
 // Only public app metadata is stored; PKCE proof and all credentials stay in the opener.
 if (appId) window.opener.postMessage({ type:'ub:application:callback', appId, url:location.href },location.origin)
 window.close()
} else {
 node('configuration').addEventListener('submit',async event => {
  event.preventDefault();const input = Object.fromEntries(new FormData(event.currentTarget));
  if(session?.uncertain&&JSON.stringify(input)!==JSON.stringify(config)){status('configureUncertain');return}
  session?.invalidate(); signIn?.cancel(); clear(); clearTimeout(timer);config = Object.freeze(input)
  try {
   if(!session?.uncertain)session = createBrowserSession({ ...config, createClient:createApplicationClient, createTransport:createFetchTransport, onClear:clear })
   signIn = createApplicationSignIn({ ...config, redirectUri:location.origin+location.pathname, scope:mode === 'operations'?'read_write':'read' })
   popup = window.open('about:blank','brian-application-sign-in','width=520,height=720')
   if (!popup) throw new Error('Popup unavailable')
   // The callback needs public app binding only; the popup shares this same origin.
   popup.sessionStorage.setItem('public-app-callback-id',config.appId)
   const { authorizationUrl } = await signIn.begin({popup}); popup.location.href=authorizationUrl
   status('signIn')
  } catch(error) { status(safeError(error)) }
 })
 window.addEventListener('message',async event => {
  if (!signIn || event.source !== popup || event.origin !== location.origin) return
  try {
   const result = await signIn.completeFromMessage(event); session.authenticate(result)
   node('signout').disabled=false;node('refresh').disabled=false
   if (mode==='operations') {node('controls').hidden=false;node('controls').innerHTML='<h2 data-copy="createHeading"></h2><form id="purchase"><label><span data-copy="title"></span><input name="title" required maxlength="256"></label><label><span data-copy="companyId"></span><input name="companyId" required></label><label><span data-copy="budget"></span><input name="budget" required inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?"></label><label><span data-copy="lineTitle"></span><input name="lineTitle" required></label><label><span data-copy="quantity"></span><input name="quantity" type="number" min="1" max="1000000" step="1" required></label><label><span data-copy="unitCost"></span><input name="unitCost" required inputmode="decimal"></label><button data-copy="create"></button></form>'
    translate();node('purchase').onsubmit=async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.currentTarget));const id=crypto.randomUUID();await command('create_request',{id,title:data.title,companyId:data.companyId,budget:data.budget,lines:[{id:crypto.randomUUID(),title:data.lineTitle,quantity:Number(data.quantity),unitCost:data.unitCost}]})}
   }
   status('signedIn');timer=setTimeout(()=>{session.invalidate();status('expired')},result.expiresIn*1000)
  } catch(error) {session?.invalidate();status(safeError(error))}
 })
 async function command(key,input,expectedVersion) {
  if(session?.uncertain){status('pendingUncertain');return}
  const idempotencyKey=crypto.randomUUID(),envelope={input,idempotencyKey,...(expectedVersion?{expectedVersion}:{})};pendingCommand={key,envelope}
  try {const receipt=await session.call((client,call)=>client.command(key,envelope,call),{write:true,idempotencyKey});pendingCommand=undefined;node('reconcile').hidden=true;status('saved',{receipt:receipt.id})}catch(error){if(!session.uncertain)pendingCommand=undefined;node('reconcile').hidden=!session.uncertain;status(safeError(error))}
 }
 node('refresh').onclick=async()=>{
  clear();status('reading')
  try {
   const result=await session.call((client,call)=>client.query(config.type,{filters:[],sort:[],aggregate:[],limit:50},call))
   if (!result.records.length) status('empty')
   else {status('current');for(const record of result.records){const article=document.createElement('article');const title=document.createElement('strong');title.textContent=record.ref.id;article.append(title)
    for(const [key,value]of Object.entries(record.values)){const p=document.createElement('p'),label=document.createElement('span'),display=document.createElement('span');
     const known=mode==='operations'?{title:'title',company:'companyId',budget:'budget',state:'state',total:'total'}:{description:'description',status:'status'},raw=value&&typeof value==='object'&&'value'in value?String(value.value):String(value);
     if(Object.hasOwn(known,key)){label.dataset.copy=known[key];label.textContent=text(known[key])}else label.textContent=key;
     if(mode==='operations'&&key==='state'&&['draft','submitted','ordered'].includes(raw)){display.dataset.copy=raw;display.textContent=text(raw)}else display.textContent=raw;
     p.append(label,': ',display);article.append(p)}
    if(mode==='operations'){const cell=record.values.state;const state=typeof cell==='object'?cell?.value:cell;const button=document.createElement('button');if(state==='draft'){button.dataset.copy='submit';button.dataset.action='submit_request';button.textContent=text('submit');button.onclick=()=>command('submit_request',{id:record.ref.id},record.ref.version);article.append(button)}else if(state==='submitted'){button.dataset.copy='approve';button.dataset.action='approve_order';button.textContent=text('approve');button.onclick=()=>command('approve_order',{id:record.ref.id,orderId:crypto.randomUUID()},record.ref.version);article.append(button)}}node('data').append(article)}
   }
  }catch(error){clear();status(safeError(error))}
 }
 node('reconcile').onclick=async()=>{
  if(!session?.uncertain||!pendingCommand)return;node('reconcile').disabled=true;
  try{await session.reconcile(async(client,call)=>{
   const result=await client.reconcile(pendingCommand.key,pendingCommand.envelope,call)
   if(result.state!=='applied')throw new Error('Saved outcome remains uncertain')
   return result.receipt
  });pendingCommand=undefined;node('reconcile').hidden=true;status('confirmed')}
  catch{status('unresolved')}
  finally{node('reconcile').disabled=false}
 }
 node('signout').onclick=()=>{signIn?.cancel();session?.invalidate();clearTimeout(timer);node('controls').hidden=true;node('refresh').disabled=true;node('signout').disabled=true;status('signedOut')}
 window.addEventListener('offline',()=>{session?.setOnline(false);status('offline')})
 window.addEventListener('online',()=>{session?.setOnline(true);status('online')})
 document.addEventListener('visibilitychange',()=>{if(document.hidden){session?.invalidate();status('visibility')}})
 window.addEventListener('pagehide',()=>{signIn?.cancel();session?.invalidate()})
}

}
