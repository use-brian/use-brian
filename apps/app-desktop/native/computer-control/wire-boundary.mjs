// Run: node wire-boundary.mjs --portable
// Run with a working Swift/Foundation toolchain: node wire-boundary.mjs --foundation
// Optional --library-path=... supplies Linux/Nix linker paths ONLY to the test compiler.
// The helper has no test-mode switch. This never launches the native helper.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const args = process.argv.slice(2);
assert(args.every(arg => ['--foundation', '--portable'].includes(arg) || arg.startsWith('--library-path=')), 'Unknown boundary-test option');
const helper = await readFile(new URL('./Helper.swift', import.meta.url), 'utf8');
const source = await readFile(new URL('../../../../packages/computer-control/src/protocol.ts', import.meta.url), 'utf8');
// Use the actual shared schemas as oracle, not an independently relaxed JS validator.
const require = createRequire(import.meta.url);
const module = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/from ['"]zod['"]/, `from ${JSON.stringify(pathToFileURL(require.resolve('zod')).href)}`);
const schemas = await import(`data:text/javascript;base64,${Buffer.from(module).toString('base64')}`);
const timingSource = await readFile(new URL('../../../../packages/computer-control/src/helper-timing.ts', import.meta.url), 'utf8');
const timingModule = ts.transpileModule(timingSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/from ['"]zod['"]/, `from ${JSON.stringify(pathToFileURL(require.resolve('zod')).href)}`);
const timingSchemas = await import(`data:text/javascript;base64,${Buffer.from(timingModule).toString('base64')}`);
const block = helper.split('// BEGIN FOUNDATION WIRE VALIDATION\n')[1]?.split('// END FOUNDATION WIRE VALIDATION')[0];
assert(block, 'Production Foundation-only wire block must be extractable verbatim');
for (const marker of ['CFGetTypeID(number) == CFBooleanGetTypeID()', 'CFGetTypeID(number) == CFNumberGetTypeID()',
  'number.rounded(.towardZero) == number', 'result.isFinite', 'string.utf16.count <= max',
  'max: 200)', 'max: 2000)', 'max: 4096, nonempty: false', 'min: -600, max: 600', 'Double(Int32.max)',
  '(Date().timeIntervalSince1970 * 1000).rounded(.down)']) assert(block.includes(marker), marker);
assert(!/as\? (Bool|Int|Double)| is Bool/.test(block), 'No NSNumber bridging shortcuts in wire validation');
assert(helper.includes('func bool(_ element: AXUIElement, _ name: String) -> Bool { (attr(element, name) as? Bool) ?? false }'), 'Native AX Bool semantics remain unchanged');
assert(helper.includes('"capturedAt": now(), "monotonicMs": monotonic()'));
assert(helper.includes('func monotonic() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }'));
assert(helper.lastIndexOf('validWireRequest(request) else') < helper.lastIndexOf('guard trust.parentValid() else'), 'Validate the complete request before live authority');
for (const method of ['execute']) {
  const body = helper.slice(helper.indexOf(`    func ${method}(`, helper.indexOf("final class Broker")));
  const validation = body.indexOf(`validWirePayload("${method}", payload)`);
  assert(validation >= 0);
  const authority = body.indexOf(method === 'start' ? 'AXIsProcessTrusted()' : 'authorized(');
  assert(authority > validation, `${method}: strict wire validation must precede authority/effects`);
}
for (const marker of ['wireBool(grant?["allowControl"]) == true', 'wireBool(grant["allowCapture"]) == true',
  'let approved = wireBool(payload["approved"])', 'guard validCommand(command), wireString(leaseId) != nil',
  'brian_private_channel_alive() == 1', '"input": false', 'if kind == "click" { return result("unsupported") }']) assert(helper.includes(marker), marker);
assert(!helper.includes('payload["approved"] as? Bool'));
assert(!helper.includes('action["deltaY"] as? Double'));

// Source placement/privacy assertions are not proof of native dispatch or delivery.
const timingSourceBlock = block.slice(block.indexOf('enum SourceMethod'));
for (const marker of ['DispatchTime.now().uptimeNanoseconds', '(uptimeNs - originNs) / 1000',
  'endUs - startUs <= 900_000_000', '9_007_199_254_740_991', 'let instanceId = UUID().uuidString',
  'let clockId = UUID().uuidString', 'wireBool(request["diagnostics"]) == true',
  'pending == nil, api == nil', 'method == .execute, root.phase == .request',
  'api.startUs >= root.startUs, api.endUs <= root.endUs',
  'if method == "capabilities" { response["diagnosticsVersion"] = 1 }']) assert(timingSourceBlock.includes(marker), marker);
assert(!/Date\(|ProcessInfo|\.wait\(|usleep|Thread\.sleep|print\(/.test(timingSourceBlock), 'No wall clocks, waits or logging in timing');
const dtoSource = timingSourceBlock.slice(timingSourceBlock.indexOf('    func dto('), timingSourceBlock.indexOf('final class SourceRequestTiming'));
assert(!/payload|target|ref|name|goal|frame|error|result|environment/.test(dtoSource), 'DTO builder cannot inspect authority/content data');
const brokerOffset = helper.indexOf('final class Broker: ObservationBackend');
const capsSource = helper.slice(helper.indexOf('    func capabilities(', brokerOffset), helper.indexOf('    func listTargets(', brokerOffset));
assert(!capsSource.includes('diagnostics'), 'Never modify public capabilities result');
assert(capsSource.includes('CGPreflightScreenCaptureAccess()'));
assert(capsSource.includes('"windowCapture": ready && captureReady'));
assert(!helper.includes('CGRequestScreenCaptureAccess'), 'No permission prompt in any path');
assert(!helper.includes('AXIsProcessTrustedWithOptions'), 'Accessibility requests belong to persistent Electron main, never the helper');
const mainSource = helper.slice(helper.indexOf('guard let trust = ProcessTrust()'));
assert(mainSource.includes('let sourceClock = SourceClock()'));
assert(mainSource.includes('let dispatcher = ObservationDispatcher { Broker(trust: trust) }'));
assert(mainSource.indexOf('guard trust.parentValid()') < mainSource.indexOf('dispatcher.response('));
const targetAdmission = helper.slice(helper.indexOf('    func target(_ pid:'), helper.indexOf('let canvasTitle'));
assert(targetAdmission.indexOf('ProcessIdentity.read(pid)') < targetAdmission.indexOf('parentValid()'), 'Reject unrelated kernel process paths before repeated parent-seal validation');
assert(targetAdmission.indexOf('parentValid()') < targetAdmission.indexOf('signedProcess(identity,'), 'Candidate admission still requires current parent trust before target signature validation');
assert(targetAdmission.includes('anchor apple and identifier \\"com.apple.TextEdit\\"') && targetAdmission.includes('signedProcess(identity, teamRequirement(cohort))'), 'Preserve both supported target signature requirements');
assert(!/AXUIElement|bundleIdentifier|bundleURL/.test(targetAdmission), 'Early filtering cannot query AX or use bundle metadata as target authority');
const discoveryDiagnosticSource = helper.slice(helper.indexOf('final class DiscoveryDiagnostics'), helper.indexOf('func attr('));
assert(discoveryDiagnosticSource.includes('min(65535, value + max(0, amount))'));
assert(!/AXUIElementCopy|ProcessIdentity|ProcessTrust|print\(|stderr/.test(discoveryDiagnosticSource), 'Diagnostics reuse reads; no queries or raw logs');
assert(helper.includes('if method == "listTargets", let diagnostics = backend?.discoveryDiagnostics()'));
assert(helper.includes('response["discoveryDiagnostics"] = diagnostics'), 'Private reply only');
const adapter = block.slice(block.indexOf('let probeOnlyLimitation'), block.indexOf('// Closed role/subrole'));
assert(!/environment|getenv|AXIsProcessTrusted|CGPreflight|NSWorkspace|beginAPI|endAPI/.test(adapter));
assert(adapter.includes('if backend == nil { backend = makeBackend() }'));
assert(helper.includes('guard supportedGrant(payload), grant == nil'));
assert(helper.includes('guard supportedExecution(command) else { return result("denied") }'));
assert(!helper.includes('retainedBeginApproval'));
assert(!helper.includes('retainedEndApproval'));
const start = helper.slice(helper.indexOf('    func start(_ payload:', helper.indexOf('final class Broker')), helper.indexOf('    func authorized('));
assert(!/CGPreflight|AXUIElementPerformAction/.test(start));
assert(start.includes('if wireBool(candidate["allowControl"]) == true {\n            guard restoreApprovedWindow(window, deadline: expiresMonotonic, wallDeadline: expiry, wallExpiry: expiry)'));
assert(start.indexOf('monitorScope(window)') < start.indexOf('restoreApprovedWindow(window, deadline: expiresMonotonic, wallDeadline: expiry, wallExpiry: expiry)'));
assert(start.indexOf('watchdogActive = true') < start.indexOf('restoreApprovedWindow(window, deadline: expiresMonotonic, wallDeadline: expiry, wallExpiry: expiry)'));
const init = helper.slice(helper.indexOf('    init(trust:'), helper.indexOf('    func capabilities(', brokerOffset));
assert(init.indexOf('if AXIsProcessTrusted() {') < init.indexOf('inputTap = CGEvent.tapCreate'));
assert(!init.includes('CGPreflightScreenCaptureAccess'));
assert(helper.includes('if childRead.elements == nil { complete = false }'));
assert(helper.includes('"actions": [String]()'));
assert(mainSource.includes('JSONSerialization.data(withJSONObject: response), output.count <= maxBytes'));
assert.equal((mainSource.match(/FileHandle.standardOutput.write/g) ?? []).length, 2, 'One existing header/body response; no telemetry frames');
assert(mainSource.indexOf('brian_private_channel_alive() == 1') < mainSource.indexOf('dispatcher.response('));
const effects = helper.slice(helper.indexOf('        var error: AXError'), helper.indexOf('    func rect('));
const sites = [...effects.matchAll(/guard effectAllowed\(window, deadline: commandDeadline, wallDeadline: deadline, wallExpiry: expiry\) else \{ return finish\(result\("expired"\)\) \}\n\s*timing\?\.beginAPI\(\.(api_\w+)\)\n\s*error = (AXUIElement(?:PerformAction|SetAttributeValue)\([^\n]+\))\n\s*timing\?\.endAPI\(returned: error == \.success\)/g)];
assert.deepEqual(sites.map(site => site[1]), ['api_invoke', 'api_select', 'api_select', 'api_scroll', 'api_set_value'], 'Time only actual API calls, immediately after guards');
assert.equal((helper.match(/timing\?\.beginAPI/g) ?? []).length, 5);
assert.equal((helper.match(/timing\?\.endAPI/g) ?? []).length, 5);

const target = { appId: 'com.usebrian.NativeComputerFixture', processId: 42, processInstanceId: 'process', windowId: 'window', windowInstanceId: 'instance' };
const identity = Object.fromEntries(['deploymentId', 'userId', 'workspaceId', 'deviceId', 'sessionId', 'conversationId', 'taskId'].map(key => [key, key]));
const grant = { protocol: schemas.NATIVE_PROTOCOL, identity, grantId: 'grant', epoch: 1, expiresAt: 1800000000000,
  targets: [target], allowControl: true, allowCapture: false, requester: 'Local user', goal: 'Fixture only' };
const command = { protocol: schemas.NATIVE_PROTOCOL, identity, grantId: 'grant', epoch: 1, commandId: 'command', deadlineAt: 1800000000000,
  action: { kind: 'observe', target } };
const schemaFor = { target: schemas.TargetSchema, identity: schemas.IdentitySchema, grant: schemas.GrantSchema, command: schemas.CommandSchema };
const vectors = [];
function add(kind, name, value, localOverride) {
  const shared = schemaFor[kind].safeParse(value).success;
  if (localOverride !== undefined) assert.equal(shared, true, 'Local restrictions must only narrow shared schema');
  vectors.push({ kind, name, value, expected: localOverride ?? shared });
}
function edit(base, path, value) {
  const result = structuredClone(base), keys = path.split('.');
  let parent = result;
  for (const key of keys.slice(0, -1)) parent = parent[key];
  if (value === undefined) delete parent[keys.at(-1)]; else parent[keys.at(-1)] = value;
  return result;
}
function strings(kind, base, path, max, emptyAllowed = false) {
  const zwjBoundary = '👩‍💻'.repeat(Math.floor(max / 5)) + 'a'.repeat(max % 5);
  assert.equal(zwjBoundary.length, max);
  for (const value of [undefined, null, true, false, 0, 1, [], {}, '', 'x', zwjBoundary, zwjBoundary + 'x', 'a'.repeat(max), 'a'.repeat(max + 1),
    '😀'.repeat(max / 2), '😀'.repeat(max / 2) + 'x', 'e\u0301'.repeat(max / 2), 'e\u0301'.repeat(max / 2) + 'x']) {
    add(kind, `${path} UTF16/type ${Array.from(JSON.stringify(value) ?? "undefined").slice(0, 40).join("")}`, edit(base, path, value));
  }
  assert.equal(schemaFor[kind].safeParse(edit(base, path, '')).success, emptyAllowed);
}
add('identity', 'baseline identity', identity); add('target', 'baseline target', target);
add('grant', 'baseline grant', grant); add('command', 'baseline command', command);
const { taskId, ...commonIdentity } = identity;
const profileIdentity = { ...commonIdentity, profileId: taskId };
const { goal, ...commonGrant } = grant;
const profileGrant = { ...commonGrant, identity: profileIdentity, purpose: 'chat-tools' };
add('identity', 'profile identity', profileIdentity);
add('grant', 'goal-free profile grant', profileGrant);
add('command', 'profile command', { ...command, identity: profileIdentity });
strings('identity', profileIdentity, 'profileId', 256);
for (const bad of [commonIdentity, { ...identity, profileId: taskId }]) {
  add('identity', 'both/neither scope', bad);
  add('grant', 'both/neither grant scope', { ...profileGrant, identity: bad });
  add('command', 'both/neither command scope', { ...command, identity: bad });
}
for (const bad of [{ ...profileGrant, goal }, { ...profileGrant, identity },
  { ...grant, identity: profileIdentity }, { ...grant, purpose: 'chat-tools' },
  { ...profileGrant, purpose: undefined }, { ...profileGrant, purpose: 'task' },
  { ...grant, goal: undefined }, { ...grant, goal: '' }]) add('grant', 'scope metadata mismatch', bad);
for (const key of Object.keys(identity)) strings('identity', identity, key, 256);
for (const key of ['appId', 'processInstanceId', 'windowId', 'windowInstanceId']) strings('target', target, key, 256);
strings('grant', grant, 'grantId', 256); strings('grant', grant, 'requester', 200); strings('grant', grant, 'goal', 2000);
strings('command', command, 'grantId', 256); strings('command', command, 'commandId', 256);
for (const key of ['allowControl', 'allowCapture']) {
  for (const value of [undefined, null, false, true, 0, 1, 0.5, -1, 2, 'true', 'false', [], {}]) add('grant', `${key} strict ${JSON.stringify(value)}`, edit(grant, key, value));
}
const numeric = [undefined, null, false, true, '1', -1, -0.5, 0, 0.5, 1, 1.5, 9007199254740991, 1e100];
add('grant', 'fractional epoch-millisecond expiresAt rejected', edit(grant, 'expiresAt', 1800000000000.5));
add('command', 'fractional epoch-millisecond deadlineAt rejected', edit(command, 'deadlineAt', 1800000000000.5));
for (const key of ['epoch', 'expiresAt']) for (const value of numeric) add('grant', `${key} strict ${value}`, edit(grant, key, value));
for (const key of ['epoch', 'deadlineAt']) for (const value of numeric) add('command', `${key} strict ${value}`, edit(command, key, value));
for (const value of numeric) add('target', `pid strict ${value}`, edit(target, 'processId', value), typeof value === 'number' && value > 2147483647 ? false : undefined);
for (const value of [2147483647, 2147483648]) add('target', `pid_t bound ${value}`, edit(target, 'processId', value), value > 2147483647 ? false : undefined);
for (const count of [0, 1, 8, 9]) add('grant', `target count ${count}`, edit(grant, 'targets', Array(count).fill(target)));
for (const [kind, base] of [['identity', identity], ['target', target], ['grant', grant], ['command', command]]) {
  add(kind, 'unknown key', { ...base, extra: true });
  for (const key of Object.keys(base)) add(kind, `missing ${key}`, edit(base, key, undefined));
}
add('grant', 'unknown identity property', edit(grant, 'identity.extra', 'x'));
add('command', 'unknown target property', edit(command, 'action.target.extra', 'x'));
add('command', 'unknown action property', edit(command, 'action.extra', true));
add('command', 'unknown action kind', edit(command, 'action.kind', 'shell'));
add('command', 'unknown protocol', edit(command, 'protocol', 'wrong'));
add('grant', 'unknown protocol', edit(grant, 'protocol', 'wrong'));
const actions = [
  { kind: 'observe', target }, { kind: 'capture', target, observationId: 'obs' }, { kind: 'focus', target, observationId: 'obs' },
  ...['invoke', 'select'].map(kind => ({ kind, target, observationId: 'obs', ref: 'ref' })),
  { kind: 'setValue', target, observationId: 'obs', ref: 'ref', text: 'text' },
  { kind: 'scroll', target, observationId: 'obs', ref: 'ref', deltaY: 600 },
  ...['click', 'visualInvoke'].map(kind => ({ kind, target, observationId: 'obs', frameId: 'frame', x: 0, y: 1 })),
  { kind: 'key', target, observationId: 'obs', key: 'Enter' },
];
for (const action of actions) {
  const base = { ...command, action };
  add('command', `${action.kind} well-formed (not authority)`, base);
  for (const key of ['observationId', 'ref', 'frameId'].filter(key => key in action)) strings('command', base, `action.${key}`, 256);
  if (action.kind === 'setValue') {
    strings('command', base, 'action.text', 4096, true);
    add('command', 'native text assignment forbids NUL', edit(base, 'action.text', 'a\0b'), false);
  }
  if (action.kind === 'scroll') for (const value of [...numeric, -601, -600, -1, 0, 600, 601]) add('command', `deltaY strict ${value}`, edit(base, 'action.deltaY', value));
  if (['click', 'visualInvoke'].includes(action.kind)) for (const key of ['x', 'y']) for (const value of numeric) add('command', `click ${key} strict ${value}`, edit(base, `action.${key}`, value));
  if (action.kind === 'key') for (const key of ['Tab', 'Shift+Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Enter', '', 'Delete', true, 1, null]) add('command', `key enum ${key}`, edit(base, 'action.key', key));
}
function request(name, value, expected) { vectors.push({ kind: 'request', name, value, expected }); }
const envelope = (method, payload) => ({ id: 'request', method, payload });
request('permission requests are main-only, never private helper commands', envelope('requestAccessibility', {}), false);
for (const [method, payload] of [['start', { grant, leaseId: 'lease' }], ['execute', { command, leaseId: 'lease' }],
  ['beginApproval', { command, leaseId: 'lease' }], ['endApproval', { command, leaseId: 'lease', approved: true }],
  ['capabilities', {}], ['listTargets', {}]]) {
  const base = envelope(method, payload);
  request(`${method} valid wrapper`, base, true);
  for (const diagnostics of [true, false, 0, 1, 'true', 'false', null, [], {}, { enabled: true }]) {
    request(`${method} diagnostics strict CFBoolean ${JSON.stringify(diagnostics)}`, { ...base, diagnostics }, typeof diagnostics === 'boolean');
  }
  request(`${method} diagnostics missing stays off`, base, true);
  request(`${method} payload diagnostics is not an option`, edit(base, 'payload.diagnostics', true), false);
  request(`${method} no request version option`, { ...base, diagnosticsVersion: 1 }, false);
  request(`${method} extra envelope key with diagnostics`, { ...base, diagnostics: true, target: 'PRIVATE_CONTENT' }, false);
  for (const id of ['A-Z_09', 'a'.repeat(256), '', 'a'.repeat(257), 'contains space', 'id\n', '😀', '👩‍💻', 'a/b', 'goal:secret']) {
    request(`${method} safe diagnostic request correlation ${JSON.stringify(id)}`, { ...base, id, diagnostics: true }, /^[A-Za-z0-9_-]{1,256}$/.test(id));
  }
  request(`${method} extra wrapper key`, { ...base, extra: true }, false);
  request(`${method} extra payload key`, edit(base, 'payload.extra', true), false);
  for (const key of ['id', ...('leaseId' in payload ? ['payload.leaseId'] : [])]) for (const value of [undefined, '', true, 1, null, 'a'.repeat(256), 'a'.repeat(257), '😀'.repeat(128), '😀'.repeat(129), '👩‍💻'.repeat(51) + 'a', '👩‍💻'.repeat(51) + 'aa']) {
    request(`${method} ${key} limit/type`, edit(base, key, value), typeof value === 'string' && value.length > 0 && value.length <= 256);
  }
}
for (const approved of [undefined, null, false, true, 0, 1, 'false', 'true', [], {}]) request(`strict approved ${JSON.stringify(approved)}`,
  edit(envelope('endApproval', { command, leaseId: 'lease', approved: true }), 'payload.approved', approved), typeof approved === 'boolean');
const visualCommand = { ...command, action: actions.find(a => a.kind === 'visualInvoke') };
for (const approved of [undefined, null, false, true, 0, 1, 'true', [], {}]) {
  for (const bindingId of [undefined, null, '', false, 1, {}, [], 'binding', 'a'.repeat(256), 'a'.repeat(257)]) {
    request('visual approval strict binding and boolean', envelope('endApproval', {
      command: visualCommand, leaseId: 'lease', approved, bindingId,
    }), typeof approved === 'boolean' && typeof bindingId === 'string' && bindingId.length > 0 && bindingId.length <= 256);
  }
}
for (const method of ['beginApproval', 'execute']) {
  request(`${method} visual valid`, envelope(method, { command: visualCommand, leaseId: 'lease' }), true);
  request(`${method} rejects client-resolved binding`, envelope(method, { command: visualCommand, leaseId: 'lease', bindingId: 'forged' }), false);
}
request('semantic approval rejects visual binding', envelope('endApproval', { command, leaseId: 'lease', approved: true, bindingId: 'forged' }), false);
request('invalid command cannot use cancellation path', envelope('endApproval', { command: {}, leaseId: 'lease', approved: false }), false);
request('invalid raw unsupported click boolean', envelope('execute', { command: { ...command, action: { ...actions.find(a => a.kind === 'click'), x: true } }, leaseId: 'lease' }), false);
request('invalid numeric grant boolean', envelope('start', { grant: { ...grant, allowControl: 1 }, leaseId: 'lease' }), false);
request('unknown method', envelope('shell', {}), false);
add('grant', 'diagnostics is not grant authority', { ...grant, diagnostics: true });
add('command', 'diagnostics is not model command authority', { ...command, diagnostics: true });
add('command', 'diagnostics is not action authority', edit(command, 'action.diagnostics', true));

// Boundary oracle for the production SourceSpan/SourceClock DTO producer. These
// are synthetic interval inputs, never accepted on the helper request wire.
const uuids = { instanceId: '8d183d9b-aaef-454c-8568-53c2c7023d2d', clockId: 'bf6d03d8-dbc0-4d26-a0cc-0a09f5395910' };
const span = (phase, startUs = 100, endUs = 200, status = 'returned') => ({ phase, startUs, endUs, status });
function timingVector(name, method, root, api, requestId = 'source_request-1') {
  const spans = [root, ...(api === undefined ? [] : [api])].map(s => ({ ...s, durationUs: s.endUs - s.startUs }));
  vectors.push({ kind: 'timingSource', name, value: { requestId, method, root, ...(api === undefined ? {} : { api }) },
    expected: timingSchemas.HelperTimingSchema.safeParse({ version: 1, ...uuids, requestId, method, spans }).success });
}
for (const method of ['capabilities', 'listTargets', 'start', 'beginApproval', 'endApproval', 'execute', 'shell']) {
  for (const phase of ['request', 'observe_request', 'capture_request', 'api_invoke', 'unknown']) timingVector(`${method}/${phase} source nesting`, method, span(phase));
}
for (const phase of ['request', 'observe_request', 'capture_request']) for (const api of ['api_set_value', 'api_invoke', 'api_select', 'api_scroll', 'request', 'unknown']) {
  timingVector(`${phase}/${api} child nesting`, 'execute', span(phase), span(api, 120, 150));
}
for (const [start, end] of [[0, 0], [100, 100], [100, 200], [99, 150], [100, 201], [200, 100], [100, 100.5], [true, 150], [100, false], [100, '150']]) {
  timingVector(`API bounds ${start}/${end}`, 'execute', span('request'), span('api_invoke', start, end, 'failed'));
}
for (const [start, end] of [[0, 900000000], [0, 900000001], [100, 99], [-1, 100], [0.5, 100], [0, 100.5],
  [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1], [false, 100], [0, true], ['0', 100]]) {
  timingVector(`request source interval ${start}/${end}`, 'execute', span('request', start, end));
}
for (const status of ['returned', 'failed', 'delivered', 'not_dispatched', '', true, 1]) timingVector(`API status ${status}`, 'execute', span('request'), span('api_set_value', 120, 150, status));
for (const id of ['id', 'a'.repeat(256), '', 'a'.repeat(257), 'value:secret', '😀', 'id\n']) timingVector(`correlation privacy ${JSON.stringify(id)}`, 'execute', span('request'), undefined, id);


console.log(`PASS source guards and ${vectors.length} shared-schema/explicit wrapper vectors generated. These checks alone do not execute Swift.`);
if (args.includes('--foundation')) {
  const temporary = await mkdtemp(join(tmpdir(), 'brian-wire-boundary-'));
  try {
    const aliases = helper.match(/^typealias Object = .*$/m)[0] + '\n' + helper.match(/^let proto = .*$/m)[0];
    const clock = helper.match(/^func monotonic\(\).*$/m)[0];
    const tests = await readFile(new URL('./WireBoundaryTests.swift', import.meta.url), 'utf8');
    const clickIntent = await readFile(new URL('./ClickIntent.swift', import.meta.url), 'utf8');
    // Reuse the existing pure validator suite, not an alternate schema. This
    // runner owns main.swift; remove only the suite's standalone entry attribute.
    const clickTests = (await readFile(new URL('./ClickIntentTests.swift', import.meta.url), 'utf8')).replace('@main\n', '');
    const main = join(temporary, 'main.swift'), binary = join(temporary, 'wire-tests'), data = join(temporary, 'vectors.json'), timingOutput = join(temporary, 'timings.json');
    await writeFile(main, `import Foundation\nimport CoreFoundation\nimport Dispatch\n${aliases}\n${block}\n${clock}\n${clickIntent}\n${tests}\n${clickTests}\nClickIntentTests.main()`);
    await writeFile(data, JSON.stringify(vectors));
    const libraries = args.filter(arg => arg.startsWith('--library-path=')).flatMap(arg => {
      const path = arg.slice('--library-path='.length); return ['-L', path, '-Xlinker', '-rpath', '-Xlinker', path];
    });
    const compiled = spawnSync('swiftc', ['-swift-version', '5', ...libraries, main, '-o', binary], { stdio: 'inherit', timeout: 120000 });
    assert.equal(compiled.status, 0, `Foundation-only test compilation failed: ${compiled.error ?? compiled.signal ?? ''}`);
    for (const flag of [undefined, 'false', 'true']) {
      const env = { ...process.env };
      for (const key of ['NATIVE_COMPUTER_ENABLED', 'NATIVE_COMPUTER_PILOT_ACCEPTED']) {
        if (flag === undefined) delete env[key]; else env[key] = flag;
      }
      const run = spawnSync(binary, [data, timingOutput], { stdio: 'inherit', timeout: 30000, env });
      assert.equal(run.status, 0, `Foundation tests failed with flags ${flag}: ${run.error ?? run.signal ?? ''}`);
    }
    const responses = JSON.parse(await readFile(timingOutput, 'utf8'));
    let timed = 0;
    for (const response of responses) {
      const { envelope: result, method, expectedTiming } = response;
      assert.deepEqual(Object.keys(result).sort(), ['id', 'ok', 'result', ...(method === 'capabilities' ? ['diagnosticsVersion'] : []), ...(expectedTiming ? ['diagnostics'] : [])].sort());
      if (method === 'capabilities') assert.equal(result.diagnosticsVersion, 1);
      assert.equal(result.result.diagnosticsVersion, undefined);
      if (response.probe) {
        if (method === 'capabilities') schemas.CapabilitiesSchema.parse(result.result);
        if (method === 'execute') schemas.ReceiptSchema.parse(result.result);
        if (expectedTiming) assert.equal(result.diagnostics.spans.length, 1, 'Probe/refusal never claims an API call');
      }
      if (expectedTiming) {
        const timing = timingSchemas.HelperTimingSchema.parse(result.diagnostics);
        assert.equal(timing.requestId, result.id); assert.equal(timing.method, method);
        assert(!JSON.stringify(timing).includes('PRIVATE_CONTENT'));
        timed++;
      } else assert.equal(result.diagnostics, undefined);
    }
    console.log(`PASS ${responses.length} Foundation-generated private envelopes (${timed} timed) against canonical HelperTimingSchema; no native API execution.`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
} else {
  console.log('SKIP Foundation execution (use --foundation with Swift installed). No native AppKit/Security compilation or SDK acceptance claimed.');
}
