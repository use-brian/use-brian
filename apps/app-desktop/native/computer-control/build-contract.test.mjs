// Portable BUILD ORCHESTRATION mocks only; no native compiler/signing acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t, failCompile = false) {
  const root = mkdtempSync(join(tmpdir(), 'native-build-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), bin = join(root, 'bin'), temporary = join(root, 'temporary');
  for (const p of [source, bin, temporary]) mkdirSync(p, { mode: 0o700 });
  copyFileSync(new URL('./build.sh', import.meta.url), join(source, 'build.sh'));
  writeFileSync(join(source, 'Helper.swift'), '// dispatcher sentinel: not executed\n');
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; *) exit 90;; esac\n', { mode: 0o700 });
  writeFileSync(join(bin, 'xcrun'), `#!${process.execPath}\n` + `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const main = args.find(a => a.endsWith('/main.swift'));
    const row = { args, mainSource: main ? fs.readFileSync(main, 'utf8') : null,
      temporaryMode: main ? fs.statSync(require('node:path').dirname(main)).mode & 511 : null };
    fs.appendFileSync(process.env.BUILD_CONTRACT_LOG, JSON.stringify(row) + '\\n');
    if (process.env.BUILD_CONTRACT_FAIL === '1' && args.includes('BootstrapApprovalAnchor.c')) process.exit(42);
    const out = args.indexOf('-o');
    if (out < 0) process.exit(91);
    fs.writeFileSync(args[out + 1], 'mock compiler output, NEVER EXECUTED');
  `, { mode: 0o700 });
  writeFileSync(join(bin, 'codesign'), '#!/bin/sh\nexit 92\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temporary,
    BUILD_CONTRACT_LOG: join(root, 'calls.jsonl'), BUILD_CONTRACT_FAIL: failCompile ? '1' : '0' };
  delete env.CODESIGN_IDENTITY; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const result = spawnSync('bash', [join(source, 'build.sh'), join(root, 'out')], { env, encoding: 'utf8' });
  const calls = readFileSync(env.BUILD_CONTRACT_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  return { result, calls, temporary, source };
}

test('build compiles linked bootstrap sources with a private main.swift copy; unsigned only', t => {
  const f = fixture(t);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.match(f.result.stderr, /UNSIGNED development artifacts/);
  assert.equal(f.calls.length, 4);
  assert(f.calls[0].args.includes('ProcessIdentity.c'));
  assert(f.calls[1].args.includes('BootstrapApprovalAnchor.c'));
  const helper = f.calls[2];
  for (const file of ['LibraryConstraintPolicy.swift', 'MachOLibraryConstraint.swift', 'BootstrapApproval.swift', 'BootstrapApprovalReader.swift', 'BootstrapProcessBinding.swift', 'ElectronFrameworkBinding.swift']) assert(helper.args.includes(file), file);
  assert(helper.args.some(a => a.endsWith('/BootstrapApprovalAnchor.o')));
  assert.equal(helper.mainSource, readFileSync(join(f.source, 'Helper.swift'), 'utf8'));
  assert.equal(helper.temporaryMode, 0o700);
  assert(f.calls[3].args.includes('Fixture.swift'));
  assert.deepEqual(readdirSync(f.temporary), []);
});

test('anchor compiler failure stops before Swift/signing and removes private temporary source', t => {
  const f = fixture(t, true);
  assert.equal(f.result.status, 42);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(readdirSync(f.temporary), []);
  assert.equal(readFileSync(join(f.source, 'Helper.swift'), 'utf8'), '// dispatcher sentinel: not executed\n');
});

test('scope notification terminates even before grant activation without locks or AX queries', () => {
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  const callback = helper.match(/let callback: AXObserverCallback = \{ _, _, _, _ in([\s\S]*?)\n        \}/)?.[1];
  assert.ok(callback);
  assert.equal(callback.replace(/\/\/[^\n]*/g, '').trim(), '_exit(71)');
  // Source-level guard, not proof of native notification delivery: no active
  // flag may swallow a transient window/sheet between subscription and Start.
});

test('typed AX children reader admits only independently verified public leaves and pins membership', () => {
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  const reader = helper.slice(helper.indexOf('func readChildren('), helper.indexOf('// Internal security comparisons'));
  assert.match(reader, /switch AXUIElementCopyAttributeValue\(element, kAXChildrenAttribute as CFString, &value\)/);
  assert.match(reader, /CFGetTypeID\(value\) == CFArrayGetTypeID\(\)/);
  assert.match(reader, /children.allSatisfy\(\{ CFGetTypeID\(\$0\) == AXUIElementGetTypeID\(\) \}\)/);
  assert.match(reader, /else \{ return .malformed \}/);
  const unsupported = reader.slice(reader.indexOf('case .attributeUnsupported:'));
  for (const guard of ['AXUIElementCopyAttributeNames(element, &attributes) == .success', 'let names = attributes as? [String]',
    'publicLeafWithoutChildren(attr(element, kAXRoleAttribute) as? String,', 'privacySubrole(element), names)']) {
    assert(unsupported.indexOf(guard) >= 0 && unsupported.indexOf(guard) < unsupported.indexOf('return .absentLeaf'), guard);
  }
  assert.match(unsupported, /default: return .failed/);
  assert(!reader.includes('case .noValue'));
  assert.equal((reader.match(/return .absentLeaf/g) ?? []).length, 1);
  assert(helper.includes('let children: ChildrenRead<AXUIElement>'));
  assert(helper.includes('if childRead.elements == nil { complete = false }'));
  assert(helper.includes('Ref(element: element, node: value, children: childRead)'));
  assert(helper.includes('let current = readChildren(ref.element)'));
  assert(helper.includes('sameChildrenRead(ref.children, current, equal: { CFEqual($0, $1) })'));
  assert(helper.includes('reachable(ref.element, in: window.element) && sameChildren(ref)'));
  assert(!helper.includes('func scopedChildren('));
  // Window/sheet fencing remains strict; the leaf exception never applies here.
  assert(helper.includes('guard let children = attr(element, kAXChildrenAttribute) as? [AXUIElement], children.count <= 500 else { return false }'));
});

test('mapped reader has only an own-symbol source and no admission/parent/environment override', () => {
  const reader = readFileSync(new URL('./BootstrapApprovalReader.swift', import.meta.url), 'utf8');
  assert.match(reader, /brian_bootstrap_approval_copy\(buffer.baseAddress, buffer.count, &written\)/);
  assert.match(reader, /written == bytes.count/);
  assert.match(reader, /decode\(record: bytes\)/);
  assert.doesNotMatch(reader, /ProcessInfo|FileHandle|URL\(|getenv|CommandLine|JSONSerialization/);
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  assert.match(helper, /let dispatcher = ObservationDispatcher \{ Broker\(trust: trust\) \}/);
  assert.match(helper, /dispatcher.response\(request, clock: sourceClock\)/);
});

test('semantic approval and effect guards precede restoration and native dispatch', () => {
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  const broker = helper.slice(helper.indexOf('final class Broker:'));
  const section = (from, to) => broker.slice(broker.indexOf(from), broker.indexOf(to));
  const start = section('    func start(', '    func authorized(');
  assert(start.indexOf('monitorScope(window)') < start.indexOf('restoreApprovedWindow(window)'));
  assert(start.indexOf('watchdogActive = true') < start.indexOf('restoreApprovedWindow(window)'));
  assert.match(start, /if wireBool\(candidate\["allowControl"\]\) == true \{\s*guard restoreApprovedWindow/);
  const begin = section('    func beginApproval(', '    func endApproval(');
  for (const gate of ['validWirePayload("beginApproval", payload)', 'authorized(command,', 'fresh(action, window)', 'permittedSemantic(action, snapshot)', 'unchanged(snapshot, window)']) {
    assert(begin.indexOf(gate) >= 0 && begin.indexOf(gate) < begin.indexOf('approvalCommand = command'), gate);
  }
  assert.match(begin, /min\(expiresMonotonic, monotonic\(\) \+ min\(30_000, deadline - now\(\)\)\)/);
  const end = section('    func endApproval(', '    func execute(');
  for (const gate of ['validWirePayload("endApproval", payload)', 'exactSemanticCommand(command, pending)', 'authorized(command,', 'if !approved', 'permittedSemantic(action, snapshot)']) {
    assert(end.indexOf(gate) >= 0 && end.indexOf(gate) < end.indexOf('restoreApprovedWindow(window)'), gate);
  }
  assert.match(end, /defer \{ approvalCommand = nil \}/);
  assert(end.indexOf('approvedCommand = nil') < end.indexOf('validWirePayload'));
  assert(end.indexOf('unchanged(snapshot, window)') < end.indexOf('approvedCommand = command'));
  assert(end.lastIndexOf('authorized(command,') > end.indexOf('restoreApprovedWindow(window)'));
  const execute = section('    func execute(', '    func rect(');
  const effect = execute.indexOf('        var error: AXError');
  for (const gate of ['validWirePayload("execute", payload)', 'supportedExecution(command)', 'approvalCommand == nil', 'authorized(command,',
    'journal[commandId] = result("helper_error", "execution_unknown")', 'exactSemanticCommand(command, approved)', 'approvedCommand = nil',
    'permittedSemantic(action, completeSnapshot)', 'unchanged(snapshot, window)', 'fresh(action, window) != nil', 'current.complete']) {
    assert(execute.indexOf(gate) >= 0 && execute.indexOf(gate) < effect, gate);
  }
  assert(!execute.includes('capture(command,'));
  assert.match(execute, /snapshots.removeAll\(\)/);
  assert.match(execute, /guard error == .success else \{ return finish\(result\("helper_error", "execution_unknown"\)\) \}/);
  const authority = section('    func authorized(', '    func validCommand(');
  for (const gate of ['trust.parentValid()', 'leaseId == lease', 'same(identity, owner)', 'command["grantId"]', 'command["epoch"]',
    'now() < expiry', 'monotonic() < expiresMonotonic', 'monotonic() < commandDeadline', 'now() < deadline',
    'same($0, target)', 'liveWindow(target) != nil', 'AXIsProcessTrusted()', 'brian_private_channel_alive() == 1']) assert(authority.includes(gate), gate);
  // These are placement regressions, not native AX/Stop delivery evidence.
});
