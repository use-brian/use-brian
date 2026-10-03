// Run: node guardian-tests.mjs [--library-path=/path/to/runtime/lib ...]
// Nix: nix shell nixpkgs#swift nixpkgs#swiftPackages.Foundation nixpkgs#swiftPackages.XCTest
// Then: node guardian-tests.mjs --library-path="$(dirname "$(dirname "$(command -v swiftc)")")/lib"
// Like wire-boundary.mjs, uses swiftc from PATH and test-only -L/rpath options.
// Linux needs Swift + Foundation + XCTest in the compiler environment.
// Darwin needs Xcode: SDK frameworks plus its developer XCTest framework.
// Runs existing tests verbatim, never Helper.swift or the guardian host.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
assert(args.every(arg => arg.startsWith('--library-path=') && arg.length > '--library-path='.length), 'Unknown guardian-test option (only --library-path=PATH is supported)');
assert(['linux', 'darwin'].includes(process.platform), 'Guardian tests support Linux and Darwin');
const darwin = process.platform === 'darwin';
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
const temporary = await mkdtemp(join(tmpdir(), 'brian-guardian-tests-'));
try {
  const main = join(temporary, 'main.swift');
  const binary = join(temporary, 'guardian-tests');
  await writeFile(main, `import XCTest\nXCTMain([\n${entries(portable)}${darwin ? ',\n' + entries(native) : ''}\n])\n`);
  const libraries = args.flatMap(arg => {
    const path = arg.slice('--library-path='.length);
    return ['-L', path, '-Xlinker', '-rpath', '-Xlinker', path];
  });
  const platform = [];
  let sdk;
  if (darwin) {
    sdk = run('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], true);
    const developerFrameworks = join(run('xcrun', ['--sdk', 'macosx', '--show-sdk-platform-path'], true), 'Developer/Library/Frameworks');
    platform.push('-sdk', sdk, '-F', developerFrameworks,
      '-Xlinker', '-rpath', '-Xlinker', developerFrameworks,
      '-framework', 'XCTest', '-framework', 'Foundation', '-framework', 'AppKit', '-framework', 'CoreGraphics');
  }
  run(darwin ? 'xcrun' : 'swiftc', [ ...(darwin ? ['swiftc'] : []),
    '-swift-version', '5', ...libraries, ...platform,
    source('ClickGuardianNative.swift'), source('ClickGuardianNativeTests.swift'), main, '-o', binary]);
  run(binary, []);
  console.log('PASS portable: 10 XCTest ledger/tail cases (synthetic bookkeeping only).');
  if (darwin) {
    console.log('PASS Darwin: 6 non-emitting API XCTest cases; no event posting or permission request.');
    const fence = join(temporary, 'epoch-fence-tests');
    // The existing TU includes production C with local syscall fakes. Do not
    // substitute headers: sys/event.h and constants come from the public SDK.
    run('xcrun', ['clang', '-isysroot', sdk, '-std=c11', '-Wall', '-Wextra', '-Werror',
      source('ProcessEpochFenceTests.c'), '-o', fence]);
    run(fence, []);
    console.log('PASS Darwin: ProcessEpochFenceTests.c assertions with public SDK headers and syscall fakes.');
  } else {
    console.log('SKIP Darwin: 6 non-emitting API XCTest cases and ProcessEpochFenceTests.c (requires real Darwin public SDK headers; no Linux header shims).');
  }
  console.log('No native event injection, permission request, delivery/cleanup proof or native acceptance claimed; no acceptance promotion.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
