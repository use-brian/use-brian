// Run: node guardian-tests.mjs [--library-path=/path/to/runtime/lib ...]
// Nix: nix shell nixpkgs#swift nixpkgs#swiftPackages.Foundation nixpkgs#swiftPackages.XCTest
// Then: node guardian-tests.mjs --library-path="$(dirname "$(dirname "$(command -v swiftc)")")/lib"
// Like wire-boundary.mjs, uses swiftc from PATH and test-only -L/rpath options.
// Linux needs Swift + Foundation + XCTest in the compiler environment.
// Darwin uses Xcode's SwiftPM XCTest runner (including Apple's Swift overlay),
// not the Linux-only XCTMain/testCase entrypoint or a hand-linked ObjC framework.
// Runs existing tests verbatim, never Helper.swift or the guardian host.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = name => fileURLToPath(new URL(name, import.meta.url));
function run(command, argv, capture = false) {
  console.log(`RUN ${JSON.stringify([command, ...argv])}`);
  const result = spawnSync(command, argv, {
    stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', timeout: 120000,
  });
  if (capture && result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `${command} failed: ${result.error ?? result.signal ?? result.status}`);
  return result.stdout?.trim();
}

// Explicitly register only the existing non-emitting tests. No source rewriting,
// automatic discovery of future native tests, acceptance flags or permission calls.
const portable = {
  ClickGuardianPlatformSelectorTests: [
    'testProductionRegistryIsEmptyAndRefuses',
    'testOnlyExactVersionBuildArchitectureAndMechanismMatch',
    'testTranslatedUnknownAndMissingMetadataRefuse',
    'testMalformedAndDuplicateProfilesInvalidateEntireRegistry',
  ],
  ClickGuardianNativeLedgerTests: [
    'testNoReadinessWithoutBoundedNullConfirmation',
    'testLateProbeCannotBeatDelayedTimer',
    'testOneUseWakeAndNoReplayAfterAmbiguousSequence',
    'testScopeButtonsModifiersAndDeadlineRefuse',
    'testRevocationAtEveryBoundaryIsSticky',
    'testBadDeadlineAndDuplicateAdmissionAreTerminal',
  ],
  ClickGuardianTailLedgerTests: [
    'testImmutableProducerAndOrderedPair',
    'testUnsealedProducerAndUpBeforeDownNeverProveCleanup',
    'testWrongTagPhysicalOverlapLateTailAndTapLossAreSticky',
    'testIncompletePairAndRepeatedReservationCannotBeReplayed',
  ],
};
const native = {
  ClickGuardianNativeGateTests: [
    'testPairIsPreallocatedTaggedAndNeverPostedByPreparation',
    'testEitherAllocationFailureReturnsNoPair',
    'testNoAcceptedPlatformAndNoEffectsFromExecute',
    'testInvalidProbeBudgetDoesNotCreateTapOrRequestPermissions',
    'testReturnAcknowledgmentCannotManufactureAcceptedStreamEvidence',
    'testAllLossSignalsFenceWithoutCleanupEvents',
  ],
};
const entries = suites => Object.entries(suites).map(([suite, tests]) =>
  `testCase([${tests.map(test => `("${test}", ${suite}.${test})`).join(',\n')}])`).join(',\n');
// Test-only command-runner seam; cannot change the native platform registry.
export async function runGuardianTests({ platformName = process.platform, args = process.argv.slice(2), execute = run, log = console.log } = {}) {
assert(args.every(arg => arg.startsWith('--library-path=') && arg.length > '--library-path='.length), 'Unknown guardian-test option (only --library-path=PATH is supported)');
assert(['linux', 'darwin'].includes(platformName), 'Guardian tests support Linux and Darwin');
const darwin = platformName === 'darwin';
const temporary = await mkdtemp(join(tmpdir(), 'brian-guardian-tests-'));
try {
  const libraries = args.flatMap(arg => {
    const path = arg.slice('--library-path='.length);
    return ['-L', path, '-Xlinker', '-rpath', '-Xlinker', path];
  });
  let sdk;
  if (darwin) {
    sdk = execute('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], true);
    // No dependencies/network resolution, source rewriting or production build.
    // SwiftPM supplies the matching Apple Swift XCTest overlay, linker/runtime
    // paths, discovery and .xctest host; framework -F alone finds only ObjC APIs.
    await mkdir(join(temporary, 'Tests'));
    for (const name of ['ClickGuardianNative.swift', 'ClickGuardianNativeTests.swift']) {
      await copyFile(source(name), join(temporary, 'Tests', name));
    }
    await writeFile(join(temporary, 'Package.swift'), `// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "GuardianChecks", platforms: [.macOS(.v14)], targets: [
    .testTarget(name: "GuardianTests", path: "Tests", sources: ["ClickGuardianNative.swift", "ClickGuardianNativeTests.swift"])
])
`);
    const command = ['swift', 'test', '--package-path', temporary, '--scratch-path', join(temporary, 'build'),
      ...libraries.flatMap(flag => ['-Xswiftc', flag])];
    const expected = Object.entries({ ...portable, ...native }).flatMap(([suite, tests]) => tests.map(name => `GuardianTests.${suite}/${name}`));
    const listed = execute('xcrun', [...command, '--list-tests'], true);
    const discovered = listed.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('GuardianTests.'));
    assert.deepEqual(discovered.sort(), [...expected].sort(), 'XCTest discovery must match exactly the 20 reviewed non-emitting tests');
    const filter = `^(${expected.map(name => name.replaceAll('.', '\\.')).join('|')})$`;
    execute('xcrun', [...command, '--skip-build', '--filter', filter]);
  } else {
    const main = join(temporary, 'main.swift');
    const binary = join(temporary, 'guardian-tests');
    await writeFile(main, `import XCTest\nXCTMain([\n${entries(portable)}\n])\n`);
    execute('swiftc', ['-swift-version', '5', ...libraries,
      source('ClickGuardianNative.swift'), source('ClickGuardianNativeTests.swift'), main, '-o', binary]);
    execute(binary, []);
  }
  log('PASS portable: 14 XCTest ledger/tail/selector cases (synthetic bookkeeping/configuration only).');
  if (darwin) {
    log('PASS Darwin: 6 non-emitting API XCTest cases; no event posting or permission request.');
    const fence = join(temporary, 'epoch-fence-tests');
    // The existing TU includes production C with local syscall fakes. Do not
    // substitute headers: sys/event.h and constants come from the public SDK.
    execute('xcrun', ['clang', '-isysroot', sdk, '-std=c11', '-Wall', '-Wextra', '-Werror',
      source('ProcessEpochFenceTests.c'), '-o', fence]);
    execute(fence, []);
    log('PASS Darwin: ProcessEpochFenceTests.c assertions with public SDK headers and syscall fakes.');
  } else {
    log('SKIP Darwin: 6 non-emitting API XCTest cases and ProcessEpochFenceTests.c (requires real Darwin public SDK headers; no Linux header shims).');
  }
  log('No native event injection, permission request, delivery/cleanup proof or native acceptance claimed; no acceptance promotion.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runGuardianTests();
