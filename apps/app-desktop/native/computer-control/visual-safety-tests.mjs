// Execute verbatim production policy and binding predicates with native dependencies stubbed.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
assert.deepEqual(process.argv.slice(2), ['--foundation']);
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const helper = read('Helper.swift');
const section = (start, end) => {
  const a = helper.indexOf(start, start.startsWith('    func beginVisualApproval') ? helper.indexOf('final class Broker:') : 0), b = helper.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, start); return helper.slice(a, b);
};
const wire = section('// BEGIN FOUNDATION WIRE VALIDATION', '// END FOUNDATION WIRE VALIDATION')
  .replace(/^func now\(\) -> Double \{[^\n]+\}$/m, 'func now() -> Double { 1000 }');
const pins = section('// BEGIN FOUNDATION VISUAL PINS', '// END FOUNDATION VISUAL PINS');
const policy = section('// BEGIN FOUNDATION VISUAL POLICY', '// END FOUNDATION VISUAL POLICY');
const binding = section('private struct VisualBinding', 'final class Broker:');
const scoped = section('    private func scopedAuthority(', '    func validCommand(');
const valid = section('    private func visualEvidenceAlive()', '    func beginVisualApproval(');
const end = section('    private func endVisualApproval(', '    private func consumeVisual(');
const begin = section('    func beginVisualApproval(_ payload: Object) -> VisualApproval? {', '    private func endVisualApproval(');
for (const marker of ['AXUIElementCopyElementAtPosition', 'CFEqual(hit, ref.element)', 'candidates.count == 1', 'VisualPolicy.alive', 'visualAttempt.bind(fingerprint(command))', 'visualValid(binding, command, window)']) assert(begin.includes(marker), marker);
for (const marker of ['binding.id == payload["bindingId"]', 'same(command, binding.command)', 'VisualPolicy.alive', 'snapshot.inputMonotonic = monotonic()', 'visualValid(binding, command, window)']) assert(end.includes(marker), marker);
assert(!/snapshot\.monotonic\s*=|frameMonotonic\s*=|captureMonotonic\s*=/.test(end));
assert(helper.includes('private var visualAttempt = VisualAttempt()'));
assert.equal((helper.match(/visualAttempt = VisualAttempt\(\)/g) ?? []).length, 1);
assert(helper.includes('visualAttempt.terminate() // At most one attempted dispatch'));
assert(helper.includes('guard !semanticSafety.uncertain else'));
assert(helper.includes('"input": false'));
assert(!/CGEvent\([^\n]*(mouseEventSource|keyboardEventSource)|CGEventPost\(/.test(helper));
const pin = section('    func visualFixtureValid(', '    func target(');
for (const marker of ['identity.executable == fixtureExecutable', 'ProcessIdentity.read(identity.pid) == identity', 'cdhash H', 'signedProcess(identity, teamRequirement(cohort)']) assert(pin.includes(marker));
const attributes = section('    private func publicShapeAttributes(', '    private func publicShapes(');
assert(attributes.includes('VisualPolicy.contentAttributes(node)'));
assert(!attributes.includes('AXRoleDescription'));
assert(!attributes.includes('AXUIElementCopyAttributeNames'));
const cohort = section('    private func publicShapes(', '    private func reserveVisualCapture(');
for (const marker of ['publicShapesGrant(grant)', 'trust.visualFixtureValid(window.identity)', 'snapshot.refs.count == 6', 'exported.count == 6',
  'ref.node["sensitive"] as? Bool == false', 'children.count == expectedChildren.count',
  'CFEqual(child, known.element)', 'VisualPolicy.cohort(nodes, bounds: bounds) && unchanged(snapshot, window)']) assert(cohort.includes(marker), marker);
const semantic = section('    func permittedSemantic(', '    private func capture(');
assert(semantic.includes('guard visualExecuting, let binding = visualBinding, same(action, binding.action) else { return false }'));
const effect = section('    private func effectAllowed(', '    func input(');
assert(effect.includes('guard visualEvidenceAlive() else { return false }'));
const lifecycle = section('    private func reserveVisualCapture(', '    private func visualEvidenceAlive()') + begin + end
  + section('    private func consumeVisual(', '    private func localApprovalKind(')
  + section('    func execute(_ payload: Object, timing: SourceRequestTiming? = nil)', '    func rect(');
const dir = mkdtempSync(join(tmpdir(), 'visual-safety-'));
try {
  const main = join(dir, 'main.swift'), binary = join(dir, 'tests');
  writeFileSync(main, `import Foundation\nimport CoreFoundation\nimport Dispatch\ntypealias Object = [String: Any]\nlet proto = "native-computer-v1"\n${wire}\n${pins}\n${policy}\n${binding}\n${read('VisualSafetyTests.swift').replace('// PRODUCTION BINDING PREDICATE', valid + lifecycle).replace('// PRODUCTION SCOPE PREDICATE', scoped)}`);
  for (const [cmd, args] of [['swiftc', ['-swift-version', '5', main, '-o', binary]], [binary, []]]) {
    const result = spawnSync(cmd, args, { stdio: 'inherit', timeout: 120000 });
    assert.equal(result.status, 0, `${cmd}: ${result.error ?? result.signal ?? 'failed'}`);
  }
  console.log('PASS visual source placement guards; not native SDK or effect delivery evidence');
} finally { rmSync(dir, { recursive: true, force: true }); }
