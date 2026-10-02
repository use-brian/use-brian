// Linux ONLY, transparent source-injected fake CF/CommonCrypto ABI/control-flow
// harness. NOT a macOS SDK build, real CMS test, crypto implementation or native
// acceptance proof. Temporary binary is NEVER placed at the production tool path.
// CommonCrypto mock checks every file byte against an independent Node fixture;
// one-shot request hashing is deliberately a fixed test sentinel, NOT real SHA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { encodeVerifierRequest } from './mac-bootstrap-inventory-verifier.mjs';
import { extractMachOLibraryData, canonicalElectronLibrary } from './mac-bootstrap-inventory.mjs';
import { universal } from './mac-bootstrap-inventory.test-fixtures.mjs';
const cBytes = b => `{${[...b].join(',')}}`, sha = b => createHash('sha256').update(b).digest();
const sourceURL = new URL('../native/computer-control/BootstrapInventoryVerifier.c', import.meta.url);
test('production source rejects non-Darwin compilation; injected fake-CF C harness exercises binding/refusal only', { skip: process.platform !== 'linux' }, t => {
  const compiler = '/bin/cc'; if (!fs.existsSync(compiler)) { t.skip('portable C compiler unavailable'); return; }
  const refused = spawnSync(compiler, ['-fsyntax-only', sourceURL.pathname], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /requires macOS Security/);
  const temp = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'inventory-fake-cf-'))); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'Use Brian.app'), leaf = join(root, canonicalElectronLibrary), bytes = universal();
  fs.mkdirSync(dirname(leaf), { recursive: true, mode: 0o700 }); fs.writeFileSync(leaf, bytes, { mode: 0o600 });
  const arches = extractMachOLibraryData(bytes, ['arm64', 'x86_64']).architectures;
  const context = { appRoot: root, teamIdentifier: 'ABCDEFGHIJ', architectures: ['arm64', 'x86_64'], capturedTreeSHA256: '23'.repeat(32),
    libraries: [{ relativePath: canonicalElectronLibrary, fileSize: bytes.length, fileSHA256: sha(bytes).toString('hex'),
      architectures: arches.map(a => ({ architecture: a.architecture, sliceOffset: a.sliceOffset, sliceSize: a.sliceSize, cdHash: a.cdHash, codeDirectorySHA256: a.codeDirectorySHA256 })) }] };
  const encoded = encodeVerifierRequest(context), offsets = arches.map(a => a.sliceOffset), hashes = arches.map(a => Buffer.from(a.cdHash, 'hex'));
  const mock = `
#define _GNU_SOURCE 1
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <string.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <limits.h>
static int test_mode, creates, checks, offset = -1, selected, hashed, version_seen;
static uid_t fixture_getuid(void) { return 501; }
#define getuid fixture_getuid
#define geteuid fixture_getuid
#define st_mtimespec st_mtim
#define st_ctimespec st_ctim
static const char expected_leaf[] = ${JSON.stringify(leaf)};
static const char expected_target[] = ${JSON.stringify(join(root, 'Contents/Frameworks/Electron Framework.framework'))};
static const uint8_t expected_file[] = ${cBytes(bytes)};
static const uint8_t file_digest[32] = ${cBytes(sha(bytes))};
static const uint8_t slice_hashes[2][20] = {${hashes.map(cBytes).join(',')}};
static const int offsets[2] = {${offsets.join(',')}};
typedef unsigned char UInt8; typedef unsigned int CC_LONG; typedef long CFIndex; typedef unsigned long CFTypeID;
typedef const void *CFTypeRef; typedef uint32_t SecCSFlags; typedef int32_t OSStatus;
typedef struct Obj { int type, number; const uint8_t *bytes; size_t length; char text[PATH_MAX]; } Obj;
typedef const Obj *CFStringRef; typedef Obj *CFMutableDictionaryRef; typedef const Obj *CFDictionaryRef;
typedef const Obj *CFNumberRef; typedef const Obj *CFDataRef; typedef const Obj *CFURLRef; typedef const Obj *CFArrayRef;
typedef const Obj *SecStaticCodeRef; typedef const Obj *SecRequirementRef;
enum { STRING=1, NUMBER=2, DATA=3, URL=4, ARRAY=5, DICT=6, CODE=7, REQUIREMENT=8 };
enum { kCFNumberIntType=9, kCFNumberSInt32Type=3, kCFStringEncodingASCII=0x600,
 kSecCSDefaultFlags=0, kSecCSSigningInformation=2, kSecCSStrictValidate=16, kSecCSCheckAllArchitectures=1, kSecCSNoNetworkAccess=1<<29, errSecSuccess=0 };
static const int kCFTypeDictionaryKeyCallBacks=0, kCFTypeDictionaryValueCallBacks=0;
static const Obj keys[8] = {{0}};
#define kSecCodeInfoDigestAlgorithm (&keys[0])
#define kSecCodeInfoUnique (&keys[1])
#define kSecCodeInfoDigestAlgorithms (&keys[2])
#define kSecCodeInfoCdHashes (&keys[3])
#define kSecCodeInfoTeamIdentifier (&keys[4])
#define kSecCodeInfoMainExecutable (&keys[5])
#define kSecCodeAttributeUniversalFileOffset (&keys[6])
#define kSecCodeAttributeBundleVersion (&keys[7])
static Obj attrs={.type=DICT}, info={.type=DICT}, num={.type=NUMBER}, algorithm={.type=NUMBER,.number=2}, str={.type=STRING};
static Obj target_url={.type=URL}, leaf_url={.type=URL}, team_value={.type=STRING}, unique={.type=DATA};
static Obj algorithms={.type=ARRAY,.number=1}, hashes_array={.type=ARRAY,.number=2}, code={.type=CODE}, req={.type=REQUIREMENT};
static CFTypeID CFGetTypeID(CFTypeRef v) { return (CFTypeID)((const Obj *)v)->type; }
static CFTypeID CFNumberGetTypeID(void) { return NUMBER; }
static CFTypeID CFDataGetTypeID(void) { return DATA; }
static CFTypeID CFDictionaryGetTypeID(void) { return DICT; }
static CFTypeID CFArrayGetTypeID(void) { return ARRAY; }
static CFTypeID CFStringGetTypeID(void) { return STRING; }
static CFTypeID CFURLGetTypeID(void) { return URL; }
static int CFNumberIsFloatType(CFNumberRef v) { (void)v; return test_mode==3; }
static int CFNumberGetValue(CFNumberRef v, int type, void *out) { if(type!=kCFNumberSInt32Type || test_mode==4) return 0; *(int32_t *)out=v->number; return 1; }
static CFIndex CFDataGetLength(CFDataRef v) { return (CFIndex)v->length; }
static const UInt8 *CFDataGetBytePtr(CFDataRef v) { return v->bytes; }
static CFIndex CFArrayGetCount(CFArrayRef v) { (void)v; return test_mode==5 ? 2 : 1; }
static CFTypeRef CFArrayGetValueAtIndex(CFArrayRef v, CFIndex i) { if(i) return NULL; return v->number==1 ? &algorithm : &unique; }
static int CFStringGetCString(CFStringRef v, char *out, CFIndex cap, int encoding) { (void)encoding; if(strlen(v->text)>=(size_t)cap) return 0; strcpy(out,v->text); return 1; }
static int CFURLGetFileSystemRepresentation(CFURLRef v, bool resolve, UInt8 *out, CFIndex cap) { (void)resolve; if(strlen(v->text)>=(size_t)cap) return 0; strcpy((char *)out,v->text); return 1; }
static CFTypeRef CFDictionaryGetValue(CFDictionaryRef d, CFTypeRef key) {
 if(d!=&info) return NULL;
 if(key==kSecCodeInfoDigestAlgorithm) return &algorithm; if(key==kSecCodeInfoUnique) return &unique;
 if(key==kSecCodeInfoDigestAlgorithms) return &algorithms; if(key==kSecCodeInfoCdHashes) return &hashes_array;
 if(key==kSecCodeInfoTeamIdentifier) return &team_value; if(key==kSecCodeInfoMainExecutable) return &leaf_url; return NULL;
}
static CFURLRef CFURLCreateFromFileSystemRepresentation(void *a,const UInt8 *p,CFIndex n,bool directory) {
 (void)a; if(!directory || n>=(CFIndex)sizeof(target_url.text)) return NULL; memcpy(target_url.text,p,(size_t)n); target_url.text[n]=0; return &target_url;
}
static CFNumberRef CFNumberCreate(void *a,int type,const void *value) { (void)a; if(type!=kCFNumberIntType) return NULL; num.number=*(const int *)value; return &num; }
static CFMutableDictionaryRef CFDictionaryCreateMutable(void *a,CFIndex cap,const void *k,const void *v) { (void)a;(void)cap;(void)k;(void)v;offset=-1;version_seen=0; return &attrs; }
static void CFDictionarySetValue(CFMutableDictionaryRef d,CFTypeRef key,CFTypeRef value) {
 if(d!=&attrs) abort(); if(key==kSecCodeAttributeUniversalFileOffset) offset=((const Obj *)value)->number;
 else if(key==kSecCodeAttributeBundleVersion && !strcmp(((const Obj *)value)->text,"A")) version_seen=1; else abort();
}
static CFStringRef CFStringCreateWithCString(void *a,const char *s,int encoding) { (void)a;(void)encoding; if(strlen(s)>=sizeof(str.text))return NULL;strcpy(str.text,s);return &str; }
static void CFRelease(CFTypeRef value) { (void)value; }
static OSStatus SecRequirementCreateWithString(CFStringRef s,SecCSFlags flags,SecRequirementRef *out) {
 const char *expected="anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \\\"ABCDEFGHIJ\\\"";
 if(flags || strcmp(s->text,expected) || test_mode==6) return -1; *out=&req; return 0;
}
static OSStatus SecStaticCodeCreateWithPathAndAttributes(CFURLRef u,SecCSFlags flags,CFDictionaryRef a,SecStaticCodeRef *out) {
 creates++; selected=offset==offsets[0]?0:offset==offsets[1]?1:-1;
 if(flags || a!=&attrs || strcmp(u->text,expected_target) || !version_seen || selected<0 || test_mode==7) return -1; *out=&code;return 0;
}
static OSStatus SecStaticCodeCheckValidity(SecStaticCodeRef c,SecCSFlags flags,SecRequirementRef r) {
 if(c!=&code || r!=&req || flags!=(kSecCSStrictValidate|kSecCSCheckAllArchitectures|kSecCSNoNetworkAccess) || checks+1!=creates ||
  (checks>=2 && !hashed) || test_mode==8 || (test_mode==9 && creates>2)) return -1;
 if ((test_mode==21 && checks==0) || (test_mode==22 && checks==2)) {
  const struct timespec times[2]={{1900000000,0},{1900000000,0}};
  if (utimensat(AT_FDCWD,expected_leaf,times,0)) return -1;
 }
 checks++; return 0;
}
static OSStatus SecCodeCopySigningInformation(SecStaticCodeRef c,SecCSFlags flags,CFDictionaryRef *out) {
 if(c!=&code || flags!=kSecCSSigningInformation || test_mode==10) return -1;
 algorithm.number=test_mode==11?3:2;unique.bytes=slice_hashes[(test_mode==12 || (test_mode==13 && creates>2)) ? 1-selected : selected];
 unique.length=test_mode==14?32:20; unique.type=test_mode==15?NUMBER:DATA;
 strcpy(team_value.text,test_mode==16?"ZZZZZZZZZZ":"ABCDEFGHIJ");strcpy(leaf_url.text,test_mode==17?"/nonexistent-test-file":expected_leaf);
 if(test_mode==18) team_value.type=DATA; *out=&info;return 0;
}
typedef struct { size_t at; int bad; } CC_SHA256_CTX;
static int CC_SHA256_Init(CC_SHA256_CTX *c) { c->at=0;c->bad=0;return test_mode!=19; }
static int CC_SHA256_Update(CC_SHA256_CTX *c,const void *p,CC_LONG n) {
 if(checks!=2 || c->at+n>sizeof(expected_file) || memcmp(p,expected_file+c->at,n)) return 0; c->at+=n;return 1;
}
static int CC_SHA256_Final(unsigned char *out,CC_SHA256_CTX *c) { if(c->at!=sizeof(expected_file)||c->bad||test_mode==20)return 0;memcpy(out,file_digest,32);hashed=1;return 1; }
static unsigned char *CC_SHA256(const void *p,CC_LONG n,unsigned char *out) { (void)p;(void)n;if(checks!=4||creates!=4||!hashed)return NULL;memset(out,0xbb,32);return out; }
`;
  // Only the fake requirement C literal escaping is normalized here.
  const prelude = mock.replaceAll('\\\\\\"', '\\"');
  let production = fs.readFileSync(sourceURL, 'utf8').replace(/#if !defined\(__APPLE__\)[\s\S]*?#endif\n/, '')
    .replace(/^#include <(?:CoreFoundation|Security|CommonCrypto)\/[^>]+>\n/gm, '').replace('int main(int argc, char **argv)', 'int injected_native_main(int argc, char **argv)');
  const cpath = join(temp, 'injected.c'), binary = join(temp, 'injected-verifier');
  fs.writeFileSync(cpath, prelude + '\n#pragma GCC diagnostic error "-Wmisleading-indentation"\n' + production + '\nint main(int argc,char **argv) {test_mode=argc==2?atoi(argv[1]):0;return injected_native_main(1,argv);}\n');
  const compile = spawnSync(compiler, ['-std=c11', '-O1', '-Wall', '-Wextra', '-Werror', '-Wno-misleading-indentation', cpath, '-o', binary], { timeout: 20000, maxBuffer: 65536 });
  // Compiler diagnostics stay private; local temp file is only for test debugging.
  if (compile.status !== 0) fs.writeFileSync(join(temp, 'compiler-private.txt'), compile.stderr ?? '');
  assert.equal(compile.status, 0, 'injected C mock ABI harness compilation');
  const run = (input, mode = 0) => spawnSync(binary, [String(mode)], { input, timeout: 5000, maxBuffer: 4096 });
  const good = run(encoded.request); assert.equal(good.status, 0, 'fake CF only: complete control flow');
  assert.equal(good.stdout.length, 88); assert.equal(good.stderr.length, 0); assert.deepEqual(good.stdout.subarray(24, 56), Buffer.alloc(32, 0xbb));
  for (let mode = 3; mode <= 22; mode++) { const result = run(encoded.request, mode); assert.equal(result.status, 74, `fake CF refusal mode ${mode}`); assert.equal(result.stdout.length, 0); assert.equal(result.stderr.length, 0); if (mode >= 21) fs.writeFileSync(leaf, bytes); }
  const entry = 96 + encoded.request.readUInt16BE(20), slice = entry + 52 + encoded.request.readUInt16BE(entry+4) + encoded.request.readUInt16BE(entry+6) + encoded.request.readUInt16BE(entry+8);
  for (const position of [0, 8, 10, 12, 16, 18, 19, 20, 22, entry, entry+4, entry+6, entry+8, entry+10, entry+11, entry+12, entry+20, slice, slice+1, slice+4, slice+12, slice+20, slice+40]) {
    const changed = Buffer.from(encoded.request); changed[position] ^= 0x80; const result = run(changed);
    assert.equal(result.status, 74, `wire mutation at ${position}`); assert.equal(result.stdout.length, 0); assert.equal(result.stderr.length, 0);
  }
  for (const changed of [encoded.request.subarray(0, 15), encoded.request.subarray(0, -1), Buffer.concat([encoded.request, Buffer.from([0])])]) assert.equal(run(changed).status, 74);
  const wrongFile = Buffer.from(bytes); wrongFile[200] ^= 1; fs.writeFileSync(leaf, wrongFile); assert.equal(run(encoded.request).status, 74); fs.writeFileSync(leaf, bytes);
  const saved = leaf + '.saved'; fs.renameSync(leaf, saved); fs.symlinkSync(saved, leaf); assert.equal(run(encoded.request).status, 74);
  fs.unlinkSync(leaf); fs.renameSync(saved, leaf); const hardlink = leaf + '.hard'; fs.linkSync(leaf, hardlink); assert.equal(run(encoded.request).status, 74); fs.unlinkSync(hardlink);
  const executable = Buffer.from(bytes); for (const a of arches) executable.writeUInt32LE(2, a.sliceOffset + 12); fs.writeFileSync(leaf, executable); assert.equal(run(encoded.request).status, 74);
});
