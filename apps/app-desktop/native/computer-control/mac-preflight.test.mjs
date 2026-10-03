import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./mac-preflight.sh', import.meta.url))
const source = readFileSync(script, 'utf8')

test('shell syntax is valid without executing the preflight', () => {
  const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('first handoff source guards: independent typecheck, unsigned build, no launch/authority flags', () => {
  assert.match(source, /umask 077/)
  assert.match(source, /mktemp -d/)
  assert.match(source, /chmod 700 "\$WORK"/)
  assert.match(source, /xcode-select -p/)
  assert.match(source, /xcrun --sdk macosx swiftc -swift-version 5 -sdk "\$SDK"/)
  assert(source.indexOf('-typecheck Fixture.swift') < source.indexOf('/bin/bash ./build.sh'))
  assert.match(source, /env -u CODESIGN_IDENTITY SDKROOT="\$SDK" \/bin\/bash \.\/build.sh "\$WORK\/build"/)
  assert.match(source, /node \.\/smoke.mjs --portable/)
  assert.match(source, /node \.\/bootstrap-negative.mjs "\$WORK\/build\/brian-native-computer-helper"/)
  assert.match(source, /clang -std=c11 -D_DARWIN_C_SOURCE -Wall -Wextra -Werror/)
  assert.match(source, /KernelSigningProbe\.c "\$WORK\/build\/ProcessIdentity\.o"/)
  assert.match(source, /"\$WORK\/build\/kernel-signing-probe" > "\$WORK\/logs\/kernel-signing\.json"/)
  assert(source.indexOf('node ./bootstrap-negative.mjs') < source.indexOf('KernelSigningProbe.c'))
  assert(source.indexOf('KernelSigningProbe.c') < source.indexOf('"$WORK/build/kernel-signing-probe" >'))
  assert(!/NATIVE_COMPUTER_.*(?:ENABLED|ACCEPTED)|--probe-only|\b(?:npm|pnpm|curl|wget|codesign|notarytool|osascript)\s/.test(source))
  assert(!/\bopen\s|NativeComputerFixture\.app/.test(source))
})

test('Mac compiler regression guards retain explicit trust and public AX sheet traversal', () => {
  // Source regressions only: the user-run preflight remains the SDK compiler.
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8')
  const broker = helper.slice(helper.indexOf('final class Broker: ObservationBackend {'), helper.indexOf('guard let trust = ProcessTrust()'))
  assert.match(broker, /private let trust: ProcessTrust/)
  assert.match(broker, /init\(trust: ProcessTrust\) \{\s*self\.trust = trust/)
  assert(!helper.includes('kAXSheetsAttribute'))
  assert(!helper.includes('activateIgnoringOtherApps'))
  assert.match(broker, /app\.activate\(options: \[\]\)/)
  const sheets = broker.slice(broker.indexOf('    func hasNoSheetChildren('), broker.indexOf('    func scopedChildren('))
  assert.match(sheets, /attr\(element, kAXChildrenAttribute\) as\? \[AXUIElement\]/)
  assert.match(sheets, /children\.count <= 500 else \{ return false \}/)
  assert.match(sheets, /attr\(child, kAXRoleAttribute\) as\? String, !role\.isEmpty else \{ return false \}/)
  assert.match(sheets, /return role != kAXSheetRole/)
  assert.equal((broker.match(/hasNoSheetChildren\(/g) ?? []).length, 4)
  assert(broker.includes('completeSnapshot.refs.values.contains(where: { $0.node["role"] as? String == kAXSheetRole })'))
  assert(broker.includes('$0.node["role"] as? String != kAXSheetRole'))
  assert(helper.includes('let dispatcher = ObservationDispatcher { Broker(trust: trust) }'), 'Only explicit discovery initializes the backend')
})

test('non-Mac preflight refuses before invoking tools/build', { skip: process.platform === 'darwin' }, () => {
  const result = spawnSync('bash', [script], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /macOS 14\+ required; no native checks ran/)
  assert.equal(result.stdout, '')
})

test('smoke negative CLI preserves platform gate', { skip: process.platform === 'darwin' }, () => {
  for (const flag of ['--parent-negative', '--bootstrap-negative']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./smoke.mjs', import.meta.url)), flag, '/never-executed'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /macOS real desktop required/)
  }
})
