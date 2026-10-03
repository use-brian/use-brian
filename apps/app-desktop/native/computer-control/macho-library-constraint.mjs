// TEST ONLY. --portable is source + independently labeled JS vectors, NOT Swift.
// --foundation-crypto generates ONE import replacement (CryptoKit -> Apple's
// swift-crypto Crypto module) in temp main.swift for Linux, never in production.
// --foundation-cryptokit uses the unmodified macOS import; no new Mac bundle.
// Linux reproducible environment (Swift 5 language mode, REAL SHA256):
// nix --extra-experimental-features 'nix-command flakes' develop --impure --expr '
// let p=import (builtins.getFlake "nixpkgs").outPath {}; in p.mkShell {
// nativeBuildInputs=[p.swiftPackages.swift]; buildInputs=[p.swiftPackages.stdlib
// p.swiftPackages.swift-corelibs-foundation p.swiftPackages.swift-corelibs-libdispatch
// p.swiftPackages.swift-foundation p.swiftPackages.swift-crypto p.swiftPackages.swift-asn1];
// SWIFT_CRYPTO_INCLUDE="${p.swiftPackages.swift-crypto.dev}/lib/swift/linux";
// SWIFT_CRYPTO_STATIC_INCLUDE="${p.swiftPackages.swift-crypto.dev}/lib/swift_static/linux";
// SWIFT_CRYPTO_LIB="${p.swiftPackages.swift-crypto}/lib";
// LD_LIBRARY_PATH=p.lib.makeLibraryPath [p.swiftPackages.swift-asn1];
// }' --command node apps/app-desktop/native/computer-control/macho-library-constraint.mjs --foundation-crypto
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { machoVectors, oracle } from './macho-library-constraint-vectors.mjs';
import { verifyLibraryConstraintPolicy } from '../../scripts/mac-library-constraints.mjs';

export function machoSourceGuards() {
  const source = readFileSync(new URL('./MachOLibraryConstraint.swift', import.meta.url), 'utf8');
  const code = source.replace(/\/\/[^\n]*/g, '');
  assert.equal((source.match(/^import CryptoKit$/gm) ?? []).length, 1);
  for (const item of ['SHA256.hash(data:', 'Array(digest(cd).prefix(20))', 'hash == expectedHash',
    'let mainCDHash: [UInt8]', 'let activeSliceOffset: UInt64', 'struct MainImageContext',
    'actual', 'for page in 0..<pages', 'equal(embedded, digest(blob))', 'case rejected',
    'signature.end == view.size', 'limit == signature.offset', 'special == 11',
    'hashes + pages * 32 == cd.size', 'hashStart >= header', 'try gaps(boundedSB, ranges, includeTail: true)',
    'let bytes: [UInt8]', 'result.append(byte)', 'artifactBytes = 512 * 1024 * 1024',
    'signatureBytes = 16 * 1024 * 1024', 'constraintBytes = 4096', 'for slice in all']) assert(source.includes(item), item);
  assert(!/FileHandle|FileManager|ProcessInfo|CommandLine|Data\(contentsOf|URL\(|getenv|print\(|csops|SecCode|Unsafe|bytesNoCopy|#if|canImport|fatalError|precondition|try!|as!/.test(code));
  const kernelInput = code.slice(code.indexOf('struct KernelExpectation'), code.indexOf('struct MainImageContext'));
  assert(!/size|subtype|cpu|path/i.test(kernelInput), 'No claim that kernel snapshot supplies file size/subtype/path-based signing evidence');
  for (const flag of ['productionAuthority', 'cmsAuthentication', 'nativeEnforcement', 'loadedImageAuthentication']) assert(source.includes(`let ${flag} = false`));
  assert(source.includes('let policyStatus = "unsupported"'));
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  // Parent may compile/link these data-only modules unused; admission must stay disabled.
  assert(helper.includes('dispatcher.response(request, clock: sourceClock)')); assert(helper.includes('let dispatcher = ObservationDispatcher { Broker(trust: trust) }'));
  assert.throws(() => verifyLibraryConstraintPolicy(), { code: 'ERR_MAC_LIBRARY_CONSTRAINT_POLICY_UNSUPPORTED' });
  return source;
}
export function runMachOTests(mode) {
  assert(['--portable', '--foundation-crypto', '--foundation-cryptokit'].includes(mode), 'One explicit test mode required');
  const original = machoSourceGuards(), vectors = machoVectors(), expected = vectors.map(oracle);
  const summary = { vectors: vectors.length, matches: vectors.filter(v => v.want).length,
    narrowerNativeRejections: vectors.filter(v => v.jsWant && !v.want).length, swiftExecuted: false };
  if (mode === '--portable') return summary;
  const temp = mkdtempSync(join(tmpdir(), 'brian-macho-constraint-tests-'));
  try {
    const source = mode === '--foundation-crypto' ? original.replace(/^import CryptoKit$/m, 'import Crypto') : original;
    if (mode === '--foundation-crypto') assert.equal(source.replace(/^import Crypto$/m, 'import CryptoKit'), original);
    const main = join(temp, 'main.swift'), binary = join(temp, 'macho-tests'), input = join(temp, 'vectors.json');
    writeFileSync(main, source + '\n' + readFileSync(new URL('./BootstrapApproval.swift', import.meta.url), 'utf8') + '\n' + readFileSync(new URL('./LibraryConstraintPolicy.swift', import.meta.url), 'utf8') + '\n' + readFileSync(new URL('./MachOLibraryConstraintTests.swift', import.meta.url), 'utf8'));
    // Never give the Swift process expected verdicts or JavaScript size guesses.
    writeFileSync(input, JSON.stringify(vectors.map(({ name, bytes, cdHash, offset, architecture, compareObservedPolicy }) =>
      ({ name, bytes, cdHash, offset, architecture, compareObservedPolicy }))));
    // Compiler/module configuration ONLY in this test runner, never parser flags.
    // Nix exports these explicit paths from the installed swift-crypto package.
    const cryptoFlags = [];
    if (mode === '--foundation-crypto') {
      for (const key of ['SWIFT_CRYPTO_INCLUDE', 'SWIFT_CRYPTO_STATIC_INCLUDE', 'SWIFT_CRYPTO_LIB'])
        assert(process.env[key]?.startsWith('/') && !process.env[key].includes('\0'), `${key} required for Linux test compilation`);
      cryptoFlags.push('-I', process.env.SWIFT_CRYPTO_INCLUDE, '-I', process.env.SWIFT_CRYPTO_STATIC_INCLUDE, '-L', process.env.SWIFT_CRYPTO_LIB,
        '-lCrypto', '-Xlinker', '-rpath', '-Xlinker', process.env.SWIFT_CRYPTO_LIB);
    }
    const compiled = spawnSync('swiftc', ['-swift-version', '5', ...cryptoFlags, main, '-o', binary], { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(compiled.error, undefined, 'Swift compiler unavailable/timed out');
    assert.equal(compiled.status, 0, `Swift compile failed:\n${compiled.stderr}`);
    const ran = spawnSync(binary, [input], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(ran.error, undefined, 'Swift execution unavailable/timed out');
    assert.equal(ran.status, 0, `Swift harness failed:\n${ran.stderr}`);
    const actual = JSON.parse(ran.stdout);
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < actual.length; ++i) assert.deepEqual(actual[i], expected[i], vectors[i].name);
    summary.swiftExecuted = true;
    return summary;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3);
    const result = runMachOTests(process.argv[2]);
    console.log(JSON.stringify(result));
    console.log(result.swiftExecuted
      ? `PASS Swift 5 Foundation + ${process.argv[2] === '--foundation-crypto' ? 'Apple swift-crypto (test-only import substitution)' : 'CryptoKit'}: actual SHA256 known vectors, extraction and data-only policy composition. NOT native helper/SDK/signer/enforcement acceptance.`
      : 'PASS source guards and labeled JS oracle; SKIP Swift execution. No native or signing acceptance claimed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
