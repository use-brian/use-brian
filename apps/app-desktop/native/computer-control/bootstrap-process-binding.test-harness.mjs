// TEST ONLY: pure policy execution, never Security/Darwin stubs or native evidence.
// Reuse the normal Nix shell command atop macho-library-constraint.mjs; run this
// script with --foundation. Only generated temp CryptoKit imports become Crypto.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { integrityDictionaryDigest } from '../../scripts/mac-asar-integrity.mjs';
import { extractAuthenticatedLibraryConstraint as fullJSExtraction } from '../../scripts/mac-library-constraints.mjs';
import { fixture, fatFixture, rebind } from '../../scripts/mac-library-constraints.test-fixtures.mjs';
import { thin as anchorThin, cdOffset as anchorCDOffset, sha as anchorHash, signatureOffset, component, approval, rehash, anchorOffset, fat as anchorFat } from '../../scripts/mac-bootstrap-anchor.test-fixtures.mjs';
import { encodeBootstrapApprovalRecord } from '../../scripts/mac-bootstrap-anchor.mjs';
const reject = { error: 'ERR_BOOTSTRAP_PROCESS_BINDING_UNAVAILABLE' };
export function vectors() {
  const result = [];
  const item = hash => ({ algorithm: 'SHA256', hash });
  const digest = (name, value) => {
    let expected;
    try { expected = { digest: integrityDictionaryDigest(value).toString('base64') }; }
    catch { expected = reject; }
    result.push({ name, kind: 'digest', value, expected });
  };
  digest('golden', { 'Resources/app.asar': item('0'.repeat(64)) });
  assert.equal(Buffer.from(result[0].expected.digest, 'base64').toString('hex'), '0d0379b03797cd157251d6af924f85f98ed473f75cad417b8b500f220c518cde');
  digest('literal-ASCII-order', Object.fromEntries(['Resources/z.asar','Resources/A.asar','Resources/a-b.asar','Resources/a.b.asar','Resources/a.asar'].map((k,i)=>[k,item(String(i).repeat(64))])));
  for (const count of [1,2,63,128,129]) {
    const value = {};
    for (let i = count - 1; i >= 0; i--) value[`Resources/z_${String(i).padStart(3,'0')}/app-${i}.asar`] = item(i.toString(16).padStart(64, '0'));
    digest(`count-${count}`, value);
  }
  for (const value of [null, {}, [], true, { 'Resources/app.asar': null }, { 'Resources/app.asar': item('F'.repeat(64)) },
    { 'Resources/app.asar': item('0'.repeat(63)) }, { 'Resources/app.asar': { ...item('0'.repeat(64)), extra: true } },
    { 'Resources/app.asar': { hash: '0'.repeat(64) } }, { 'Resources/app.asar': { algorithm: 'sha256', hash: '0'.repeat(64) } }]) digest(`invalid-${result.length}`, value);
  for (const path of ['Resources/../app.asar','Resources//app.asar','Resources/a.b/app.asar','Resources/.asar','Resources/app.ASAR',
    'Resources/é.asar','/Resources/app.asar', 'Resources/'+ 'a'.repeat(1024)+'.asar']) digest(`bad-path-${result.length}`, { [path]: item('0'.repeat(64)) });
  // Derive these verdicts from JS too: without /m its $ already requires EOF.
  for (const tail of ['\n','\r','\r\n','\u2028','\u2029']) digest(`whole-key-${result.length}`, { ['Resources/app.asar'+tail]: item('0'.repeat(64)) });
  const arch = (name, bytes, hash, offset, architecture) => result.push({ name, kind: 'architecture', bytes: bytes.toString('base64'),
    hash: hash.toString('base64'), offset: String(offset), expected: architecture ? { architecture } : reject });
  for (const version of [0x20400,0x20500,0x20600]) for (const page of [12,14]) {
    const f = fixture({ version, page }); arch(`arm-${version}-${page}`, f.bytes, f.expected.cdHash, 0, 'arm64');
  }
  for (const page of [12,14]) {
    const b = anchorThin({ page }), cd = anchorCDOffset(b), hash = anchorHash(b.subarray(cd, cd+b.readUInt32BE(cd+4))).subarray(0,20);
    arch(`helper-empty-anchor-not-approval-${page}`, b, hash,0,'arm64');
    b[signatureOffset-1] ^= 1; arch(`helper-last-page-tamper-${page}`,b,hash,0);
  }
  const intel = fixture({ cpuType: 0x01000007, cpuSubtype: 3 }); arch('intel', intel.bytes, intel.expected.cdHash, 0, 'x86_64');
  for (const wide of [false,true]) {
    const f = fatFixture(wide);
    arch(`fat-arm-${wide}`, f.bytes, f.a.expected.cdHash, f.offsetA, 'arm64');
    arch(`fat-intel-${wide}`, f.bytes, f.b.expected.cdHash, f.offsetB, 'x86_64');
    arch(`fat-wrong-hash-${wide}`, f.bytes, f.b.expected.cdHash, f.offsetA);
  }
  const f = fixture();
  for (const offset of [-1,1,4096,2147483648]) arch(`offset-${offset}`, f.bytes, f.expected.cdHash, offset);
  for (const length of [0,19,20,21]) arch(`hash-${length}`, f.bytes, Buffer.alloc(length), 0);
  for (let n = 0; n < 192; n++) arch(`truncated-${n}`, f.bytes.subarray(0,n), f.expected.cdHash, 0);
  for (const at of [0,4,8,16,20,24,176,184,400,4095,f.cdOffset+12,f.cdOffset+f.hashes]) {
    const b = Buffer.from(f.bytes); b[at] ^= 1; arch(`mutation-${at}`, b, f.expected.cdHash, 0);
  }
  const wrongCPU = fixture(); wrongCPU.bytes.writeUInt32LE(7,4); rebind(wrongCPU);
  arch('unsupported-authenticated-cpu', wrongCPU.bytes, wrongCPU.expected.cdHash,0);
  const unsignedHeaderChange = fixture(); unsignedHeaderChange.bytes[4] ^= 1; rebind(unsignedHeaderChange);
  arch('repaired-pages-old-kernel', unsignedHeaderChange.bytes, f.expected.cdHash,0);
  // Known-profile mutations are rebound to an independent Node SHA256 kernel
  // expectation so rejection cannot merely be an old-CDHash mismatch. Compare
  // the reference main/library parser as well as the pure Swift architecture stage.
  const profileChanges = [
    ['unknown-flags', 0x20400, (b,c)=>b.writeUInt32BE(0x80000000,c+12)],
    ['exec-flags', 0x20400, (b,c)=>b.writeBigUInt64BE(0x400n,c+80)],
    ['exec-base', 0x20400, (b,c)=>b.writeBigUInt64BE(4097n,c+64)],
    ['exec-size', 0x20400, (b,c)=>b.writeBigUInt64BE(4097n,c+72)],
    ['exec-overflow', 0x20400, (b,c)=>b.writeBigUInt64BE(2n**64n-1n,c+64)],
    ['exec-end', 0x20400, (b,c)=>{b.writeBigUInt64BE(4096n,c+64);b.writeBigUInt64BE(1n,c+72);} ],
    ['identifier-missing', 0x20400, (b,c)=>b.writeUInt32BE(0,c+20)],
    ['identifier-header', 0x20400, (b,c)=>b.writeUInt32BE(8,c+20)],
    ['identifier-empty', 0x20400, (b,c)=>b[c+88]=0],
    ['identifier-gap', 0x20400, (b,c)=>b.writeUInt32BE(89,c+20)],
    ['team-overlap', 0x20400, (b,c)=>b.writeUInt32BE(88,c+48)],
    ['old-version', 0x20400, (b,c)=>b.writeUInt32BE(0x20300,c+8)],
    ['new-version', 0x20400, (b,c)=>b.writeUInt32BE(0x20700,c+8)],
    ['SHA1', 0x20400, (b,c)=>b[c+37]=1], ['SHA256-short', 0x20400, (b,c)=>b[c+37]=3],
    ['SHA384', 0x20400, (b,c)=>b[c+37]=4], ['hash-width', 0x20400, (b,c)=>b[c+36]=20],
    ['platform', 0x20400, (b,c)=>b[c+38]=1], ['page-zero', 0x20400, (b,c)=>b[c+39]=0],
    ['page-13', 0x20400, (b,c)=>b[c+39]=13], ['spare2', 0x20400, (b,c)=>b[c+40]=1],
    ['scatter', 0x20400, (b,c)=>b[c+44]=1], ['spare3', 0x20400, (b,c)=>b[c+52]=1],
    ['limit64', 0x20400, (b,c)=>b[c+56]=1], ['special-count', 0x20400, (b,c)=>b.writeUInt32BE(12,c+24)],
    ['pre-encrypt', 0x20500, (b,c)=>b[c+92]=1], ['linkage', 0x20600, (b,c)=>b[c+96]=1],
    ['linkage-offset', 0x20600, (b,c)=>b[c+100]=1], ['linkage-size', 0x20600, (b,c)=>b[c+104]=1],
  ];
  for (const [name, version, mutate] of profileChanges) {
    const value = fixture({ version }); mutate(value.bytes,value.cdOffset); rebind(value,{pages:false});
    assert.throws(()=>fullJSExtraction(value.bytes,value.expected),undefined,name);
    arch(`cdf-profile-${name}`,value.bytes,value.expected.cdHash,0);
  }
  for (const slot of [4,6]) {
    const value=fixture(); value.bytes[value.cdOffset+value.hashes-slot*32]=1; rebind(value,{pages:false});
    assert.throws(()=>fullJSExtraction(value.bytes,value.expected));
    arch(`cdf-profile-reserved-slot-${slot}`,value.bytes,value.expected.cdHash,0);
  }
  const allowed=fixture(); allowed.bytes.writeUInt32BE(0x33f02,allowed.cdOffset+12);
  allowed.bytes.writeBigUInt64BE(0x3f1n,allowed.cdOffset+80); allowed.bytes.writeBigUInt64BE(4096n,allowed.cdOffset+72);
  rebind(allowed,{pages:false}); fullJSExtraction(allowed.bytes,allowed.expected);
  arch('cdf-supported-flags-and-exec',allowed.bytes,allowed.expected.cdHash,0,'arm64');
  // First-stage architecture proof is NOT whole artifact/policy validation.
  const laterReject = fixture(); laterReject.bytes[laterReject.rawOffset+8] ^= 1;
  arch('architecture-only-not-library-acceptance', laterReject.bytes, laterReject.expected.cdHash,0,'arm64');
  // Synthetic entitlements blobs, NOT native DER/XML semantic acceptance.
  // Actual full Swift verifiers check their whole-blob special-slot hashes.
  for (const helper of [true,false]) for (const slots of [[],[5],[7],[5,7]]) {
    const extra=slots.map(slot=>[slot,component(slot===5 ? 0xfade7171 : 0xfade7172,Buffer.from('opaque synthetic entitlements'))]);
    if (!helper) extra.push([11,component(0xfade8181,Buffer.from('opaque synthetic policy'))]);
    const b=anchorThin({special:helper ? Math.max(0,...slots) : 11,extra});
    const mapped=encodeBootstrapApprovalRecord(approval()); mapped.copy(b,anchorOffset); rehash(b);
    const cd=anchorCDOffset(b), hash=anchorHash(b.subarray(cd,cd+b.readUInt32BE(cd+4))).subarray(0,20);
    const present=slots.length>0;
    for (const metadata of [
      {name:'missing', want:!present},
      {name:'dictionary', dictionary:{}, want:present},
      {name:'bad-dictionary', dictionary:false, want:false},
      {name:'raw-no-dictionary', raw:'AQID', want:false},
      {name:'raw-unknown-type', dictionary:{}, rawUnknown:true, want:false},
      {name:'raw-and-dictionary', dictionary:{}, raw:'AQID', want:present},
      {name:'forbidden', dictionary:{'com.apple.security.cs.allow-dyld-environment-variables':true},want:false},
    ]) result.push({...metadata,name:`entitlements-${helper}-${slots.join('-')||'absent'}-${metadata.name}`,kind:'entitlements',
      bytes:b.toString('base64'),hash:hash.toString('base64'),offset:'0',mapped:mapped.toString('base64'),helper,
      slots, expected:metadata.want ? {entitlements:true} : reject});
    if (present) {
      // Preliminary hint remains readable, but the unchanged CD special hash
      // rejects the tampered blob before ANY presence/absence policy is used.
      const bad=Buffer.from(b), index=1;
      bad[signatureOffset+bad.readUInt32BE(signatureOffset+16+index*8)+8]^=1;
      result.push({name:`entitlements-tampered-${helper}-${slots.join('-')}`,kind:'entitlements',
        bytes:bad.toString('base64'),hash:hash.toString('base64'),offset:'0',mapped:mapped.toString('base64'),helper,
        dictionary:{},slots,expected:reject});
    }
  }
  const mapped=encodeBootstrapApprovalRecord(approval());
  const empty=anchorThin({cpu:0x01000007}), der=anchorThin({special:7,extra:[[7,component(0xfade7172,Buffer.from('synthetic DER'))]]});
  for (const b of [empty,der]) { mapped.copy(b,anchorOffset); rehash(b); }
  const fat=anchorFat(empty,der,true);
  for (const [part,offset,slots] of [[empty,4096,[]],[der,20480,[7]]]) {
    const cd=anchorCDOffset(part), hash=anchorHash(part.subarray(cd,cd+part.readUInt32BE(cd+4))).subarray(0,20);
    result.push({name:`entitlements-selected-only-${offset}`,kind:'entitlements',bytes:fat.toString('base64'),hash:hash.toString('base64'),
      offset:String(offset),mapped:mapped.toString('base64'),helper:true,slots,expected:slots.length ? reject : {entitlements:true}});
  }
  // Forge absence in the unsigned index while keeping the kernel-bound CD.
  // The preliminary hint is empty; only the mandatory full parser defeats it.
  const hidden=Buffer.from(der), cd=anchorCDOffset(hidden);
  hidden.writeUInt32BE(0x10000,signatureOffset+20);
  const hash=anchorHash(hidden.subarray(cd,cd+hidden.readUInt32BE(cd+4))).subarray(0,20);
  result.push({name:'entitlements-hidden-DER-index',kind:'entitlements',bytes:hidden.toString('base64'),hash:hash.toString('base64'),
    offset:'0',mapped:mapped.toString('base64'),helper:true,slots:[],expected:reject});
  return result;
}
export function sourceGuards() {
  const source = readFileSync(new URL('./BootstrapProcessBinding.swift',import.meta.url),'utf8');
  const code = source.replace(/\/\/[^\n]*/g,'');
  assert(!/getenv|ProcessInfo|URLSession|posix_spawn|\bexecve\b|\bprint\(|\bBroker\s*\(|\bNSLog|kSecCodeInfoArchitecture/.test(code));
  assert(!/trust\.parentValid\(|signedProcess\(|hardenedParentBootstrap\(/.test(code));
  for (const text of ['static func collect(trust: ProcessTrust)', '== BRIAN_KERNEL_UNVERIFIED_DATA',
    'kSecCodeAttributeUniversalFileOffset', 'NSNumber(value: Int32(snapshot.offset))', '.union(.noNetworkAccess)',
    'O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK', 'lstat(path, &s)', 'fstat(fd, &s)', 'Stamp(s) == initial',
    'ProcessIdentity.read(getpid()) == trust.helper', 'ProcessIdentity.read(getppid()) == trust.parent',
    'brian_private_pipes() == 1', 'brian_private_channel_alive() == 1',
    'own.parentUniqueID == parent.uniqueID', 'try BootstrapProcessBinding.unchanged(ownBefore, ownAfter)', 'try BootstrapProcessBinding.unchanged(parentBefore, parentAfter)',
    'Array(hash) == snapshot.hash', 'LibraryConstraintPolicy.compare', 'expectedTeam: trust.team',
    'digest == approval.asarDigest', 'CFBundleVersion', 'hardenedElectronWire(Data(bytes.bytes))']) assert(code.includes(text),text);
  assert(!code.includes('trust.teamRequirement('), 'no broad Apple-issued/team-only signer fallback');
  for (const text of ['static func requirementText(team: String, role: SignerRole)',
    'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
    'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    'BootstrapProcessBinding.requirementText(team: trust.team, role: role)',
    'requirement(own ? .helper : .parent)', 'requirement(.framework)',
    'let forbidden = common + (helper ? electronExceptions : [])']) assert(code.includes(text),text);
  const builder=code.slice(code.indexOf('static func requirementText'),code.indexOf('static func entitlements'));
  assert(!builder.includes(' or ') && !builder.includes('identifier:') && !builder.includes('catch'));
  assert.equal((code.match(/Budget\(start:/g)??[]).length,1, 'one nonresetting clock origin');
  const run = code.slice(code.indexOf('func run()'));
  const sequence = ['try relationship()', 'try sample(true)', 'try sample(false)', 'try BootstrapProcessBinding.validatePair(',
    'try signature(true, ownBefore)', 'try capture(trust.helper.executable', 'try BootstrapProcessBinding.authenticatedImageHeader(own.bytes',
    'BootstrapApproval.copyOwnMappedRecord()', 'BootstrapApproval.bind(', 'try capturedMetadata(ownInfo, image: ownImage, own: true)', 'try signature(false, parentBefore)',
    'try capture(trust.parent.executable', 'try BootstrapProcessBinding.authenticatedImageHeader(parent.bytes', 'MachOLibraryConstraint.extract(',
    'try capturedMetadata(parentInfo, image: parentImage, own: false)', 'LibraryConstraintPolicy.compare(', 'try framework(parentInfo.selected, approval: approval)', 'let finalOwnInfo = try signature(true, ownBefore)',
    'try signature(false, parentBefore)', 'try capturedMetadata(finalOwnInfo, image: ownImage, own: true)',
    'try capturedMetadata(finalParentInfo, image: parentImage, own: false)',
    'try consistentMetadata(ownInfo.associated, finalOwnInfo.associated)', 'try consistentMetadata(ownInfo.selected, finalOwnInfo.selected)',
    'try consistentMetadata(parentInfo.associated, finalParentInfo.associated)', 'try consistentMetadata(parentInfo.selected, finalParentInfo.selected)',
    'try framework(finalParentInfo.selected, approval: approval)', 'let ownAfter = try sample(true)',
    'try BootstrapProcessBinding.unchanged(ownBefore, ownAfter)', 'try relationship(); try tick()', 'return DataResult('];
  let cursor=0;
  for (const step of sequence) { const at=run.indexOf(step,cursor); assert(at>=cursor,step); cursor=at+step.length; }
  const architecture = code.slice(code.indexOf('static func authenticatedArchitecture'),code.indexOf('#if os(macOS)'));
  assert(architecture.indexOf('sample.hash else') < architecture.indexOf('let cpu ='));
  assert(architecture.indexOf('for page in 0..<pages') < architecture.indexOf('let cpu ='));
  for (const flag of ['productionAuthority','controlAdmission','loadedImageAuthentication','nativeEnforcement',
    'frameworkEmbeddedDigestBinding','frameworkFuseBinding','completeInventoryProvenance','nativeSignedAcceptance','cmsAuthentication','atomicSnapshot']) assert(code.includes(`let ${flag} = false`));
  return source;
}
export function run(mode) {
  assert(['--portable','--foundation'].includes(mode)); sourceGuards();
  const cases=vectors(), summary={vectors:cases.length, matches:cases.filter(v=>!v.expected.error).length, swiftRuns:0,
    macOSSyntaxParsed:false, nativeSecurityTypechecked:false};
  if(mode==='--portable') return summary;
  const temp=mkdtempSync(join(tmpdir(),'brian-process-binding-policy-'));
  try {
    const files=[];
    for(const name of ['MachOLibraryConstraint.swift','BootstrapApproval.swift','BootstrapProcessBinding.swift']) {
      const original=readFileSync(new URL('./'+name,import.meta.url),'utf8');
      const changed=original.replace(/^import CryptoKit$/m,'import Crypto');
      assert.equal(changed.replace(/^import Crypto$/m,'import CryptoKit'),original);
      const path=join(temp,name); writeFileSync(path,changed); files.push(path);
    }
    // Parse-only with macOS target activates native syntax, NOT SDK/type checking.
    const parsed=spawnSync('swiftc',['-frontend','-parse','-target','arm64-apple-macos14.0',fileURLToPath(new URL('./BootstrapProcessBinding.swift',import.meta.url))],
      {encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
    assert.equal(parsed.error,undefined); assert.equal(parsed.status,0,parsed.stderr); summary.macOSSyntaxParsed=true;
    const main=join(temp,'main.swift'), input=join(temp,'vectors.json'), exe=join(temp,'policy');
    writeFileSync(main,readFileSync(new URL('./BootstrapProcessBindingPolicyTests.swift',import.meta.url),'utf8'));
    writeFileSync(input,JSON.stringify(cases.map(({expected,...input})=>input)));
    const flags=[];
    for(const key of ['SWIFT_CRYPTO_INCLUDE','SWIFT_CRYPTO_STATIC_INCLUDE','SWIFT_CRYPTO_LIB']) assert(process.env[key]?.startsWith('/'));
    flags.push('-I',process.env.SWIFT_CRYPTO_INCLUDE,'-I',process.env.SWIFT_CRYPTO_STATIC_INCLUDE,
      '-L',process.env.SWIFT_CRYPTO_LIB,'-lCrypto','-Xlinker','-rpath','-Xlinker',process.env.SWIFT_CRYPTO_LIB);
    for(const optimization of [[],['-O']]) {
      const built=spawnSync('swiftc',['-swift-version','5',...optimization,...flags,...files,main,'-o',exe],{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
      assert.equal(built.error,undefined); assert.equal(built.status,0,built.stderr);
      const result=spawnSync(exe,[input],{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
      assert.equal(result.error,undefined); assert.equal(result.status,0,result.stderr);
      const actual=JSON.parse(result.stdout); assert.equal(actual.length,cases.length);
      cases.forEach((v,i)=>assert.deepEqual(actual[i],v.expected,v.name)); summary.swiftRuns++;
    }
    return summary;
  } finally { rmSync(temp,{recursive:true,force:true}); }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { assert.equal(process.argv.length,3); console.log(JSON.stringify(run(process.argv[2])));
    console.log('DATA policies only. No Security API execution/typecheck, live snapshots, native mapped reads, signed SDK acceptance or admission.'); }
  catch(error) { console.error(error.stack); process.exitCode=1; }
}
