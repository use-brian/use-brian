import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { buildCommands, linuxRuntimeFiles } from './build-native-computer.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const config = yaml.load(readFileSync(resolve(root, 'electron-builder.yml'), 'utf8'))
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
test('Windows helpers publish adjacent x64 apphosts matching packaged launch path', () => {
  const commands = buildCommands('win32')
  assert.equal(commands.length, 3)
  for (const [executable, args, cwd] of commands) {
    assert.equal(executable, 'dotnet')
    assert.equal(cwd, resolve(root, 'native/computer-control/windows'))
    if (args[0] === 'publish') {
      assert.equal(args[args.indexOf('-r') + 1], 'win-x64')
      assert.equal(args[args.indexOf('-o') + 1], 'out/win-x64')
      assert.ok(args.includes('-p:UseAppHost=true'))
    }
  }
  assert.equal(config.win.extraResources[0].from, 'native/computer-control/windows/out/win-x64')
  assert.equal(config.win.extraResources[0].to, 'native/computer-control/windows')
  assert.ok(config.win.signExts.includes('.dll'))
  assert.ok(pkg.scripts['package:win'].includes('build:native-computer:win'))
})
test('Linux ships every runtime module, not caches or tests, and checks syntax/boundaries', () => {
  const resources = config.linux.extraResources[0]
  assert.deepEqual([...resources.filter].sort(), [...linuxRuntimeFiles, 'dependencies.json'].sort())
  for (const file of resources.filter) assert.ok(existsSync(resolve(root, resources.from, file)))
  assert.deepEqual(buildCommands('linux')[0][1], ['-Es', '-m', 'py_compile', ...linuxRuntimeFiles])
  assert.ok(pkg.scripts['package:linux'].includes('build:native-computer:linux'))
})
test('macOS retains its signed-helper path and unsupported builds fail closed', () => {
  assert.deepEqual(buildCommands('darwin')[0].slice(0, 2), ['bash', ['build.sh']])
  const verifier = buildCommands('darwin')[1]
  assert.equal(verifier[0], 'xcrun')
  assert.ok(verifier[1].includes('BootstrapInventoryVerifier.c'))
  assert.ok(verifier[1].includes('build/brian-bootstrap-inventory-verifier'))
  assert.ok(!config.mac.extraResources.some(resource => JSON.stringify(resource).includes('inventory-verifier')))
  const driver = readFileSync(resolve(root, 'scripts/build-native-computer.mjs'), 'utf8')
  assert.ok(driver.includes("if (platform === 'darwin') delete env.CODESIGN_IDENTITY"))
  assert.ok(config.mac.binaries.includes('Contents/Resources/computer-control/brian-native-computer-helper'))
  assert.throws(() => buildCommands('freebsd'))
  assert.throws(() => buildCommands('--arbitrary-command'))
})

test('macOS fixture is adjacent, explicitly signed, and verified with the desktop team', () => {
  const base = 'Contents/Resources/computer-control/'
  const fixture = 'NativeComputerFixture.app'
  assert.equal(config.appId, 'ai.usebrian.desktop')
  assert.equal(pkg.productName, 'Use Brian')
  assert.ok(config.mac.binaries.includes(`${base}${fixture}/Contents/MacOS/NativeComputerFixture`))
  assert.ok(config.mac.extraResources.some(r => r.from === `native/computer-control/build/${fixture}` && r.to === `computer-control/${fixture}`))
  const signer = readFileSync(resolve(root, 'scripts/sign-siri-extension.mjs'), 'utf8')
  const verifier = readFileSync(resolve(root, 'scripts/verify-siri-extension.mjs'), 'utf8')
  for (const marker of ['NativeComputerFixture.app', 'fixtureArgs', '"--keychain", keychain', '"--verify", "--strict", fixturePath']) assert.ok(signer.includes(marker), marker)
  for (const marker of ['NativeComputerFixture.app', 'brian-native-computer-helper', 'ai.usebrian.desktop', 'com.usebrian.NativeComputerFixture', 'anchor apple generic', 'certificate leaf[subject.OU]', '"--all-architectures", "-R", requirement', 'if (!team) throw']) assert.ok(verifier.includes(marker), marker)
  const build = readFileSync(resolve(root, 'native/computer-control/build.sh'), 'utf8')
  for (const marker of ['xcrun clang', 'ProcessIdentity.c', '-import-objc-header ProcessIdentity.h', '-framework Security', '"$out/ProcessIdentity.o"']) assert.ok(build.includes(marker), marker)
})

test('macOS inspector source keeps failed privacy reads and changed window/modal scope closed', () => {
  const swift = readFileSync(resolve(root, 'native/computer-control/Helper.swift'), 'utf8')
  const privacy = swift.slice(swift.indexOf('func privacySubrole('), swift.indexOf('// Wire limits match'))
  assert.ok(privacy.includes('case .success: return value as? String'))
  assert.ok(privacy.includes('case .attributeUnsupported, .noValue: return ""'))
  assert.ok(privacy.includes('default: return nil'))
  const node = swift.slice(swift.indexOf('    func node('), swift.indexOf('    func supportedWindowScope('))
  assert.ok(node.includes('let subrole = privacySubrole(element)'))
  assert.ok(node.includes('let sensitive = !publicAXClassification(role, subrole)'))
  assert.ok(node.includes('publicAXRoles.contains(role) ? role : "AXUnknown"'))
  const live = swift.slice(swift.indexOf('    func liveWindow('), swift.indexOf('    // Foreground restoration'))
  for (const guard of ['currentWindows.count == window.applicationWindows.count',
    'currentWindows.filter({ CFEqual($0, expected) }).count == 1', 'supportedWindowScope(window.element)',
    'guard let focused = attr(window.application, kAXFocusedWindowAttribute)', 'supportedWindowScope(focused as! AXUIElement)']) assert.ok(live.includes(guard), guard)
  assert.ok(live.includes('defer { if !intact && grant != nil { _exit(71) } }'))
  for (const notification of ['kAXWindowCreatedNotification', 'kAXUIElementDestroyedNotification', 'kAXSheetCreatedNotification']) assert.ok(live.includes(notification))
  const callback = live.match(/let callback: AXObserverCallback = \{ _, _, _, _ in([\s\S]*?)\n        \}/)?.[1]
  assert.equal(callback?.replace(/\/\/[^\n]*/g, '').trim(), '_exit(71)')
  assert.ok(swift.includes('monitorScope(window), liveWindow(window.target) != nil'))
  const fromStart = swift.slice(swift.indexOf('    func start(_ payload: Object) -> Bool {'))
  const start = fromStart.slice(0, fromStart.indexOf('    func authorized('))
  assert.ok(start.includes('monitorScope(window)'))
  assert.ok(start.includes('if wireBool(candidate["allowControl"]) == true {\n            guard restoreApprovedWindow(window) else { return false }'))
  const observe = swift.slice(swift.indexOf('    func observe('), swift.indexOf('    func fresh('))
  assert.ok(observe.indexOf('liveWindow(window.target) != nil') < observe.indexOf('let read = node('))
  assert.ok(observe.lastIndexOf('liveWindow(window.target) != nil') > observe.indexOf('let read = node('))
  assert.ok(observe.lastIndexOf('liveWindow(window.target) != nil') < observe.indexOf('snapshots[observationId] ='))
  assert.ok(swift.includes('"axRead": ready, "semanticActions": ready, "windowCapture": ready && captureReady, "input": false'))
  assert.ok(swift.includes('inputTap.map { CGEvent.tapIsEnabled(tap: $0) }'))
})

test('macOS kernel identity source rejects root, cross-user, short reads and PID replacement', () => {
  const c = readFileSync(resolve(root, 'native/computer-control/ProcessIdentity.c'), 'utf8')
  for (const marker of ['user == 0', 'getuid() != user', 'geteuid() != user',
    'before.pbi_uid != user', 'before.pbi_ruid != user', 'before.pbi_svuid != user',
    'after.pbi_uid != user', 'after.pbi_ruid != user', 'after.pbi_svuid != user',
    '!= (int)sizeof(before)', '!= (int)sizeof(after)', 'proc_pidpath(pid, path, capacity) <= 0',
    'strcmp(path, confirmed_path) != 0', 'before.pbi_start_tvsec != after.pbi_start_tvsec', 'before.pbi_start_tvusec != after.pbi_start_tvusec',
    'S_ISFIFO(status.st_mode)', 'status.st_nlink == 0',
    'before.pbi_gid != before.pbi_rgid', 'before.pbi_gid != before.pbi_svgid',
    'after.pbi_gid != after.pbi_rgid', 'after.pbi_gid != after.pbi_svgid', 'private_endpoint(STDIN_FILENO) && private_endpoint(STDOUT_FILENO)',
    'type == SOCK_STREAM', 'local.sun_family == AF_UNIX && peer.sun_family == AF_UNIX',
    'local_size >= offsetof(struct sockaddr_un, sun_path) && local_size <= sizeof(local)',
    'peer_size >= offsetof(struct sockaddr_un, sun_path) && peer_size <= sizeof(peer)',
    'memcmp(local.sun_path, unnamed, sizeof(unnamed)) == 0', 'memcmp(peer.sun_path, unnamed, sizeof(unnamed)) == 0',
    'getpeereid(fd, &uid, &gid) == 0 && uid != 0 && uid == getuid()']) assert.ok(c.includes(marker), marker)
})

test('macOS authority source rejects metadata spoofing, unsigned/ad-hoc and wrong tree/team', () => {
  const swift = readFileSync(resolve(root, 'native/computer-control/Helper.swift'), 'utf8')
  const trust = swift.slice(swift.indexOf('struct ProcessIdentity'), swift.indexOf('let canvasTitle'))
  assert.ok(!swift.includes('app.bundleIdentifier'), 'Bundle metadata cannot choose a trusted cohort')
  assert.ok(!/ProcessInfo.processInfo.environment|getenv\(/.test(swift), 'No environment authority bypass')
  for (const marker of ['realpath(path, nil)', 'SecCodeCopyGuestWithAttributes(nil, attributes',
    'kSecGuestAttributePid', 'SecCodeCheckValidity(code', 'SecStaticCodeCheckValidity(disk',
    'kSecCodeInfoMainExecutable', 'canonicalPath(executable.path) == identity.executable',
    'ProcessIdentity.read(identity.pid) == identity', 'anchor apple generic', '^[A-Z0-9]{10}$',
    'getppid() == parent.pid', 'ProcessIdentity.read(parent.pid) == parent',
    'signedProcess(parent, teamRequirement("ai.usebrian.desktop"), bootstrap: true) == team',
    'parent.executable == contents.path + "/MacOS/Use Brian"',
    'helper.executable == contents.path + "/Resources/computer-control/brian-native-computer-helper"',
    'fixtureExecutable = contents.path + "/Resources/computer-control/NativeComputerFixture.app/Contents/MacOS/NativeComputerFixture"',
    'identity.executable == "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit"',
    'anchor apple and identifier', 'identity.executable == fixtureExecutable',
    'signedProcess(identity, teamRequirement(cohort)) == team']) assert.ok(trust.includes(marker), marker)
  assert.ok(!trust.includes('hasPrefix(contents.path)'), 'Sibling/prefix trees must not match')
  assert.ok(swift.includes('case "start": result = supportedGrant(payload)'))
  assert.ok(swift.includes('func semanticKind(_ kind: String) -> Bool { ["invoke", "setValue", "select", "scroll"].contains(kind) }'))
  assert.ok(swift.includes('guard supportedExecution(command) else { return result("denied") }'))
  const entry = swift.slice(swift.indexOf('guard let trust = ProcessTrust() else { _exit(77) }'))
  assert.ok(entry.includes('let sourceClock = SourceClock()'))
  assert.ok(entry.includes('let dispatcher = ObservationDispatcher { Broker(trust: trust) }'))
  assert.ok(entry.includes('dispatcher.response(request, clock: sourceClock)'))
  assert.ok(entry.indexOf('guard trust.parentValid()') < entry.indexOf('dispatcher.response('))
  assert.ok(!/broker\.|AXUIElement|NSWorkspace|CGEvent|SCScreenshotManager/.test(entry))
  assert.ok(swift.includes('guard trust.parentValid() else { _exit(77) }'))
  const broker = swift.slice(swift.indexOf('final class Broker: ObservationBackend'))
  const body = (name, next) => {
    const begin = broker.indexOf(`func ${name}(`), end = broker.indexOf(`func ${next}(`, begin)
    assert.ok(begin >= 0 && end > begin, `${name} -> ${next}`)
    return broker.slice(begin, end)
  }
  assert.ok(body('listTargets', 'liveWindow').includes('trust.target(app.processIdentifier)'))
  assert.ok(body('liveWindow', 'restoreApprovedWindow').includes('identity == window.identity'))
  assert.ok(body('liveWindow', 'restoreApprovedWindow').includes('trust.target(pid_t(pid))'))
  assert.ok(body('start', 'authorized').includes('targets.allSatisfy({ liveWindow($0) != nil })'))
  assert.ok(body('authorized', 'validCommand').includes('trust.parentValid()'))
  assert.ok(body('authorized', 'validCommand').includes('liveWindow(target) != nil'))
  for (const [name, next] of [['beginApproval', 'endApproval'], ['endApproval', 'execute']]) assert.ok(body(name, next).includes('let window = liveWindow(target)'))
  assert.ok(body('safeCanvas', 'visibleWindowID').includes('liveWindow(window.target) != nil'))
  const pixels = body('pixels', 'captureStillValid')
  assert.ok(pixels.indexOf('safeCanvas(window, snapshot)') < pixels.indexOf('SCShareableContent.getExcludingDesktopWindows'))
  assert.ok(pixels.indexOf('captureStillValid(command, action, window, snapshot)') < pixels.indexOf('SCScreenshotManager.captureImage'))
  assert.ok(pixels.lastIndexOf('captureStillValid(command, action, window, snapshot)') > pixels.indexOf('done.wait()'))
  assert.equal((pixels.match(/visibleWindowID\(window\) == number/g) ?? []).length, 2)
  assert.ok(body('captureStillValid', 'capture').includes('captureAuthority(grant) && authorized(command, lease)'))
  const dispatch = body('execute', 'rect')
  assert.ok(dispatch.lastIndexOf('authorized(command, payload["leaseId"] as? String ?? "")', dispatch.indexOf('switch kind')) > dispatch.indexOf('unchanged(snapshot, window)'))
})

test('mac private channel revocation is independent of AX and guards effects after lookups', () => {
  const swift = readFileSync(resolve(root, 'native/computer-control/Helper.swift'), 'utf8')
  const c = readFileSync(resolve(root, 'native/computer-control/ProcessIdentity.c'), 'utf8')
  const header = readFileSync(resolve(root, 'native/computer-control/ProcessIdentity.h'), 'utf8')
  assert.ok(c.includes('return brian_pipe_endpoints_alive(STDIN_FILENO, STDOUT_FILENO);'))
  assert.ok(header.includes('poll(ends, 2, 0)'))
  assert.ok(header.includes('POLLHUP | POLLERR | POLLNVAL'))
  assert.ok(swift.includes('if brian_private_channel_alive() != 1 { _exit(70) }\n                guardLock.lock()'))
  assert.ok(swift.includes('brian_private_channel_alive() == 1 && app.activate'))
  assert.ok(swift.includes('brian_private_channel_alive() == 1, AXUIElementPerformAction(window.element, kAXRaiseAction'))
  // Every semantic emitter must be preceded by a fresh nonblocking channel gate,
  // including selectionAttribute/actionNames which themselves call AX. Only the
  // no-wait source clock marker may sit between this gate and the native call.
  for (const line of swift.split('\n').filter(line => /error = AXUIElement(PerformAction|SetAttributeValue)/.test(line))) {
    const offset = swift.indexOf(line)
    assert.match(swift.slice(0, offset).trimEnd(), /guard brian_private_channel_alive\(\) == 1 else \{ _exit\(70\) \}\n\s*timing\?\.beginAPI\(\.api_(invoke|select|scroll|set_value)\)$/)
  }
})
