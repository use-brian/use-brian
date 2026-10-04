import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import plist from 'plist';
import { verifyNativeFixtureEntitlements, verifyNativeHelperEntitlements } from './mac-native-signing-policy.mjs';

const bundle = '/package/Use Brian.app/Contents/Resources/computer-control/NativeComputerFixture.app';
const executable = `${bundle}/Contents/MacOS/NativeComputerFixture`;
const empty = { status: 0, stdout: plist.build({}) };
function codesign(t, implementation) {
  t.mock.method(childProcess, 'spawnSync', implementation);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
test('signed empty native profiles require successful codesign output on both fixture targets', t => {
  const calls = [];
  codesign(t, (command, args, options) => {
    assert.equal(command, '/usr/bin/codesign');
    assert.deepEqual(args.slice(0, 3), ['--display', '--entitlements', ':-']);
    assert.equal(options.encoding, 'utf8');
    calls.push(args[3]); return empty;
  });
  verifyNativeFixtureEntitlements(bundle);
  assert.deepEqual(calls, [bundle, executable]);
  verifyNativeHelperEntitlements('/helper');
  assert.equal(calls.at(-1), '/helper');
});
for (const target of [bundle, executable]) test(`reject missing, malformed or nonempty signed fixture entitlements: ${target}`, t => {
  let response;
  codesign(t, (_command, args) => args[3] === target ? response : empty);
  for (response of [
    { status: 1, stdout: empty.stdout }, { status: null, stdout: empty.stdout },
    { status: 0 }, { status: 0, stdout: '' }, { status: 0, stdout: '  ' },
    { status: 0, stdout: 'not a plist' }, { status: 0, stdout: '<plist><dict>' },
    { status: 0, stdout: plist.build([]) }, { status: 0, stdout: plist.build('') },
    { status: 0, stdout: plist.build({ 'com.apple.security.cs.allow-jit': true }) },
    { status: 0, stdout: plist.build({ 'com.apple.security.cs.disable-library-validation': false }) },
  ]) assert.throws(() => verifyNativeFixtureEntitlements(bundle), /entitlements|empty entitlement profile/);
});
test('release verifies fixture profiles before extracting pins and at both final verification sites', () => {
  const source = readFileSync(new URL('./mac-release-bootstrap.mjs', import.meta.url), 'utf8');
  const verifier = source.slice(source.indexOf('function verifiedFixture('), source.indexOf('async function approval('));
  assert.ok(verifier.indexOf('verifyNativeFixtureEntitlements(bundle)') > 0);
  assert.ok(verifier.indexOf('verifyNativeFixtureEntitlements(bundle)') < verifier.indexOf('extractVisualFixtureCodeData('));
  const final = source.slice(source.indexOf('export async function verifyPackagedNativeBootstrap'), source.indexOf('export async function sealNativeBootstrap'));
  assert.match(final, /const fixture = verifiedFixture\(/);
  const seal = source.slice(source.indexOf('export async function sealNativeBootstrap'));
  assert.ok(seal.indexOf('const fixture = verifiedFixture(') < seal.indexOf('stampNativeApprovalRecords('));
  assert.ok(seal.indexOf("'--library-constraint', constraint, app") < seal.indexOf('const finalFixture = verifiedFixture('));
});
