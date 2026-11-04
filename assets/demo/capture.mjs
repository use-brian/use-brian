// Run against freshly built product bundles. All transport data is fictional.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {resolve,extname,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
const sourceDir=dirname(fileURLToPath(import.meta.url));
const repo=resolve(sourceDir,'../..');
const workDir=resolve(process.env.DEMO_WORK_DIR || resolve(tmpdir(),'use-brian-readme-demo'));
const root=resolve(process.env.DEMO_RENDERER_DIR || resolve(workDir,'renderer'));
await access(resolve(root,'index.html'));
const req=createRequire(resolve(repo,'apps/doc-sync/package.json'));
const {Server}=await import(req.resolve('@hocuspocus/server').replace('hocuspocus-server.cjs','hocuspocus-server.esm.js'));
const {pageToYDoc}=await import(req.resolve('@use-brian/doc-model'));
const fixtureText=await readFile(resolve(sourceDir,'fixture.js'),'utf8');
const blocks=Function('return '+fixtureText.match(/const blocks=(\[.*?\]);/s)[1])();
// Keep one initial Yjs state so revisiting the Page merges idempotently.
const demoPage=pageToYDoc({version:1,blocks},'Launch brief');
const sync=new Server({port:44399,address:'127.0.0.1',quiet:true,onAuthenticate:async()=>({}),onLoadDocument:async()=>demoPage});await sync.listen();
const server=createServer(async(request,response)=>{
 try {
  const path=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
  const base=path.startsWith('/extension/')?resolve(repo,'apps/browser-extension/dist'):root;
  const relative=path.startsWith('/extension/')?path.slice(11):'.'+path.replace(/\/$/,'/index.html');
  let file=resolve(base,relative);
  if(!file.startsWith(base+sep)){response.writeHead(403).end();return;}
  if(path==='/web-example.html')file=resolve(sourceDir,'web-example.html');
  let content;
  try {content=await readFile(file);}catch {
   // The desktop Vite build does not copy Next's public directory.
   const publicRoot=resolve(repo,'apps/app-web/public');
   file=resolve(publicRoot,'.'+path);
   if(!file.startsWith(publicRoot+sep))throw new Error('Invalid public asset path');
   content=await readFile(file);
  }
  response.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[extname(file)]||'application/octet-stream');
  response.end(content);
 }catch{response.writeHead(404).end();}
});
let browser;
try {
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(4399,'127.0.0.1',ok);});
 browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
const context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1});
await context.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:4399/')?route.continue():route.abort());
await context.addInitScript({path:resolve(sourceDir,'fixture.js')});await context.addInitScript({path:resolve(sourceDir,'extension-fixture.js')});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.stack));

const scenes=[
 ['page','Feature showcase','Store documents in Page','Briefs, notes and reference material, in one place.','p/demo-page-0'],
 ['browser','Feature showcase','Work across the web','Brian can navigate your browser, with your permission.','@browser'],
 ['recording','Feature showcase','Record the conversation','Keep the transcript, decisions and action items together.','recordings/demo-recording'],
 ['tasks','Feature showcase','Turn plans into tasks','Owners, priorities and progress for everyday business.','tasks'],
 ['crm','Feature showcase','Keep customer work moving','Contacts, companies and deals share the same context.','crm'],
 ['workflow','Feature showcase','Run work on a trigger','Schedule a briefing. Start follow-up from a webhook.','workflow'],
 ['brain','Built for business and teams','One shared brain','Retrieve, synthesize and update information through Chat.','chat?s=demo-chat&v=workspace'],
 ['team','Built for business and teams','People and agents, together','Continue the work in a shared team conversation.','chat?s=demo-chat&v=workspace'],
 ['context','Built for business and teams','The right context for each team','Organize by Department and Project. Bound access by clearance.','organization'],
 ['scope','Built for business and teams','Separate context without losing the big picture','Choose a Department, Project and clearance for each piece of work.','p/demo-page-0'],
 ['permissions','Built for business and teams','You control what agents can do','Allow reads, review writes and block destructive actions.','studio/assistants?assistant=demo-assistant&tab=tools'],
 ['deployment','Built for business and teams','Hosted or self-hosted','Choose where your team’s brain lives.','@accounts'],
 ['channels','Connectivity','Meet your team where they work','Connect messaging channels to the same workspace brain.','studio/channels'],
 ['agents','Connectivity','Bring other agents into the work','Connect a specialist agent as a tool through MCP.','studio/assistants?assistant=demo-assistant&tab=tools'],
 ['mcp','Connectivity','People use their brain. Agents use Brian.','Give external agents scoped access to your shared brain.','studio/programmatic-access'],
 ['api','Connectivity','Build your own app with Brian','Call your assistant through its API and MCP endpoint.','studio/assistants?assistant=demo-assistant&tab=api'],
];
const out=resolve(workDir,'frames');
await mkdir(out,{recursive:true});
await page.setViewportSize({width:1100,height:620});
for(const [id,chapter,title,caption,path] of scenes.filter((scene,index)=>index>=Number(process.env.FROM_SCENE||0)&&(!process.env.ONLY_SCENES||process.env.ONLY_SCENES.split(',').includes(scene[0])))){
 const config={displayApiUrl:'https://api.example.com',docSyncUrl:'ws://127.0.0.1:44399',edition:'oss',browserExtensionId:'example',appUrl:'http://127.0.0.1:4399'};
 const hash=path==='@accounts'?'/accounts':'/w/00000000-0000-4000-8000-000000000001/'+path;
 await page.goto(path==='@browser'?'http://127.0.0.1:4399/web-example.html':'http://127.0.0.1:4399/?publicConfig='+encodeURIComponent(JSON.stringify(config))+'&scene='+id+'#'+hash,{waitUntil:'domcontentloaded'});
 await page.waitForTimeout(1800);
 if(id==='page'||id==='scope')await page.getByText('One plan, shared with the team',{exact:true}).waitFor({timeout:15000});
 if(id==='browser'){
   const f=page.frameLocator('iframe');
   await f.locator('textarea').fill('Open the onboarding kit page and check the delivery window.');
   await f.locator('textarea').press('Enter');
   await page.waitForTimeout(1200);
 }
 if(id==='tasks'){await page.getByRole('button',{name:'Board',exact:true}).click();await page.waitForTimeout(350);}
 if(id==='team'){const input=page.locator('textarea:visible').first();if(await input.count())await input.fill('@Brian, update the launch brief and keep Jamie in the loop.');}
 if(id==='permissions'||id==='agents'){
   await page.getByRole('button',{name:'Connectors',exact:true}).click();await page.waitForTimeout(500);
   if(id==='permissions'){await page.getByText('Google Calendar',{exact:true}).last().click();await page.waitForTimeout(900);await page.getByText('googleCalendarDeleteEvent',{exact:true}).scrollIntoViewIfNeeded();}
   if(id==='agents'){await page.getByText('Research agent',{exact:true}).last().click();await page.waitForTimeout(700);await page.getByText('researchCompany',{exact:true}).scrollIntoViewIfNeeded();}
 }
 if(id==='scope'){const b=page.getByRole('button',{name:'Page clearance',exact:true});if(await b.count()){await b.click();await page.waitForTimeout(300);}}
 if(id==='deployment'){
   const b=page.getByRole('button',{name:/Add another account/});if(await b.count()){await b.first().click();await page.waitForTimeout(400);}
 }
 if(id==='channels'){await page.getByRole('button',{name:/More channels/}).click();await page.waitForTimeout(300);}
 if(id==='api')await page.getByText('Assistant MCP endpoint',{exact:true}).scrollIntoViewIfNeeded();
 for(const frame of page.frames())await frame.evaluate(()=>document.activeElement instanceof HTMLElement&&document.activeElement.blur());
 await page.mouse.move(1098,618);
 const text=await page.locator('body').innerText();
 const brokenImages=await page.locator('img').evaluateAll(images=>images.filter(image=>image.getBoundingClientRect().width>0 && (!image.complete||image.naturalWidth===0)).map(image=>image.src));
 if(errors.length||brokenImages.length)throw new Error(JSON.stringify({id,errors,brokenImages}));
 await page.screenshot({path:out+'/'+id+'.png'});
 console.log(JSON.stringify({id,text,errors:errors.splice(0),requests:await page.evaluate(()=>window.__demoRequests)}));
}
await writeFile(out+'/scenes.json',JSON.stringify(scenes.map(([id,chapter,title,caption])=>({id,chapter,title,caption,duration:['workflow','brain','permissions','mcp','api'].includes(id)?5:4})),null,2));
} finally {
 await browser?.close();
 server.closeAllConnections();
 await new Promise(resolve=>server.close(resolve));
 await sync.destroy();
}
