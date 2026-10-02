// TEST ONLY. Separate Swift compilation units, REAL swift-crypto on Linux.
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { frameworkVectors } from './electron-framework-binding-vectors.mjs';
export function sourceGuards() {
  const source=readFileSync(new URL('./ElectronFrameworkBinding.swift',import.meta.url),'utf8');
  const code=source.replace(/\/\/[^\n]*/g,'');
  assert(!/KernelExpectation|authenticatedArchitecture|Helper\.|FileManager|ProcessInfo|CommandLine|Data\(contentsOf|URL\(|getenv|print\(|csops|SecCode|Unsafe|bytesNoCopy|#if|canImport|fatalError|try!|as!/.test(code));
  for(const flag of ['productionAuthority','controlAdmission','cmsAuthentication','staticSignerAuthentication','nativeEnforcement','loadedImageAuthentication','inventoryProvenance','inventoryCompleteness','approvalProvenance','nativeAcceptance']) assert(source.includes(`let ${flag} = false`));
  const mach=readFileSync(new URL('./MachOLibraryConstraint.swift',import.meta.url),'utf8');
  const api=mach.slice(mach.indexOf('static func verifyFrameworkArtifact'),mach.indexOf('private static func copy'));
  assert(!api.includes('KernelExpectation')); assert(api.includes('approvedCDHashes.count <= 64')); assert(api.includes('inventory.insert(copy(hash)).inserted'));
  const parser=mach.slice(mach.indexOf('func framework(inventory:'),mach.indexOf('func bindAnchor('));
  assert(parser.includes('for slice in all')); assert(parser.includes('fileType: 6'));
  assert(parser.indexOf('try directory(')<parser.indexOf('try geometry('));
  assert(parser.indexOf('inventory.contains(hash)')<parser.indexOf('try geometry('));
  const helper=readFileSync(new URL('./Helper.swift',import.meta.url),'utf8');
  assert(helper.includes('probeOnlyResponse(request, clock: sourceClock)')); assert(!/Broker\s*\(/.test(helper));
  return source;
}
export function runFrameworkTests(mode) {
  assert(['--portable','--foundation-crypto','--foundation-cryptokit'].includes(mode)); sourceGuards();
  const vectors=frameworkVectors(), summary={vectors:vectors.length,matches:vectors.filter(v=>v.expected.match).length,swiftRuns:0,nativeAcceptance:false};
  if(mode==='--portable') return summary;
  const temp=mkdtempSync(join(tmpdir(),'brian-electron-framework-binding-'));
  try {
    const sources=[];
    for(const name of ['MachOLibraryConstraint.swift','BootstrapApproval.swift','ElectronFrameworkBinding.swift']) {
      let text=readFileSync(new URL(name,import.meta.url),'utf8');
      if(mode==='--foundation-crypto') text=text.replace(/^import CryptoKit$/m,'import Crypto');
      const path=join(temp,name); writeFileSync(path,text); sources.push(path);
    }
    const main=join(temp,'main.swift'); writeFileSync(main,readFileSync(new URL('./ElectronFrameworkBindingTests.swift',import.meta.url),'utf8')); sources.push(main);
    const input=join(temp,'vectors.json'); writeFileSync(input,JSON.stringify(vectors.map(({expected,...v})=>v)));
    const flags=[];
    if(mode==='--foundation-crypto') {
      for(const key of ['SWIFT_CRYPTO_INCLUDE','SWIFT_CRYPTO_STATIC_INCLUDE','SWIFT_CRYPTO_LIB']) assert(process.env[key]?.startsWith('/'));
      flags.push('-I',process.env.SWIFT_CRYPTO_INCLUDE,'-I',process.env.SWIFT_CRYPTO_STATIC_INCLUDE,'-L',process.env.SWIFT_CRYPTO_LIB,'-lCrypto','-Xlinker','-rpath','-Xlinker',process.env.SWIFT_CRYPTO_LIB);
    }
    for(const optimization of [[],['-O']]) {
      const binary=join(temp,'tests');
      const c=spawnSync('swiftc',['-swift-version','5',...optimization,...flags,...sources,'-o',binary],{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
      assert.equal(c.error,undefined); assert.equal(c.status,0,c.stderr);
      const r=spawnSync(binary,[input],{encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
      assert.equal(r.error,undefined); assert.equal(r.status,0,r.stderr);
      const results=JSON.parse(r.stdout); assert.equal(results.length,vectors.length);
      results.forEach((actual,i)=>assert.deepEqual(actual,vectors[i].expected,vectors[i].name)); summary.swiftRuns++;
    }
    return summary;
  } finally {rmSync(temp,{recursive:true,force:true});}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(runFrameworkTests(process.argv[2])));
  console.log('Synthetic ARTIFACT data only: no native SDK, CMS, loaded-image, inventory provenance/completeness, enforcement or authority acceptance.');
}
