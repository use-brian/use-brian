// Command-plan regression tests only: fake compiler results are NOT Mac evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runGuardianTests } from './guardian-tests.mjs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const tests = read('ClickGuardianNativeTests.swift');
const discovered = [];
let suite;
for (const line of tests.split('\n')) {
  const declaration = line.match(/^final class (\w+): XCTestCase/);
  if (declaration) suite = declaration[1];
  const method = line.match(/^    func (test\w+)\(/);
  if (method) discovered.push(`GuardianTests.${suite}/${method[1]}`);
}
assert.equal(discovered.length, 20);

function fixture({ listing = discovered.join('\n'), fail } = {}) {
  const calls = [], logs = [];
  let directory;
  const execute = (command, args, capture) => {
    calls.push({ command, args, capture });
    if (args.includes('--show-sdk-path')) return '/fixture/Xcode SDK';
    if (args.includes('--package-path')) {
      directory = args[args.indexOf('--package-path') + 1];
      assert.equal(readFileSync(join(directory, 'Tests/ClickGuardianNative.swift'), 'utf8'), read('ClickGuardianNative.swift'));
      assert.equal(readFileSync(join(directory, 'Tests/ClickGuardianNativeTests.swift'), 'utf8'), tests);
      const manifest = readFileSync(join(directory, 'Package.swift'), 'utf8');
      assert.match(manifest, /swift-tools-version: 5\.9/);
      assert.match(manifest, /\.testTarget\(name: "GuardianTests"/);
      assert.doesNotMatch(manifest, /\.package\(|\.executableTarget\(/);
      assert(!existsSync(join(directory, 'main.swift')), 'Darwin must not generate Linux XCTMain');
      if (args.includes('--list-tests')) {
        if (fail === 'discovery') throw new Error('discovery failed');
        return listing;
      }
      assert(args.includes('--skip-build'));
      const filter = new RegExp(args[args.indexOf('--filter') + 1]);
      for (const name of discovered) assert(filter.test(name), name);
      assert(!filter.test(discovered[0].replace('GuardianTests.', 'GuardianTestsX')));
      assert(!filter.test(`${discovered[0]}Extra`));
      if (fail === 'execution') throw new Error('tests failed');
    }
    if (args[0] === 'clang') {
      assert.deepEqual(args.slice(0, 3), ['clang', '-isysroot', '/fixture/Xcode SDK']);
      assert(args.some(arg => arg.endsWith('ProcessEpochFenceTests.c')));
    }
    return '';
  };
  return { calls, logs, execute, directory: () => directory,
    options: { platformName: 'darwin', args: [], execute, log: text => logs.push(text) } };
}

test('Darwin uses SwiftPM overlay/discovery, unchanged sources and exact non-emitting filter', async () => {
  const f = fixture();
  await runGuardianTests(f.options);
  assert.equal(f.calls.filter(call => call.args.includes('--list-tests')).length, 1);
  assert.equal(f.calls.filter(call => call.args.includes('--filter')).length, 1);
  assert(!f.calls.some(call => call.command === 'swiftc' || call.args[0] === 'swiftc'));
  assert.equal(f.calls.filter(call => call.args[0] === 'clang').length, 1);
  assert(f.logs.some(line => line.startsWith('PASS Darwin: 6')));
  assert(!existsSync(f.directory()));
});

for (const [name, listing] of [
  ['empty', ''], ['missing', discovered.slice(1).join('\n')],
  ['extra', [...discovered, 'GuardianTests.Unreviewed/testPostsInput'].join('\n')],
  ['duplicate', [...discovered, discovered[0]].join('\n')],
]) test(`Darwin refuses ${name} discovery before execution and cleans temporary files`, async () => {
  const f = fixture({ listing });
  await assert.rejects(runGuardianTests(f.options), /discovery must match/);
  assert(!f.calls.some(call => call.args.includes('--filter') || call.args[0] === 'clang'));
  assert.equal(f.logs.length, 0);
  assert(!existsSync(f.directory()));
});

for (const fail of ['discovery', 'execution']) test(`Darwin propagates ${fail} failure without claiming PASS`, async () => {
  const f = fixture({ fail });
  await assert.rejects(runGuardianTests(f.options), /failed/);
  assert(!f.calls.some(call => call.args[0] === 'clang'));
  assert.equal(f.logs.length, 0);
  assert(!existsSync(f.directory()));
});

test('Linux keeps the real corelibs XCTest main and runtime library options', async () => {
  const calls = [], logs = [];
  let main;
  await runGuardianTests({ platformName: 'linux', args: ['--library-path=/fixture/runtime lib'],
    log: text => logs.push(text), execute: (command, args) => {
      calls.push({ command, args });
      if (command === 'swiftc') {
        main = args.find(arg => arg.endsWith('/main.swift'));
        const contents = readFileSync(main, 'utf8');
        assert.match(contents, /XCTMain\(/);
        assert.doesNotMatch(contents, /ClickGuardianNativeGateTests/);
        const portableNames = discovered.filter(name => !name.includes('ClickGuardianNativeGateTests/'));
        assert.equal((contents.match(/\("test/g) ?? []).length, portableNames.length);
        for (const name of portableNames) assert(contents.includes(name.replace('GuardianTests.', '').replace('/', '.')), name);
        assert(args.includes('/fixture/runtime lib'));
      }
      return '';
    } });
  assert.equal(calls.length, 2);
  assert(logs.some(line => line.startsWith('SKIP Darwin:')));
  assert(!existsSync(main));
});

test('rejects unsupported platform and unknown options before commands', async () => {
  const execute = () => assert.fail('must not execute');
  await assert.rejects(runGuardianTests({ platformName: 'win32', args: [], execute }));
  await assert.rejects(runGuardianTests({ platformName: 'darwin', args: ['--accept-platform'], execute }));
});
