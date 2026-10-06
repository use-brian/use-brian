// Executes verbatim production Foundation policy, never the native helper.
// node semantic-safety-tests.mjs --foundation [--library-path=/toolchain/lib]
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
assert(args.includes('--foundation') && args.every(a => a === '--foundation' || a.startsWith('--library-path=')));
const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
const block = helper.split('// BEGIN FOUNDATION SEMANTIC SAFETY\n')[1]?.split('// END FOUNDATION SEMANTIC SAFETY')[0];
assert(block);
// Bind the OS callback's actual categories to the extracted policy. In
// particular a drag must never become passive motion, and tap loss stays fatal.
const input = helper.slice(helper.indexOf('    func input('), helper.indexOf('    var commandDeadline'));
assert.match(input, /if type == \.tapDisabledByTimeout \|\| type == \.tapDisabledByUserInput \{ _exit\(72\) \}/);
for (const binding of [
  'case .mouseMoved: kind = .pointer',
  'case .keyDown, .keyUp: kind = .key',
  'case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp: kind = .button',
  'case .scrollWheel: kind = .scroll',
  'case .leftMouseDragged, .rightMouseDragged, .otherMouseDragged: kind = .drag',
  'case .flagsChanged: kind = .modifier', 'default: kind = .unknown',
  'SemanticInputPolicy.exitCode(active: active, approving: approving,',
  'parentTarget: event.getIntegerValueField(.eventTargetUnixProcessID) == Int64(getppid()), kind: kind)',
  '_exit(code)',
]) assert(input.includes(binding), binding);
assert.equal(input.match(/kind = \.pointer/g)?.length, 1);
const tests = readFileSync(new URL('./SemanticSafetyTests.swift', import.meta.url), 'utf8');
const temporary = mkdtempSync(join(tmpdir(), 'semantic-safety-'));
try {
  const main = join(temporary, 'main.swift'), binary = join(temporary, 'tests');
  writeFileSync(main, `import Foundation\n${block}\n${tests}`);
  const libraries = args.filter(a => a.startsWith('--library-path=')).flatMap(a => ['-L', a.slice('--library-path='.length), '-Xlinker', '-rpath', '-Xlinker', a.slice('--library-path='.length)]);
  const compile = spawnSync('swiftc', ['-swift-version', '5', ...libraries, main, '-o', binary], { stdio: 'inherit', timeout: 120000 });
  assert.equal(compile.status, 0, `Foundation compile failed: ${compile.error ?? ''}`);
  const result = spawnSync(binary, [], { stdio: 'inherit', timeout: 10000 });
  assert.equal(result.status, 0, `Foundation policy failed: ${result.error ?? ''}`);
  // Compile actual Broker method bodies verbatim; only OS/clock dependencies are
  // fake. No second lifecycle implementation and no changes to the shipped helper.
  const broker = helper.slice(helper.indexOf('final class Broker:'));
  const section = (from, to) => {
    const start = broker.indexOf(from), end = broker.indexOf(to, start);
    assert(start >= 0 && end > start);
    return broker.slice(start, end);
  };
  const methods = section('    private func effectAllowed(', '    func input(')
    + section('    private func localApprovalKind(', '    func rect(');
  let wire = helper.split('// BEGIN FOUNDATION WIRE VALIDATION\n')[1]?.split('// END FOUNDATION WIRE VALIDATION')[0];
  assert(wire);
  // Replace ONLY the clock dependency in the extracted wire support, never a
  // Broker method or predicate. Independent fake wall/monotonic clocks are below.
  assert.match(wire, /^func now\(\) -> Double \{[^\n]+\}$/m);
  wire = wire.replace(/^func now\(\) -> Double \{[^\n]+\}$/m, 'func now() -> Double { testWall }');
  const harness = readFileSync(new URL('./SemanticLifecycleTests.swift', import.meta.url), 'utf8');
  assert.equal(harness.split('// PRODUCTION BROKER METHODS').length, 2);
  writeFileSync(main, `import Foundation\nimport CoreFoundation\nimport Dispatch\ntypealias Object = [String: Any]\nlet proto = "native-computer-v1"\n${wire}\n${harness.replace('// PRODUCTION BROKER METHODS', methods)}`);
  const lifecycleCompile = spawnSync('swiftc', ['-swift-version', '5', ...libraries, main, '-o', binary], { stdio: 'inherit', timeout: 120000 });
  assert.equal(lifecycleCompile.status, 0, `Broker extraction compile failed: ${lifecycleCompile.error ?? ''}`);
  const lifecycle = spawnSync(binary, [], { stdio: 'inherit', timeout: 10000 });
  assert.equal(lifecycle.status, 0, `Broker lifecycle failed: ${lifecycle.error ?? ''}`);

} finally { rmSync(temporary, { recursive: true, force: true }); }
