// TEST ONLY. Use the exact normal Nix environment documented at the top of
// macho-library-constraint.mjs, changing only the final script to this file.
// --portable: JS/source only. --foundation-crypto: temporary single-line CryptoKit
// -> official swift-crypto import substitution; real SHA256, no production fallback.
// --foundation-cryptokit: original imports; actual Mac SDK acceptance still separate.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bootstrapVectors } from './bootstrap-approval-swift-vectors.mjs';
import { machoSourceGuards } from './macho-library-constraint.mjs';
import { emptyBootstrapApprovalRecord } from '../../scripts/mac-bootstrap-anchor.mjs';
export function bootstrapSourceGuards() {
  const macho = machoSourceGuards();
  const source = readFileSync(new URL('./BootstrapApproval.swift', import.meta.url), 'utf8');
  const code = source.replace(/\/\/[^\n]*/g, '');
  assert.equal((code.match(/^import .*$/gm) ?? []).join('\n'), 'import Foundation');
  assert(!/FileHandle|FileManager|ProcessInfo|CommandLine|Data\(contentsOf|URL\(|getenv|print\(|csops|SecCode|Unsafe|bytesNoCopy|#if|canImport|fatalError|precondition|try!|as!|Codable/.test(code));
  for (const text of ['static func bind(capturedHelper:', 'static func decode(record:', 'let recordSize = 1376',
    'let electronVersion = "43.2.0"', 'previous.lexicographicallyPrecedes(hash)', 'count <= 64',
    'let asarDigest: [UInt8]', 'let libraryCDHashes: [[UInt8]]', '@inline(never)', 'encodedMarker',
    "from C's volatile OWN mapped getter", 'disk-derived CDHash', 'flags/entitlements']) assert(source.includes(text), text);
  for (const flag of ['productionAuthority', 'cmsAuthentication', 'staticSignerAuthentication', 'kernelProvenanceAuthentication',
    'mappedRecordProvenanceAuthentication', 'nativeEnforcement', 'loadedImageAuthentication']) assert(source.includes(`let ${flag} = false`));
  for (const text of ['special <= 11', 'guard special == 11', 'segflags == 0x10', '(flags == 0 || flags == 0x10000000)',
    'alignment == 4', 'headerMappings == 1', 'try disjoint(vmSections)', 'try disjoint(sections + [sig])',
    'equal(region, mapped)', 'BootstrapApproval.matchesMarker', 'locations.remove(at)', 'length <= sig.offset - offset',
    'capturedHelper.count <= 128 * 1024 * 1024', 'sig.size <= 8 * 1024 * 1024']) assert(macho.includes(text), text);
  return { macho, source };
}
export function runBootstrapTests(mode) {
  assert(['--portable', '--foundation-crypto', '--foundation-cryptokit'].includes(mode));
  const { macho, source } = bootstrapSourceGuards(), vectors = bootstrapVectors();
  const summary = { vectors: vectors.length, matches: vectors.filter(v => v.expected.match).length,
    bindingVectors: vectors.filter(v => v.mode === 'bind').length,
    bindingMatches: vectors.filter(v => v.mode === 'bind' && v.expected.match).length,
    swiftExecutions: 0, compiledMarkerAbsent: false };
  if (mode === '--portable') return summary;
  const temp = mkdtempSync(join(tmpdir(), 'brian-bootstrap-swift-'));
  try {
    const generated = mode === '--foundation-crypto' ? macho.replace(/^import CryptoKit$/m, 'import Crypto') : macho;
    if (mode === '--foundation-crypto') assert.equal(generated.replace(/^import Crypto$/m, 'import CryptoKit'), macho);
    const main = join(temp, 'main.swift'), input = join(temp, 'vectors.json'), binary = join(temp, 'test');
    const machoFile = join(temp, 'MachOLibraryConstraint.swift'), approvalFile = join(temp, 'BootstrapApproval.swift');
    writeFileSync(machoFile, generated); writeFileSync(approvalFile, source);
    // Separate compilation units match build.sh and catch accidental fileprivate
    // dependencies hidden by a concatenated test main.swift.
    writeFileSync(main, readFileSync(new URL('./BootstrapApprovalBindingTests.swift', import.meta.url), 'utf8'));
    writeFileSync(input, JSON.stringify(vectors.map(({ expected, ...input }) => input)));
    const flags = [];
    if (mode === '--foundation-crypto') {
      for (const key of ['SWIFT_CRYPTO_INCLUDE', 'SWIFT_CRYPTO_STATIC_INCLUDE', 'SWIFT_CRYPTO_LIB'])
        assert(process.env[key]?.startsWith('/') && !process.env[key].includes('\0'), `${key} required`);
      flags.push('-I', process.env.SWIFT_CRYPTO_INCLUDE, '-I', process.env.SWIFT_CRYPTO_STATIC_INCLUDE,
        '-L', process.env.SWIFT_CRYPTO_LIB, '-lCrypto', '-Xlinker', '-rpath', '-Xlinker', process.env.SWIFT_CRYPTO_LIB);
    }
    // Typecheck the actual own-symbol Swift/C bridge against the production
    // bridging header. This does NOT execute C, establish Darwin ABI/layout, or
    // fabricate a replacement source for the mapped approval record.
    const bridge = spawnSync('swiftc', ['-swift-version', '5', ...flags, '-typecheck', '-import-objc-header',
      fileURLToPath(new URL('./ProcessIdentity.h', import.meta.url)), machoFile, approvalFile,
      fileURLToPath(new URL('./BootstrapApprovalReader.swift', import.meta.url))],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(bridge.error, undefined); assert.equal(bridge.status, 0, bridge.stderr);
    for (const optimization of [[], ['-O']]) {
      const compiled = spawnSync('swiftc', ['-swift-version', '5', ...optimization, ...flags, machoFile, approvalFile, main, '-o', binary],
        { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(compiled.error, undefined); assert.equal(compiled.status, 0, compiled.stderr);
      // This standalone Swift test executable has NO C anchor. It must contain
      // ZERO plaintext markers, including with production optimization enabled.
      assert(!readFileSync(binary).includes(emptyBootstrapApprovalRecord().subarray(0, 32)), 'Swift emitted duplicate plaintext marker');
      const run = spawnSync(binary, [input], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(run.error, undefined); assert.equal(run.status, 0, run.stderr);
      const actual = JSON.parse(run.stdout); assert.equal(actual.length, vectors.length);
      for (let i = 0; i < vectors.length; i++) assert.deepEqual(actual[i], vectors[i].expected, vectors[i].name);
      summary.swiftExecutions++;
    }
    summary.compiledMarkerAbsent = true;
    return summary;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3);
    const summary = runBootstrapTests(process.argv[2]); console.log(JSON.stringify(summary));
    console.log(summary.swiftExecutions ? 'PASS actual Swift 5 SHA256, unoptimized and -O; data binding only, NOT macOS signer/mapping/enforcement acceptance.'
      : 'PASS JS oracle/source only; SKIP Swift execution. No native acceptance.');
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
