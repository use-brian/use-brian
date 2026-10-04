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
  assert.equal(f.calls.length, 5);
  assert(f.calls[0].args.includes('ProcessIdentity.c'));
  assert(f.calls[1].args.includes('BootstrapApprovalAnchor.c'));
  assert(f.calls[2].args.includes('ProcessEpochFence.c'));
  const helper = f.calls[3];
  for (const file of ['ClickIntent.swift', 'ClickGuardianNative.swift', 'ClickGuardianHost.swift', 'ProcessEpochFence.swift', 'LibraryConstraintPolicy.swift', 'MachOLibraryConstraint.swift', 'BootstrapApproval.swift', 'BootstrapApprovalReader.swift', 'BootstrapProcessBinding.swift', 'ElectronFrameworkBinding.swift']) assert(helper.args.includes(file), file);
  assert(helper.args.some(a => a.endsWith('/BootstrapApprovalAnchor.o')));
  assert.equal(helper.mainSource, readFileSync(join(f.source, 'Helper.swift'), 'utf8'));
  assert.equal(helper.temporaryMode, 0o700);
  assert(f.calls[4].args.includes('Fixture.swift'));
  assert(helper.args.some(a => a.endsWith('/ProcessEpochFence.o')));
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

test('capture is dual-consented, target-only and revalidated before SCK and frame export', () => {
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  const broker = helper.slice(helper.indexOf('final class Broker:'));
  const section = (from, to) => broker.slice(broker.indexOf(from), broker.indexOf(to));
  const execute = section('    func execute(', '    func rect(');
  for (const gate of ['validWirePayload("execute", payload)', 'supportedExecution(command)', 'wireBool(grant?["allowControl"]) == true',
    'kind != "capture" || captureAuthority(grant)', 'approvalCommand == nil', 'authorized(command,',
    'watchdogDeadline = min(expiresMonotonic, commandDeadline)', 'liveWindow(target)']) {
    assert(execute.indexOf(gate) >= 0 && execute.indexOf(gate) < execute.indexOf('capture(command,'), gate);
  }
  const canvas = section('    func safeCanvas(', '    func visibleWindowID(');
  for (const gate of ['liveWindow(window.target)', 'window.target["appId"] as? String == cohort', 'kAXTitleAttribute) == canvasTitle',
    'brian-safe-canvas-v1', 'hasNoSheetChildren(window.element)', '"completeness"] as? String == "complete"',
    '"sensitive"] as? Bool == false', '"role"] as? String != kAXSheetRole', '.isEmpty', 'unchanged(snapshot, window)']) assert(canvas.includes(gate), gate);
  const visible = section('    func visibleWindowID(', '    private func pixels(');
  for (const gate of ['CGDisplayBounds($0).contains(r)', 'CGDisplayRotation($0) == 0', '.count == 1', '.optionOnScreenOnly',
    'window.target["processId"]', 'area == r', '== captureWindowTitle(window)', 'area.intersects(r)', '> 0 { return nil }']) assert(visible.includes(gate), gate);
  const pixels = section('    private func pixels(', '    private func captureStillValid(');
  for (const gate of ['captureAuthority(grant)', 'authorized(command, lease)', 'fresh(action, window) != nil', 'captureCohort(window, snapshot)',
    'CGPreflightScreenCaptureAccess()', 'visibleWindowID(window)']) {
    assert(pixels.indexOf(gate) >= 0 && pixels.indexOf(gate) < pixels.indexOf('SCShareableContent.getExcludingDesktopWindows'), gate);
  }
  assert.match(pixels, /SCShareableContent.getExcludingDesktopWindows\(true, onScreenWindowsOnly: true\)/);
  assert.match(pixels, /SCContentFilter\(desktopIndependentWindow: selected\)/);
  for (const gate of ['$0.windowID == number', 'selected.owningApplication?.processID == pid_t(window.target["processId"] as! Int)',
    'selected.frame == self.rect(expectedBounds)', 'self.captureStillValid(command, action, window, snapshot)', 'self.visibleWindowID(window) == number',
    'configuration.width <= 1024', 'configuration.height <= 1024', 'configuration.showsCursor = false', 'configuration.ignoreShadowsSingleWindow = true']) {
    assert(pixels.indexOf(gate) >= 0 && pixels.indexOf(gate) < pixels.indexOf('SCScreenshotManager.captureImage'), gate);
  }
  assert.match(pixels, /guard brian_private_channel_alive\(\) == 1 else \{ done.signal\(\); return \}\s*SCScreenshotManager.captureImage/);
  assert(pixels.includes('image.width == configuration.width, image.height == configuration.height'));
  assert(pixels.includes('png.count <= 2_000_000'));
  assert(pixels.indexOf('guard captureStillValid(command, action, window, snapshot), visibleWindowID(window) == number') > pixels.indexOf('done.wait()'));
  const valid = section('    private func captureStillValid(', '    private func capture(');
  for (const gate of ['captureAuthority(grant)', 'authorized(command, lease)', 'fresh(action, window) != nil', 'captureCohort(window, snapshot)',
    'CGPreflightScreenCaptureAccess()', 'brian_private_channel_alive() == 1']) assert(valid.includes(gate), gate);
  const capture = section('    private func capture(', '    func reachable(');
  for (const gate of ['frame = nil; frameObservation = ""', 'captureAuthority(grant)', 'authorized(command, lease)', 'CGPreflightScreenCaptureAccess()',
    'monotonic() - lastCapture >= 1000', 'fresh(action, window)', 'captureCohort(window, snapshot)']) {
    assert(capture.indexOf(gate) >= 0 && capture.indexOf(gate) < capture.indexOf('pixels(command,'), gate);
  }
  assert(capture.indexOf('captureStillValid(command, action, window, snapshot)') > capture.indexOf('pixels(command,'));
  assert(capture.indexOf('captureStillValid(command, action, window, snapshot)') < capture.indexOf('png.base64EncodedString()'));
  assert.equal((helper.match(/SCScreenshotManager.captureImage/g) ?? []).length, 1);
  assert(!/CGRequestScreenCaptureAccess|CGEvent\(mouseEventSource:|\.post\(tap:|SCContentFilter\(display:/.test(helper));
  assert(!pixels.includes('beginAPI')); // Root capture_request only; no fabricated AX span.
});

test('semantic approval and effect guards precede restoration and native dispatch', () => {
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  const broker = helper.slice(helper.indexOf('final class Broker:'));
  const section = (from, to) => broker.slice(broker.indexOf(from), broker.indexOf(to));
  const start = section('    func start(', '    func authorized(');
  assert(start.indexOf('monitorScope(window)') < start.indexOf('restoreApprovedWindow(window,'));
  assert(start.indexOf('watchdogActive = true') < start.indexOf('restoreApprovedWindow(window,'));
  assert.match(start, /if wireBool\(candidate\["allowControl"\]\) == true \{\s*guard restoreApprovedWindow/);
  const begin = section('    func beginApproval(', '    func endApproval(');
  for (const gate of ['validWirePayload("beginApproval", payload)', 'authorized(command,', 'fresh(action, window)', 'permittedSemantic(action, snapshot)', 'unchanged(snapshot, window)']) {
    assert(begin.indexOf(gate) >= 0 && begin.indexOf(gate) < begin.indexOf('approvalCommand = command'), gate);
  }
  assert(begin.includes('semanticSafety.admit(id: commandID, fingerprint: fingerprint(command)'));
  assert(begin.includes('watchdogDeadline = min(expiresMonotonic, retained)'));
  const end = section('    func endApproval(', '    func execute(');
  for (const gate of ['validWirePayload("endApproval", payload)', 'exactSemanticCommand(command, pending)', 'authorized(command,', 'if !approved', 'permittedSemantic(action, snapshot)']) {
    assert(end.indexOf(gate) >= 0 && end.indexOf(gate) < end.indexOf('restoreApprovedWindow(window,'), gate);
  }
  assert.match(end, /defer \{ approvalCommand = nil \}/);
  assert(end.indexOf('approvedCommand = nil') < end.indexOf('validWirePayload'));
  assert(end.indexOf('unchanged(snapshot, window)') < end.indexOf('approvedCommand = command'));
  assert(end.lastIndexOf('authorized(command,') > end.indexOf('restoreApprovedWindow(window,'));
  const execute = section('    func execute(', '    func rect(');
  const effect = execute.indexOf('        var error: AXError');
  for (const gate of ['validWirePayload("execute", payload)', 'supportedExecution(command)', 'approvalCommand == nil', 'authorized(command,',
    'journal[commandId] = result("helper_error", "execution_unknown")', 'exactSemanticCommand(command, approved)', 'approvedCommand = nil',
    'permittedSemantic(action, completeSnapshot)', 'unchanged(snapshot, window)', 'fresh(action, window) != nil', 'current.complete']) {
    assert(execute.indexOf(gate) >= 0 && execute.indexOf(gate) < effect, gate);
  }
  assert(execute.includes('if kind == "capture" { return finish(capture(command, action, window)) }'));
  assert(execute.indexOf('captureAuthority(grant)') < execute.indexOf('capture(command,'));
  assert.match(execute, /snapshots.removeAll\(\)/);
  assert.match(execute, /guard error == .success else \{\s*semanticSafety.markUncertain\(\)[^\n]*\n\s*return finish\(result\("helper_error", "execution_unknown"\)\)/);
  const authority = section('    func authorized(', '    func validCommand(');
  for (const gate of ['trust.parentValid()', 'leaseId == lease', 'same(identity, owner)', 'command["grantId"]', 'command["epoch"]',
    'now() < expiry', 'monotonic() < expiresMonotonic', 'monotonic() < commandDeadline', 'now() < deadline',
    'same($0, target)', 'liveWindow(target) != nil', 'AXIsProcessTrusted()', 'brian_private_channel_alive() == 1']) assert(authority.includes(gate), gate);
  // These are placement regressions, not native AX/Stop delivery evidence.
});

test('click preparation uses native cache, unchanged PNG and anchored ages without releasing input', () => {
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  const broker = helper.slice(helper.indexOf('final class Broker:'));
  const section = (from, to) => broker.slice(broker.indexOf(from), broker.indexOf(to));
  assert(broker.includes('private func clickOwnerReady() -> Bool { guardianInvalidation == nil && brian_pipe_endpoints_alive(3, 3) == 1 }'));
  const native = section('    private func clickSnapshot(', '    func prepareClick(');
  for (const gate of ['authorized(command, leaseId)', 'captureAuthority(grant)', 'CGPreflightScreenCaptureAccess()',
    'CGEvent.tapIsEnabled(tap: tap)', 'liveWindow(target)', 'fresh(action, window)', 'unchanged(snapshot, window)',
    'safeCanvas(window, snapshot)', 'let frame = frame', 'let captured = frameMonotonic', 'bounds(window.element)',
    'currentLayout: layout()', 'frameObservationID: frameObservation', 'observationMonotonicMs: snapshot.monotonic',
    'grantDeadlineMonotonicMs: expiresMonotonic', 'commandDeadlineMonotonicMs: deadline']) assert(native.includes(gate), gate);
  const prepare = section('    func prepareClick(', '    func handoffClick(');
  for (const gate of ['clickOwnerReady()', 'let approved = approvedCommand', 'exactLocalCommand(command, approved)',
    'let before = clickSnapshot(command, leaseId)', 'pixels(command, action, window, snapshot)',
    'png.base64EncodedString() == before.frame["data"] as? String', 'Double(width)', 'Double(height)',
    'let after = clickSnapshot(command, leaseId)', 'same(before.frame, after.frame)',
    'before.frameMonotonicMs == after.frameMonotonicMs', 'snapshot: after']) assert(prepare.includes(gate), gate);
  assert(prepare.indexOf('exactLocalCommand') < prepare.indexOf('pixels(command,'));
  assert(prepare.indexOf('let after = clickSnapshot') > prepare.indexOf('png.base64EncodedString()'));
  assert(!/frameMonotonic\s*=|snapshots\[.*\]\s*=|approvedCommand\s*=/.test(prepare));
  const local = section('    private func beginLocalApproval(', '    func beginApproval(');
  assert(local.includes('let anchored = monotonic() + min(30_000, deadline - now())'));
  assert(local.includes('let retained = min(localDeadlines[commandID] ?? anchored, anchored)'));
  assert(local.includes('localDeadlines[commandID] = retained'));
  assert(local.includes('exactLocalCommand(command, pending)'));
  assert(local.includes('approvedCommand = pending'));
  assert(local.includes('prepareClick(command, leaseId:'));
  assert(local.includes('restored.inputMonotonic = monotonic()'));
  assert(!local.includes('Snapshot(observation:'));
  assert(!local.includes('frameMonotonic ='));
  assert(!local.includes('permittedSemantic'));
  const capture = section('    private func capture(', '    func reachable(');
  assert(capture.indexOf('let captureStarted = monotonic()') < capture.indexOf('pixels(command,'));
  assert(capture.includes('frameMonotonic = captureStarted'));
  assert(capture.includes('snapshots[frameObservation] = Snapshot(observation: observation, refs: snapshot.refs, monotonic: snapshot.monotonic, inputMonotonic: snapshot.inputMonotonic)'));
  // Only capture may set a non-nil frame time; approval cannot rejuvenate it.
  assert.equal((broker.match(/frameMonotonic = captureStarted/g) ?? []).length, 1);
  const execute = section('    func execute(', '    func rect(');
  assert(helper.includes('let prepared = prepareClick(command, leaseId:'));
  assert(helper.includes('guardianWorkerHandoff(requestID: requestID, descriptor: prepared.descriptor'));
  assert(execute.includes('guard supportedExecution(command) else { return result("denied") }'));
  assert(execute.includes('if kind == "click" { return result("unsupported") }'));
  assert(helper.includes('return kind == "observe" || kind == "capture" || kind == "visualInvoke" || semanticKind(kind)'));
  assert(helper.includes('if let backend = backend, supportedExecution(command)'));
  assert.equal((helper.match(/"input": false/g) ?? []).length, 3); // Includes inert timeout-configuration failure.
  assert(!helper.includes('"input": inputReady'));
  assert(!/CGEvent\(mouseEventSource:|\.post\(tap:|CGEventPost/.test(helper));
  const intent = readFileSync(new URL('./ClickIntent.swift', import.meta.url), 'utf8');
  for (const gate of ['equal(command, approved)', 'equal(embeddedFrame, frame)', 'equal(bounds, s.currentBounds)',
    'frame["displayLayoutVersion"] as? String == s.currentLayout', 'clock.monotonicMs - timestamp < 5_000',
    's.frameObservationID', 'rect.0 + x * scaleX', 'rect.1 + y * scaleY']) assert(intent.includes(gate), gate);
  // Source placement only: not evidence of an owner, native delivery or release.
});

// Source contracts only. Not native lifecycle, cleanup or platform acceptance.
test('guardian native scope uses private descriptor, shared validators and independent invalidation', () => {
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  const host = readFileSync(new URL('./ClickGuardianHost.swift', import.meta.url), 'utf8');
  const native = readFileSync(new URL('./ClickGuardianNative.swift', import.meta.url), 'utf8');
  assert(helper.includes('helperArguments.isEmpty || helperArguments == ["--click-guardian"]'));
  assert(helper.indexOf('guard let trust = ProcessTrust()') < helper.indexOf('ClickGuardianHost(trust: trust).run()'));
  assert(helper.includes('let handoff = backend?.handoffClick(payload, requestID: requestId)'));
  assert(helper.includes('reservedClicks.insert(prepared.binding.commandID)'));
  assert(helper.includes('reservedFrames.insert(prepared.binding.frameID)'));
  assert(helper.includes('uniqueCanvasWindow(window, descriptor.windowNumber)'));
  assert(helper.includes('for _ in 0..<2'));
  assert(helper.includes('discoverTargets(only: descriptor.pid, standingFence: epochFence)'));
  assert(host.includes('liveness.pinEpochFences(worker: workerFence, parent: parentFence)'));
  assert(helper.includes('clickTransferred = true'));
  assert(helper.includes('if clickSpent || clickTransferred'));
  assert(helper.includes('guard readbackOnly, readbackMonitorInstalled,'));
  assert(helper.includes('ClickScopeDescriptor.digest(png) == descriptor.pngDigest'));
  assert(host.includes('broker.reconstructClick'));
  for (const token of ['value.removeValue(forKey: "ref")', 'value.removeValue(forKey: "parentRef")',
    'value["parentIndex"] = parentIndex', 'options: [.sortedKeys]', 'String(identity.birth)', 'ProcessIdentity.read(identity.pid) == identity',
    'descriptor.matchesProcess(nativeTarget)', 'broker.reconstructClick', 'broker.revalidateGuardianClick',
    'candidate.startProbe()', 'candidate.execute(intent)', 'prepared?.validates(intent)',
    'candidate.sequenceAttempted', 'case .inputStreamReleasedCandidate']) assert(host.includes(token), token);
  assert(!host.includes('nativeScopeUnavailable'));
  assert(!host.includes('_AXUIElementGetWindow'));
  assert(!host.includes('brian_kernel_signing_snapshot('));
  const callback = host.slice(host.indexOf('let candidate = ClickGuardianNative(validateCurrentScope:'), host.indexOf('self.candidate = candidate'));
  assert(!/AXUIElement|signedProcess|parentValid|ProcessIdentity.read|DispatchQueue.*sync/.test(callback));
  assert(host.includes('guard lock.try() else { return false }'));
  assert(host.includes('takeUnretainedValue().invalidate()'));
  assert.match(native, /static let profiles: \[ClickGuardianPlatformProfile\] = \[\]/);
  assert.match(native, /static func acceptsCurrentPlatform\(\) -> Bool \{\s*return false\s*\}/);
  assert(!native.includes('currentMetadata()'));
  assert(native.includes('place: .tailAppendEventTap'));
  assert(!native.includes('tail.sealProducer()'));
  assert(!native.includes('tapPostEvent('));
  assert(!native.includes('Unmanaged.passRetained(up)'));
  assert(native.includes('tail.complete, let port = tap, let end = tailTap'));
});

// Placement only, not execution/native acceptance. These tests are written only.
test('accepted stream return keeps overlapping monitors and opens only readback', () => {
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  const host = readFileSync(new URL('./ClickGuardianHost.swift', import.meta.url), 'utf8');
  const native = readFileSync(new URL('./ClickGuardianNative.swift', import.meta.url), 'utf8');
  const start = helper.indexOf('    func handoffClick(', helper.indexOf('final class Broker:'));
  const handoff = helper.slice(start, helper.indexOf('    private func localApprovalKind', start));
  assert(handoff.includes('guard !clickSpent, validWirePayload("execute", payload)'));
  assert(handoff.indexOf('clickSpent = true') < handoff.indexOf('guardianWorkerHandoff('));
  assert(handoff.includes('installReadbackMonitor(command, descriptor: prepared.descriptor)'));
  assert(handoff.includes('result == "delivered", clickTransferred, readbackMonitorInstalled'));
  assert(handoff.includes('return receipt("executed", "ok")'));
  assert(!handoff.includes('clickTransferred = false'));
  assert(!handoff.includes('clickSpent = false'));
  assert(!handoff.includes('reservedFrames.removeAll'));
  const returning = handoff.slice(handoff.indexOf('    private func installReadbackMonitor'));
  for (const token of ['descriptor.matches(command)', 'descriptor.matchesProcess(window.identity)',
    'same(b, descriptor.bounds)', 'layout() == descriptor.displayLayout', 'uniqueCanvasWindow(window, descriptor.windowNumber)',
    'safeCanvas(window, snapshot)', 'AXObserverAddNotification', 'watchdogActive = true',
    'CGEvent.tapEnable(tap: tap, enable: true)', 'CGEvent.tapIsEnabled(tap: tap), currentPublicScope()']) assert(returning.includes(token), token);
  assert(host.includes('candidate.completeMonitorReturn() == .inputStreamReleasedCandidate'));
  assert(host.includes('finish(reason: "monitorReturned")'));
  assert(host.indexOf('returnMonitoring()') < host.indexOf('guardianWrite(["kind": "workerMonitoring"'));
  assert(native.includes('else if monitorReturnAcknowledged && ownedStreamProven()'));
  assert(native.includes('static func hasPublicEpochFenceSupport() -> Bool'));
  assert.match(native, /static let profiles: \[ClickGuardianPlatformProfile\] = \[\]/);
  assert.match(native, /static func acceptsCurrentPlatform\(\) -> Bool \{\s*return false\s*\}/);
  assert(!native.includes('currentMetadata()'));
  const capability = helper.slice(helper.indexOf('    func capabilities()', helper.indexOf('final class Broker:')), helper.indexOf('    func listTargets()', helper.indexOf('final class Broker:')));
  assert(capability.includes('"input": false'));
  assert(capability.includes('"semanticActions": ready && !clickSpent'));
  assert(!/acceptsCurrentPlatform|CGPreflightPostEventAccess|inputReady/.test(capability));
  assert(helper.includes('clickSpent && (!readbackOnly || !["observe", "capture"].contains(kind))'));
  assert(helper.includes('Native refs/snapshot keep their original actions'));
});

test('public standing epoch fences span admission and authenticated monitor overlap', () => {
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  const host = readFileSync(new URL('./ClickGuardianHost.swift', import.meta.url), 'utf8');
  const c = readFileSync(new URL('./ProcessEpochFence.c', import.meta.url), 'utf8');
  const discovery = helper.slice(helper.indexOf('    private func discoverTargets'), helper.indexOf('    func liveWindow'));
  assert(discovery.indexOf('ProcessEpochFence(pid:') < discovery.indexOf('trust.target('));
  assert(discovery.includes('epochFence: epochFence'));
  assert(host.indexOf('let targetFence = ProcessEpochFence(') < host.indexOf('let (nativeTarget, appID) = trust.target('));
  assert(host.includes('leaseId: lease, epochFence: targetFence'));
  assert(helper.includes('let originalFence = admittedWindow.epochFence'));
  assert(helper.includes('return originalFence.clean()'));
  assert(host.includes('!transferred, transfer(), guardianWrite(["kind": "workerTransferred"'));
  assert(!host.includes('DispatchSource.makeProcessSource'));
  assert(host.includes('&& window.epochFence.clean()'));
  for (const token of ['NOTE_EXEC | NOTE_EXIT', 'EV_RECEIPT', 'FD_CLOEXEC', 'receipt.data != 0',
    'atomic_flag_test_and_set', 'if (n != 0) atomic_store', 'const struct timespec zero = {0, 0}']) assert(c.includes(token), token);
  assert(!c.includes('proc_pidinfo'));
});

// Regression for the observed last-check-to-post deadline counterexample.
// Proves source retirement, not atomic OS delivery or working coordinate input.
test('retired coordinate path refuses before all preparation and preserves uncertainty', () => {
  const native = readFileSync(new URL('./ClickGuardianNative.swift', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  const host = readFileSync(new URL('./ClickGuardianHost.swift', import.meta.url), 'utf8');
  const section = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  const execute = section(native, '    func execute(', '    func revoke(').replace(/\/\/[^\n]*/g, '');
  assert.match(execute, /checkLane\(\)\s*refuse\(\)\s*return status/);
  assert.doesNotMatch(execute, /arm\(|reserve\(|validate\(|preallocate\(|nullWake\(|post\(|scheduleExpiry\(/);
  assert.doesNotMatch(native, /tapPostEvent\(|passRetained\(up\)|tail\.reserve\(|ledger\.arm\(/);
  const receive = section(native, '    private func receive(', '    // Allocation-only seam');
  assert(receive.includes('return unchanged'));
  assert.doesNotMatch(receive, /preallocate\(|\.post\(|passRetained/);
  const handoff = section(helper.slice(helper.indexOf('final class Broker:')), '    func handoffClick(', '    private func installReadbackMonitor');
  const refusal = handoff.indexOf('guard ClickGuardianNativeAcceptedPlatforms.acceptsCurrentPlatform()');
  assert(refusal >= 0);
  for (const token of ['defer { approvedCommand = nil }', 'prepareClick(', 'clickSpent = true',
    'reservedClicks.insert', 'reservedFrames.insert', 'guardianWorkerHandoff(', 'clickTransferred = true']) {
    assert(handoff.indexOf(token) > refusal, token);
  }
  assert(handoff.includes('return clickSpent || clickTransferred\n                ? receipt("execution_unknown", "helper_error") : receipt("not_executed", "unsupported")'));
  const approval = section(helper, '    private func beginLocalApproval(', '    private func endLocalApproval(');
  assert(approval.indexOf('action["kind"] as? String == "click" { return false }') < approval.indexOf('localDeadlines[commandID] = retained'));
  const admit = section(host, '    private func admit(', '    private func acceptTransfer(');
  const gate = admit.indexOf('guard ClickGuardianNativeAcceptedPlatforms.acceptsCurrentPlatform() else { finish(reason: "platformUnaccepted") }');
  assert(gate > admit.indexOf('requestID = id'));
  for (const token of ['ClickScopeDescriptor(wire:', 'ProcessEpochFence(pid:', 'Broker(trust:', 'broker.reconstructClick', 'candidate.startProbe()']) assert(admit.indexOf(token) > gate, token);
  assert(host.includes('var status = "refused", cleanup = "neverArmedNoEmission"'));
  assert(host.includes('if candidate.sequenceAttempted { status = "sequenceAttemptedUnproven" }'));
  assert(host.includes('case .fencedLeaseRetained: cleanup = "fencedLeaseRetained"'));
  assert(native.includes('if !everArmed && !sequenceAttempted { result = .neverArmedNoEmission }'));
  assert(native.includes('else { result = .fencedLeaseRetained }'));
});
