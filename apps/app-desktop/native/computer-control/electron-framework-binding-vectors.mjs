// TEST ONLY. Synthetic CD membership is NOT helper-anchor provenance or CMS.
import assert from 'node:assert/strict';
import { thin, fat, rehash, cdOffset, sha, component, anchorOffset, signatureOffset } from '../../scripts/mac-bootstrap-anchor.test-fixtures.mjs';
import { thinFramework, syntheticPageHashes, digestOffset } from '../../scripts/mac-asar-integrity.test-fixtures.mjs';
import { integritySentinel, integrityDictionaryDigest, populateIntegrityDigest, verifyIntegrityDigest } from '../../scripts/mac-asar-integrity.mjs';
import { encodeBootstrapApprovalRecord } from '../../scripts/mac-bootstrap-anchor.mjs';
export const dictionary = { 'Resources/app.asar': { algorithm:'SHA256', hash:'0'.repeat(64) } };
export const digest = integrityDictionaryDigest(dictionary);
const fuse = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
export function framework(options = {}) {
  const b=thin(options); b.writeUInt32LE(6,12);
  b.fill(0,176,192); b.write('__asar_integrity',176); b.writeBigUInt64LE(66n,216); b.writeUInt32LE(0,240);
  b.fill(0,anchorOffset,anchorOffset+1376); integritySentinel.copy(b,anchorOffset);
  b[anchorOffset+32]=1; b[anchorOffset+33]=1; digest.copy(b,anchorOffset+34);
  fuse.copy(b,512); b[544]=1; b[545]=9; b.write('000011011',546);
  return rehash(b);
}
function hash(b, base=0, signature=signatureOffset) {
  const at=base+signature+b.readUInt32BE(base+signature+16), size=b.readUInt32BE(at+4);
  return sha(b.subarray(at,at+size)).subarray(0,20);
}
export function frameworkVectors() {
  const out=[];
  function add(name,b,want=false,options={}) {
    const inventory=options.inventory ?? [hash(b)];
    if (want) assert.equal(verifyIntegrityDigest(b,dictionary),options.count??1,name);
    let record;
    try { record=encodeBootstrapApprovalRecord({electronVersion:'43.2.0',asarDigest:options.digest??digest,
      libraryCDHashes:[...inventory].sort(Buffer.compare)}).toString('base64'); } catch { /* invalid API inventory tested first */ }
    out.push({name,bytes:b.toString('base64'),inventory:inventory.map(x=>x.toString('base64')),record,
      expected:{match:want,count:want?(options.count??1):0}});
  }
  for (const cpu of [0x01000007,0x0100000c]) for (const version of [0x20400,0x20500,0x20600]) for (const page of [12,14])
    add(`profile-${cpu}-${version}-${page}`,framework({cpu,version,page}),true);
  for (const width of [false,true]) {
    const a=framework({cpu:0x01000007}),b=framework(), both=fat(a,b,width);
    add(`fat-${width}`,both,true,{count:2,inventory:[hash(a),hash(b)]});
    add(`partial-inventory-${width}`,both,false,{inventory:[hash(a)]});
    add(`only-second-approved-${width}`,both,false,{inventory:[hash(b)]});
    const different=framework(); different[554]^=1; rehash(different);
    add(`wire-divergence-${width}`,fat(a,different,width),false,{inventory:[hash(a),hash(different)]});
    const changed=framework(); changed[anchorOffset+34]^=1; rehash(changed);
    add(`digest-divergence-${width}`,fat(a,changed,width),false,{inventory:[hash(a),hash(changed)]});
    add(`duplicate-arch-${width}`,fat(b,b,width),false,{inventory:[hash(b)]});
    const overlap=Buffer.from(both); if(width) overlap.writeBigUInt64BE(4096n,48); else overlap.writeUInt32BE(4096,36);
    add(`fat-overlap-${width}`,overlap,false,{inventory:[hash(a),hash(b)]});
    const shadow=Buffer.from(both); fuse.copy(shadow,128);
    add(`fat-padding-fuse-${width}`,shadow,false,{inventory:[hash(a),hash(b)]});
    const shadowAsar=Buffer.from(both); integritySentinel.copy(shadowAsar,128);
    add(`fat-padding-asar-${width}`,shadowAsar,false,{inventory:[hash(a),hash(b)]});
    const bad=Buffer.from(both); bad[20480+700]^=1;
    add(`second-slice-page-${width}`,bad,false,{inventory:[hash(a),hash(b)]});
  }
  // Existing JS fixture geometry/data, not a replacement JS parser. Its default
  // writable segment lacks SG_READ_ONLY: explicitly stricter native rejection.
  for (const cpu of [0x01000007,0x0100000c]) {
    let b=thinFramework(cpu,'000011011'); b=populateIntegrityDigest(b,dictionary); b=syntheticPageHashes(b);
    assert.equal(verifyIntegrityDigest(b,dictionary),1);
    add(`js-writable-${cpu}`,b,false,{inventory:[hash(b,0,8192)]});
    b.writeUInt32LE(0x10,172); b=syntheticPageHashes(b);
    add(`js-data-const-${cpu}`,b,true,{inventory:[hash(b,0,8192)]});
    assert.equal(b.subarray(digestOffset+34,digestOffset+66).equals(digest),true);
  }
  const base=framework(), approved=hash(base);
  for (const [name,inventory] of [ ['empty',[]],['duplicate',[approved,approved]],['short',[Buffer.alloc(19,1)]],
    ['long',[Buffer.alloc(21,1)]],['zero',[Buffer.alloc(20)]],['wrong',[Buffer.alloc(20,1)]],
    ['over64',Array.from({length:65},(_,i)=>Buffer.alloc(20,i+1))] ]) add(`inventory-${name}`,base,false,{inventory});
  const complete=[approved,...Array.from({length:63},(_,i)=>Buffer.alloc(20,i+1))];
  add('inventory-64-membership-not-completeness',base,true,{inventory:complete});
  add('wrong-approved-digest',base,false,{digest:Buffer.alloc(32,1)});
  const changes={
    execute:b=>b.writeUInt32LE(2,12), bundle:b=>b.writeUInt32LE(8,12), cpu:b=>b.writeUInt32LE(7,4), subtype:b=>b.writeUInt32LE(2,8),
    headerReserved:b=>b[28]=1, commandUnknown:b=>b.writeUInt32LE(0x777,32), commandCount:b=>b.writeUInt32LE(3,16),
    missingReadonly:b=>b.writeUInt32LE(0,172), executable:b=>b.writeUInt32LE(7,160), unreadable:b=>b.writeUInt32LE(0,164),
    fileOverlap:b=>b.writeBigUInt64LE(0n,144), vmOverlap:b=>b.writeBigUInt64LE(0n,128),
    vmOverflow:b=>b.writeBigUInt64LE(2n**63n,128), noHeaderMap:b=>b.writeBigUInt64LE(0n,80),
    sectionOwner:b=>b[192]=88, sectionName:b=>b[176]=88, sectionFlags:b=>b.writeUInt32LE(1,240),
    sectionSize:b=>b.writeBigUInt64LE(65n,216), sectionAlignment:b=>b.writeUInt32LE(31,228), sectionVM:b=>b.writeBigUInt64LE(4096n,208),
    sectionReloc:b=>b.writeUInt32LE(1,232), sectionReserved:b=>b.writeUInt32LE(1,244), sectionHeaders:b=>b.writeUInt32LE(32,224),
    asarMarker:b=>b[anchorOffset]^=1, unused:b=>b[anchorOffset+32]=0, used2:b=>b[anchorOffset+32]=2,
    asarVersion:b=>b[anchorOffset+33]=2, asarDigest:b=>b[anchorOffset+65]^=1,
    duplicateAsar:b=>integritySentinel.copy(b,700), duplicateFuse:b=>fuse.copy(b,700),
    fuseMarker:b=>b[512]^=1, fuseVersion:b=>b[544]=2, fuseCount7:b=>b[545]=7, fuseCount10:b=>b[545]=10,
    fuseRemoved:b=>b[547]=0x72, fuseBinary:b=>b[547]=1,
    fuseUnsigned:b=>{ b.fill(0,512,555); fuse.copy(b,signatureOffset+1500); b[signatureOffset+1532]=1; b[signatureOffset+1533]=9; b.write('000011011',signatureOffset+1534); },
    fuseUnmapped:b=>b.writeBigUInt64LE(400n,80),
  };
  for (const index of [0,2,3,4,5]) changes[`fuse-policy-${index}`]=b=>b[546+index]^=1;
  for (const [name,change] of Object.entries(changes)) { const b=framework(); change(b); rehash(b); add(`rebound-${name}`,b); }
  // Read-only without data-const flag is also safe geometry, not live VM proof.
  const ro=framework(); ro.writeUInt32LE(0,172); ro.writeUInt32LE(1,160); ro.writeUInt32LE(1,164); rehash(ro); add('readonly',ro,true);
  const eight=framework(); eight[545]=8; eight[554]=0; rehash(eight); add('eight-state-wire',eight,true);
  for (const at of [0,4,12,32,112,176,512,544,546,700,anchorOffset,anchorOffset+34,4095,4096,8191,12287]) {
    const b=Buffer.from(base); b[at]^=1; add(`unrehashed-page-${at}`,b,false,{inventory:[approved]});
  }
  const cdChanges={version:b=>b.writeUInt32BE(0x20700,cdOffset(b)+8),algorithm:b=>b[cdOffset(b)+37]=1,
    width:b=>b[cdOffset(b)+36]=20, scatter:b=>b[cdOffset(b)+47]=1, preEncrypt:b=>b[cdOffset(b)+95]=1,
    flags:b=>b.writeUInt32BE(0x80000000,cdOffset(b)+12), exec:b=>b.writeBigUInt64BE(0x400n,cdOffset(b)+80),
    limit:b=>b.writeUInt32BE(4096,cdOffset(b)+32), hashOffset:b=>b.writeUInt32BE(1,cdOffset(b)+16),
    pageCount:b=>b.writeUInt32BE(1,cdOffset(b)+28), ident:b=>b.writeUInt32BE(8,cdOffset(b)+20),
    specialCount:b=>b.writeUInt32BE(12,cdOffset(b)+24), pageHash:b=>b[cdOffset(b)+b.readUInt32BE(cdOffset(b)+16)]^=1};
  for (const [name,change] of Object.entries(cdChanges)) {const b=framework({version:0x20500}); change(b); add(`cd-${name}`,b);}
  for (const slot of [2,5,7,8,9,10,11]) {
    const magic=slot===2?0xfade0c01:slot===5?0xfade7171:slot===7?0xfade7172:0xfade8181;
    const b=framework({special:slot,extra:[[slot,component(magic,Buffer.from('synthetic blob'))]]}); add(`special-${slot}`,b,true);
    const bad=Buffer.from(b), at=signatureOffset+bad.readUInt32BE(signatureOffset+24); bad[at+8]^=1;
    add(`special-tamper-${slot}`,bad,false,{inventory:[hash(b)]});
  }
  for (const slot of [0,0x1000,99]) add(`duplicate-alternate-unknown-${slot}`,framework({extra:[[slot,component(0xfade0c02,Buffer.alloc(88))]]}));
  for (const n of [0,1,31,32,343,4096,12288,14335]) add(`truncated-${n}`,base.subarray(0,n),false,{inventory:[approved]});
  add('trailing',Buffer.concat([base,Buffer.alloc(1)]),false,{inventory:[approved]});
  // Fully framed opaque CMS can carry arbitrary bytes but is NOT authenticated
  // by the approved CD. A wire there must not satisfy signed-page coverage.
  const cmsWire=Buffer.concat([fuse,Buffer.from([1,9]),Buffer.from('000011011')]);
  const outside=framework({extra:[[0x10000,component(0xfade0b01,cmsWire)]]});
  outside.fill(0,512,555); rehash(outside); add('fuse-in-opaque-CMS',outside);
  const cmsAsar=framework({extra:[[0x10000,component(0xfade0b01,integritySentinel)]]});
  add('shadow-asar-in-opaque-CMS',cmsAsar);
  for(const alias of [false,true]) {
    const b=framework(); b.copy(b,336,256,344); b.copy(b,256,176,256);
    b.writeUInt32LE(232,108); b.writeUInt32LE(2,168); b.writeUInt32LE(392,20);
    if(alias) {b.fill(0,256,272); b.write('__other',256);}
    rehash(b); add(alias?'overlapping-sections':'duplicate-asar-section',b);
  }
  for(const flags of [1,2,4,8,0x20]) {const b=framework(); b.writeUInt32LE(flags,100); rehash(b); add(`unsupported-text-mapping-${flags}`,b);}
  for(let i=0;i<32;i++) {const b=framework(); b[anchorOffset+34+i]^=1; rehash(b); add(`rebound-digest-byte-${i}`,b);}
  // Unpinned states still must be binary and identical across architectures.
  for(const width of [8,9]) for(let mask=0;mask<(width===8?8:16);mask++) {
    const b=framework(); b[545]=width;
    for(const [bit,index] of [1,6,7,8].entries()) if(index<width) b[546+index]=0x30+((mask>>bit)&1);
    if(width===8) b[554]=0;
    rehash(b); add(`supported-wire-${width}-${mask}`,b,true);
  }
  return out;
}
