// Metadata-only readiness smoke, NOT signing/TCC/model/Stop acceptance.
// Deliberately never sends listTargets: explicit discovery initializes AX inspection.
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bootstrapNegativeCLI } from './bootstrap-negative.mjs'

const MAX = 4 * 1024 * 1024
function decoder(deliver) {
  let buffer = Buffer.alloc(0)
  return data => {
    buffer = Buffer.concat([buffer, data])
    while (buffer.length >= 4) {
      const size = buffer.readUInt32BE(0)
      assert(size > 0 && size <= MAX)
      if (buffer.length < size + 4) return
      const message = JSON.parse(buffer.subarray(4, size + 4))
      buffer = buffer.subarray(size + 4); deliver(message)
    }
  }
}
function framed(message) {
  const body = Buffer.from(JSON.stringify(message)), head = Buffer.alloc(4)
  assert(body.length <= MAX); head.writeUInt32BE(body.length)
  return Buffer.concat([head, body])
}
if (process.argv.includes('--portable')) {
  const messages = [], decode = decoder(message => messages.push(message))
  const bytes = Buffer.concat([framed({ id: 'one' }), framed({ id: 'two' })])
  for (const byte of bytes) decode(Buffer.from([byte]))
  assert.deepEqual(messages, [{ id: 'one' }, { id: 'two' }])
  const joined = []; decoder(message => joined.push(message))(bytes)
  assert.equal(joined.length, 2)
  assert.throws(() => decoder(() => {})(Buffer.alloc(4)))
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(MAX + 1)
  assert.throws(() => decoder(() => {})(oversized))
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8')
  assert(helper.includes('"input": false'))
  const entry = helper.slice(helper.indexOf('guard let trust = ProcessTrust()'))
  assert(entry.includes('let dispatcher = ObservationDispatcher { Broker(trust: trust) }'))
  assert(entry.indexOf('guard trust.parentValid()') < entry.indexOf('dispatcher.response('))
  assert(helper.includes('guard supportedGrant(payload), grant == nil'))
  assert(helper.includes('guard supportedExecution(command) else { return result("denied") }'))
  assert(helper.includes('if childRead.elements == nil { complete = false }'))
  for (const marker of ['CFGetTypeID(number) == CFBooleanGetTypeID()', 'CFGetTypeID(number) == CFNumberGetTypeID()',
    'string.utf16.count <= max', 'validWireRequest(request)', 'supportedGrant(payload)',
    'validWirePayload("endApproval", payload)', 'let approved = wireBool(payload["approved"])',
    '(Date().timeIntervalSince1970 * 1000).rounded(.down)', '"capturedAt": now(), "monotonicMs": monotonic()']) assert(helper.includes(marker), marker)
  assert(!helper.includes('candidate["allowControl"] is Bool'))
  assert(!helper.includes('payload["approved"] as? Bool'))
  // Presence checks only. wire-boundary.mjs --foundation executes the extracted
  // pure production wire functions, never AppKit/Security or native authority.

  for (const marker of ['guard let trust = ProcessTrust() else { _exit(77) }',
    'guard trust.parentValid() else { _exit(77) }', 'SecCodeCheckValidity(code',
    'SecStaticCodeCheckValidity(disk', 'identity == window.identity',
    'signedProcess(parent, teamRequirement("ai.usebrian.desktop"), bootstrap: true) == team',
    'identity.executable == fixtureExecutable', 'liveWindow(window.target) != nil']) assert(helper.includes(marker), marker)
  assert(!helper.includes('app.bundleIdentifier'), 'Bundle-ID spoofing cannot establish authority')
  assert(!helper.includes('ProcessInfo.processInfo.environment'), 'No development authority bypass')
  const inputSource = helper.slice(helper.indexOf('    func input('), helper.indexOf('    var commandDeadline'))
  assert(!inputSource.includes('getpid()') && !inputSource.includes('eventSourceUnixProcessID'), 'No blanket self-input bypass')
  assert(inputSource.includes('guard active else { return }'))
  assert(inputSource.includes('if approving && event.getIntegerValueField(.eventTargetUnixProcessID) == Int64(getppid()) { return }'))
  assert(inputSource.includes('_exit(73)'))
  assert.equal((inputSource.match(/return/g) ?? []).length, 2, 'Only inactive and parent approval may bypass takeover')

  const executeSource = helper.slice(helper.indexOf('    func execute('), helper.indexOf('    func reachable('))
  assert(executeSource.indexOf('if kind == "click" { return result("unsupported") }') < executeSource.indexOf('if kind == "observe"'))
  assert(executeSource.includes('if kind == "click" { return result("unsupported") }'))
  assert(!/CGEvent\(mouseEventSource:|\.post\(tap:|func click\(/.test(helper), 'No coordinate emitter reachable even through raw private requests')
  assert(helper.includes('return finish(capture(command, action, window))'))
  assert(helper.includes('AXUIElementPerformAction'))
  const fixture = readFileSync(new URL('./Fixture.swift', import.meta.url), 'utf8')
  for (const marker of ['case "select":', 'case "scroll":', 'kAXIncrementAction', 'kAXDecrementAction', 'exactSemanticCommand(command, approved)', 'sameChildren(ref)', 'kind != "setValue"', 'watchdogDeadline', 'safeCanvas(window, snapshot)']) assert(helper.includes(marker), marker)
  for (const marker of ['Canvas clicks:', '.valueChanged', 'Mock send (local only)', 'Mock delete (local only)', 'NATIVE_SENTINEL', 'Duplicate action', 'window.beginSheet', 'NSPopUpButton']) assert(fixture.includes(marker), marker)
  for (const marker of ['value.unicodeScalars', 'scalar.value > 0xFFFF ? 2 : 1', 'publicAXRoles.contains(role) ? role : "AXUnknown"', '!publicAXClassification(role, subrole)', 'boundedText(value, 4096)', 'boundedText(sensitive', 'if !read.complete { complete = false }', 'current.complete && same(current.value, ref.node)', 'unchanged(completeSnapshot, window)']) assert(helper.includes(marker), marker)
  assert(!helper.includes('prefix(4096)')); assert(!helper.includes('role.prefix(100)'))
  assert.equal((helper.match(/snapshot.observation\["completeness"\] as\? String == "complete"/g) ?? []).length, 4)
  // Wire-limit vectors are JS UTF-16 checks, NOT execution of the Swift limiter.
  const boundary = '😀'.repeat(2048)
  assert.equal(boundary.length, 4096); assert.equal([...boundary].length, 2048)
  assert.equal((boundary + ' suffix-A').slice(0, 4096), (boundary + ' suffix-B').slice(0, 4096))
  assert.equal(('a'.repeat(4095) + '😀').length, 4097)
  assert.equal('e\u0301'.repeat(2048).length, 4096)
  console.log('PASS portable framing (fragmented/coalesced/invalid lengths) and source-presence checks only; no Swift compilation or macOS execution.')
  process.exit(0)
}
if (process.platform !== 'darwin') throw new Error('macOS real desktop required; use --portable for source/framing checks only')
// Legacy flag retained as an alias, not a claim that parent trust was tested.
if (process.argv.includes('--parent-negative') || process.argv.includes('--bootstrap-negative')) {
  const args = process.argv.slice(2)
  assert(args.filter(arg => arg.startsWith('--')).length === 1, 'Use only --bootstrap-negative (or legacy --parent-negative)')
  const binaries = args.filter(arg => !arg.startsWith('--'))
  assert(binaries.length <= 1, 'Expected at most one helper path')
  await bootstrapNegativeCLI([binaries[0] ?? fileURLToPath(new URL('./build/brian-native-computer-helper', import.meta.url))])
  process.exit(0)
}
if (!process.versions.electron || process.type !== 'browser') {
  throw new Error('Probe-only smoke requires integration into the signed packaged ai.usebrian.desktop main process; standalone Node cannot simulate parent authority. Use --parent-negative or --portable.')
}
assert(process.argv.slice(2).filter(arg => arg.startsWith('--')).every(arg => arg === '--probe-only'), 'Use explicit packaged inspector UI for AX acceptance; this harness checks permissionless readiness only')
const binary = process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? new URL('./build/brian-native-computer-helper', import.meta.url).pathname
const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] })
let pending
function fail(error) {
  if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined }
  child.kill('SIGKILL')
}
const decodeResponse = decoder(message => {
  try {
    assert(pending); assert.equal(message.id, pending.id); assert.equal(message.ok, true)
    const current = pending; pending = undefined; clearTimeout(current.timer); assert.equal(message.diagnosticsVersion, current.method === 'capabilities' ? 1 : undefined)
    if (current.diagnostics === true) {
      assert.equal(message.diagnostics.spans.length, 1)
      assert(!message.diagnostics.spans[0].phase.startsWith('api_'))
    } else assert.equal(message.diagnostics, undefined)
    current.resolve(message.result)
  } catch (error) { fail(error) }
})
child.stdout.on('data', data => { try { decodeResponse(data) } catch (error) { fail(error) } })
child.on('error', fail)
child.on('exit', () => fail(new Error('Helper died (timeout/takeover/permission loss possible)')))
function request(method, payload = {}, diagnostics) {
  assert(!pending, 'Serialized requests only')
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    pending = { id, method, diagnostics, resolve, reject, timer: setTimeout(() => fail(new Error('Probe timeout')), 5000) }
    child.stdin.write(framed({ id, method, payload, ...(diagnostics === undefined ? {} : { diagnostics }) }))
  })
}
try {
  for (const diagnostics of [undefined, false, true]) {
    const caps = await request('capabilities', {}, diagnostics)
    assert.equal(caps.platform, 'darwin')
    for (const bit of ['axRead', 'semanticActions', 'windowCapture', 'input']) assert.equal(caps[bit], false)
    assert.equal(caps.accessibilityPermission, 'unknown')
    assert.equal(caps.capturePermission, 'unknown')
    assert.deepEqual(caps.limitations, ['Select discovery to initialize AX and safe-fixture-canvas capture readiness; input disabled.'])
    const target = { appId: 'com.usebrian.NativeComputerFixture', processId: 42, processInstanceId: 'not-looked-up', windowId: 'not-looked-up', windowInstanceId: 'not-looked-up' }
    const identity = Object.fromEntries(['deploymentId', 'userId', 'workspaceId', 'deviceId', 'sessionId', 'conversationId', 'taskId'].map(key => [key, randomUUID()]))
    const grant = { protocol: 'native-computer-v1', identity, grantId: randomUUID(), epoch: 1, expiresAt: Date.now() + 60000, targets: [target], allowControl: true, allowCapture: true, requester: 'Untrusted protocol assertion', goal: 'Must never authorize' }
    const leaseId = randomUUID()
    assert.equal(await request('start', { grant, leaseId }, diagnostics), false)
    for (const kind of ['observe', 'capture', 'invoke', 'select', 'scroll', 'setValue', 'click', 'key', 'focus']) {
      const action = { kind, target, ...(kind === 'observe' ? {} : { observationId: 'not-looked-up' }),
        ...(['invoke', 'select', 'scroll', 'setValue'].includes(kind) ? { ref: 'not-looked-up' } : {}),
        ...(kind === 'scroll' ? { deltaY: 1 } : {}), ...(kind === 'setValue' ? { text: 'never written' } : {}),
        ...(kind === 'click' ? { frameId: 'not-looked-up', x: 0, y: 0 } : {}), ...(kind === 'key' ? { key: 'Enter' } : {}) }
      const command = { protocol: grant.protocol, identity, grantId: grant.grantId, epoch: 1, commandId: randomUUID(), deadlineAt: Date.now() + 4000, action }
      assert.equal(await request('beginApproval', { command, leaseId }, diagnostics), false)
      assert.equal(await request('endApproval', { command, leaseId, approved: true }, diagnostics), false)
      assert.deepEqual(await request('execute', { command, leaseId }, diagnostics), { commandId: command.commandId, code: 'denied', outcome: 'not_executed' })
    }
  }
  console.log('PASS signed-parent metadata-only readiness responses and direct protocol refusals. Not operational bootstrap/TCC/AX acceptance.')
} finally { child.kill('SIGKILL') }
