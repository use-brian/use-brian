// [COMP:app-web/office-offline] Actual Chromium IndexedDB and WebCrypto proof.
// Local fixture only; no product API, model, account, credentials or migrations.
import {createServer} from 'vite';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = fileURLToPath(new URL('..', import.meta.url));
const cache = await mkdtemp(join(tmpdir(), 'office-offline-browser-'));
const server = await createServer({configFile:false, envFile:false, root:app, cacheDir:cache,
  optimizeDeps:{entries:['scripts/fixtures/office-offline-browser.html']},
  resolve:{alias:[{find:'@/lib/user',replacement:join(app,'scripts/fixtures/office-offline-identity.mjs')},{find:'@',replacement:join(app,'src')}]},
  server:{port:0,host:'127.0.0.1',hmr:false,fs:{allow:[resolve(app,'../../..'),cache]}}});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const context = await browser.newContext();
  const errors = [];
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/office-offline-browser.html`);
  await page.waitForFunction(()=>Boolean(window.officeOfflineFixture));
  const results = await page.evaluate(async()=>{
    const {offline:o,metadata,documentFixture} = window.officeOfflineFixture;
    const passed=[];
    const check=(condition,message)=>{if(!condition)throw new Error(message);};
    const rejects=async(promise,reason)=>{try{await promise;}catch(error){check(error.message.includes(reason),`Expected ${reason}, got ${error.message}`);return;}throw new Error(`Expected rejection: ${reason}`);};
    const setUser=id=>{window.officeOfflineViewer=id;};
    const persist=(params,owner,validForMs=30_000)=>o.persistOfficeOfflinePackage(params,owner,metadata.attachOfficeMetadata({},validForMs,performance.now(),owner.userId));
    const a={workspaceId:'workspace-a',userId:'viewer-a'}, b={...a,userId:'viewer-b'}, other={...a,workspaceId:'workspace-b'};
    const hash=async(text)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
    async function pkg(owner,artifactId='artifact-1',title=owner.userId){
      const snapshot={...documentFixture(),artifactId,workspaceId:owner.workspaceId,resources:[]};
      snapshot.sections=[];
      const payload={artifact:{artifactId,family:'document',title,version:1,lifecycleState:'active',role:'edit'},snapshot,seq:0,baseVersion:1,yjsUpdate:'',comments:[],history:[],renderedFallback:title,resources:[]};
      const manifest={artifactId,version:1,snapshotHash:await o.officeManifestHash(snapshot),updateHash:await hash(''),fallbackHash:await hash(title),resourceHashes:[]};
      return {artifactId,version:1,manifest,payload,signature:'fixture-signature',pinned:true};
    }
    const entry=(seq,artifactId='artifact-1',body='private draft')=>({artifactId,seq,kind:'comment',anchor:{kind:'block',targetIds:['block-1']},body,createdAt:'2026-01-01T00:00:00.000Z'});
    const request=p=>new Promise((resolve,reject)=>{p.onsuccess=()=>resolve(p.result);p.onerror=()=>reject(p.error);});
    const complete=t=>new Promise((resolve,reject)=>{t.oncomplete=resolve;t.onabort=()=>reject(t.error);t.onerror=()=>reject(t.error);});
    const open=async(version,upgrade)=>{const r=indexedDB.open('use-brian-office-offline-v1',version);if(upgrade)r.onupgradeneeded=()=>upgrade(r.result);return request(r);};
    const raw=async(store,key)=>{const db=await open(4);try{return await request(db.transaction(store).objectStore(store).get(key));}finally{db.close();}};
    const all=async(store)=>{const db=await open(4);try{return await request(db.transaction(store).objectStore(store).getAll());}finally{db.close();}};
    const put=async(store,key,value)=>{const db=await open(4);try{const t=db.transaction(store,'readwrite'),done=complete(t);if(key===undefined)t.objectStore(store).put(value);else t.objectStore(store).put(value,key);await done;}finally{db.close();}};
    // Populate the old schema before the production adapter upgrades it.
    const legacyKey=await crypto.subtle.importKey('raw',crypto.getRandomValues(new Uint8Array(32)),'HKDF',false,['deriveKey']);
    const legacyPackage=await o.encryptOfficePackage({...await pkg(a),deviceSecret:legacyKey});
    const legacyJournal=await o.encryptOfflineJournalEntry(entry(1),legacyKey);
    const db=await open(2,d=>{d.createObjectStore('packages',{keyPath:'artifactId'});d.createObjectStore('journal',{keyPath:['artifactId','seq']});d.createObjectStore('keys');});
    const t=db.transaction(['packages','journal','keys'],'readwrite'),done=complete(t);
    t.objectStore('packages').put(legacyPackage);t.objectStore('journal').put(legacyJournal);t.objectStore('keys').put(legacyKey,'root');await done;db.close();
    setUser(a.userId);
    check(await o.loadOfflinePackage('artifact-1',a)===null,'Legacy package must not be adopted');
    check((await o.listOfflineJournal('artifact-1',a)).length===0,'Legacy journal must not replay');
    check((await raw('packages','artifact-1')).ciphertext===legacyPackage.ciphertext,'Legacy package retained');
    check((await raw('journal',['artifact-1',1])).ciphertext===legacyJournal.ciphertext,'Legacy edits retained');
    check((await o.decryptOfflineJournalEntry(legacyJournal,await raw('keys','root'))).body==='private draft','Legacy key retained');
    passed.push('legacy ciphertext quarantined without data loss');

    await persist(await pkg(a),a);await o.appendOfflineCommand(entry(2),a);
    await persist(await pkg(other,'artifact-1','other workspace'),other);await o.appendOfflineCommand(entry(2,'artifact-1','other workspace draft'),other);
    setUser(b.userId);check(await o.loadOfflinePackage('artifact-1',b)===null,'Another viewer must not read A');
    check((await o.listOfflineJournal('artifact-1',b)).length===0,'Another viewer must not replay A');
    await persist(await pkg(b),b);await o.appendOfflineCommand(entry(2,'artifact-1','viewer B draft'),b);
    check((await o.loadOfflinePackage('artifact-1',b)).payload.artifact.title===b.userId,'Viewer B owns own data');
    setUser(a.userId);check((await o.loadOfflinePackage('artifact-1',a)).payload.artifact.title===a.userId,'A preserved');
    check((await o.loadOfflinePackage('artifact-1',other)).payload.artifact.title==='other workspace','Workspace isolation');
    check((await o.listOfflineJournal('artifact-1',other))[0].body==='other workspace draft','Journal workspace isolation');
    await o.removeOfflinePackage('artifact-1',a);await o.removeOfflineJournalEntry(entry(2),a);
    check(await o.loadOfflinePackage('artifact-1',a)===null,'Own package removed');check((await o.listOfflineJournal('artifact-1',a)).length===0,'Own journal removed');
    check(Boolean(await o.loadOfflinePackage('artifact-1',other)),'Other workspace survives deletion');
    setUser(b.userId);check(Boolean(await o.loadOfflinePackage('artifact-1',b)),'Other viewer survives deletion');check((await o.listOfflineJournal('artifact-1',b)).length===1,'Other viewer journal survives deletion');
    passed.push('viewer and workspace partitions isolate reads writes and removals');

    setUser(null);await rejects(o.loadOfflinePackage('artifact-1',a),'owner_changed');await rejects(o.officeOfflineDeviceId(a),'owner_changed');
    setUser(b.userId);await rejects(o.appendOfflineCommand(entry(3),a),'owner_changed');
    setUser(a.userId);await rejects(persist(await pkg(other),a),'scope_mismatch');
    await rejects(o.appendOfflineCommand({...entry(3),kind:'command',command:{actor:{type:'user',id:b.userId},artifactId:'artifact-1'}},a),'scope_mismatch');
    await rejects(o.appendOfflineCommand({...entry(3),kind:'command',command:{kind:'batch',actor:{type:'user',id:a.userId},artifactId:'artifact-1',commands:[{actor:{type:'user',id:b.userId},artifactId:'artifact-1'}]}},a),'scope_mismatch');
    passed.push('missing identity stale caller and mismatched payload refused');

    const concurrent={...a,workspaceId:'concurrent-workspace'};
    const packages=await Promise.all(Array.from({length:12},(_,i)=>pkg(concurrent,`concurrent-${i}`)));
    await Promise.all(packages.flatMap((p,i)=>[persist(p,concurrent),o.appendOfflineCommand(entry(i,p.artifactId),concurrent)]));
    const read=await Promise.all(packages.flatMap(p=>[o.loadOfflinePackage(p.artifactId,concurrent),o.listOfflineJournal(p.artifactId,concurrent)]));
    check(read.every((row,i)=>i%2?row.length===1:Boolean(row)),'Concurrent first writes share a durable root');
    const ids=await Promise.all(Array.from({length:12},()=>o.officeOfflineDeviceId(concurrent)));
    check(new Set(ids).size===1,'Concurrent device IDs must agree');
    check(await o.officeOfflineDeviceId(a)!==ids[0],'Workspace device IDs differ');
    setUser(b.userId);check(await o.officeOfflineDeviceId(b)!==ids[0],'Viewer device IDs differ');
    const keyA=await raw('keys',['root',a.workspaceId,a.userId]),keyB=await raw('keys',['root',b.workspaceId,b.userId]);
    check(!keyA.extractable&&!keyB.extractable,'Roots nonextractable');
    try {await o.decryptOfficePackage(await raw('viewer-packages',[b.workspaceId,b.userId,'artifact-1']),keyA);throw new Error('Wrong root decrypted');}catch(error){check(error.name==='OperationError','Distinct roots must fail authenticated decrypt');}
    passed.push('concurrent first writers share one nonextractable root per owner');

    async function gate(method,run){
      const original=crypto.subtle[method];let arrive,release;
      const arrived=new Promise(resolve=>{arrive=resolve;}),released=new Promise(resolve=>{release=resolve;});
      crypto.subtle[method]=async function(...args){const result=await original.apply(this,args);arrive();await released;return result;};
      try{await run(arrived,release);}finally{release();crypto.subtle[method]=original;}
    }
    setUser(a.userId);await persist(await pkg(a),a);await o.appendOfflineCommand(entry(10),a);
    for(const operation of [()=>o.loadOfflinePackage('artifact-1',a),()=>o.listOfflineJournal('artifact-1',a)]){
      setUser(a.userId);await gate('decrypt',async(arrived,release)=>{const pending=operation();await arrived;setUser(b.userId);release();await rejects(pending,'owner_changed');});
    }
    passed.push('account switches during decrypt cannot return prior owner data');

    const pendingPackage=await pkg(a,'pending-package');
    for(const operation of [()=>persist(pendingPackage,a),()=>o.appendOfflineCommand(entry(1,'pending-journal'),a)]){
      setUser(a.userId);await gate('encrypt',async(arrived,release)=>{const pending=operation();await arrived;setUser(b.userId);release();await rejects(pending,'owner_changed');});
    }
    check(await o.loadOfflinePackage('pending-package',b)===null,'Pending package not attributed to B');check((await o.listOfflineJournal('pending-journal',b)).length===0,'Pending edits not attributed to B');
    setUser(a.userId);check(await o.loadOfflinePackage('pending-package',a)===null,'Stale encryption not committed');check((await o.listOfflineJournal('pending-journal',a)).length===0,'Stale edit not committed');
    passed.push('account switches during encryption refuse pending writes');

    // Changing a caller-owned options object during async work cannot retarget storage.
    const mutable={...a},mutablePkg=await pkg(a,'captured-owner');
    await gate('encrypt',async(arrived,release)=>{const pending=persist(mutablePkg,mutable);await arrived;mutable.workspaceId='redirected';release();await pending;});
    check(Boolean(await o.loadOfflinePackage('captured-owner',a)),'Captured owner retained');check(await o.loadOfflinePackage('captured-owner',mutable)===null,'Mutable owner did not retarget');
    // Copying encrypted records between owner partitions cannot make their content readable.
    const record=await raw('viewer-packages',[a.workspaceId,a.userId,'artifact-1']);
    await put('viewer-packages',undefined,{...record,...b});setUser(b.userId);
    try{await o.loadOfflinePackage('artifact-1',b);throw new Error('Copied ciphertext accepted');}catch(error){check(error.name==='OperationError','Copied ciphertext must fail authentication');}
    passed.push('captured owner and per-owner encryption prevent storage retargeting');

    setUser(a.userId);
    const expiredPackage=await pkg(a,'expired-package');
    await gate('encrypt',async(arrived,release)=>{const pending=persist(expiredPackage,a,5);await arrived;await new Promise(resolve=>setTimeout(resolve,15));release();await rejects(pending,'projection_expired');});
    check(await o.loadOfflinePackage('expired-package',a)===null,'Expired response must not become durable');
    passed.push('bounded package authority expires before durable browser commit');

    const quarantinePackage=await pkg(a,'quarantined-artifact','quarantined title');
    await persist(quarantinePackage,a);await o.appendOfflineCommand(entry(44,'quarantined-artifact','quarantined body'),a);
    await o.quarantineOfflineWork('quarantined-artifact',a);
    check(await o.loadOfflinePackage('quarantined-artifact',a)===null,'Quarantined package is not readable');
    check((await o.listOfflineJournal('quarantined-artifact',a)).length===0,'Quarantined journal is not replayable');
    const quarantined=(await all('viewer-quarantine')).find(row=>row.artifactId==='quarantined-artifact');
    check(Boolean(quarantined?.packageRecord?.ciphertext)&&quarantined.journalRecords.length===1,'Raw encrypted work retained in quarantine');
    check(!JSON.stringify(quarantined).includes('quarantined body'),'Quarantine remains ciphertext only');
    passed.push('revoked local work moves atomically to opaque quarantine');
    return passed;
  });
  assert.equal(results.length,9);assert.deepEqual(errors,[]);
  if(process.env.OFFICE_OFFLINE_RECEIPT)await writeFile(process.env.OFFICE_OFFLINE_RECEIPT,JSON.stringify({passed:results,errors},null,2)+'\n');
  console.log(JSON.stringify({passed:results,errors},null,2));
} finally {await browser?.close();await server.close();await rm(cache,{recursive:true,force:true});}
