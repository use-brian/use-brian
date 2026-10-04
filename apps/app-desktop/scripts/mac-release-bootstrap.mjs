// R1 release-package composition. Runs inside the existing Mac signer, before
// electron-builder notarization. No credentials discovery, publication, runtime
// authority, or ad-hoc production fallback. The staging tree must be quiescent.
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import plist from 'plist';
import { captureReleaseLibraryInventoryData, requireVerifiedCapturedInventory,
  requireApprovedBootstrapInventory, extractVisualFixtureCodeData } from './mac-bootstrap-inventory.mjs';
import { stampNativeApprovalRecords, verifyBootstrapApprovalCoverage, validateUnstampedBootstrapAnchor,
  validateUnstampedVisualFixturePin, verifyVisualFixturePinCoverage, nativeApprovalArchitectures } from './mac-bootstrap-anchor.mjs';
import { extractPackagedParentLibraryConstraints } from './mac-library-constraints.mjs';
import { compareObservedLibraryConstraintPolicy } from './mac-library-constraint-policy.mjs';
import { nativeHelperRelativePath, nativeHelperEntitlements, verifyNativeHelperEntitlements,
  nativeFixtureRelativePath, verifyNativeFixtureEntitlements } from './mac-native-signing-policy.mjs';

const fail = () => { throw new Error('Packaged native bootstrap signing or verification refused'); };
const developerID = 'anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
function command(args) {
  return execFileSync('/usr/bin/codesign', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
}
function bytes(path, limit = 128 * 1024 * 1024) {
  if (fs.realpathSync(path) !== path) fail();
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 32 || before.size > limit) fail();
    const value = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (value.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail();
    return value;
  } finally { fs.closeSync(fd); }
}
function context(app, identity) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch) || fs.realpathSync(app) !== app || !app.endsWith('/Use Brian.app')) fail();
  // Builder supplies its resolved certificate SHA-1, not a candidate-provided
  // team. Bind the staged parent's signer to that exact selected certificate
  // before obtaining the team used by the independently verifying inventory.
  if (!/^[A-Fa-f0-9]{40}$/.test(identity ?? '')) fail();
  command(['--verify', '--strict', '--all-architectures', '-R', `=${developerID} and certificate leaf = H"${identity}" and identifier "ai.usebrian.desktop"`, app]);
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', app], { encoding: 'utf8', timeout: 120000, maxBuffer: 65536 });
  if (result.status !== 0) fail();
  const team = `${result.stdout}\n${result.stderr}`.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
  if (!team) fail();
  return { team, architectures: [process.arch === 'arm64' ? 'arm64' : 'x86_64'] };
}

function verifiedFixture(app, architectures, signerRequirement) {
  const bundle = join(app, nativeFixtureRelativePath);
  if (fs.realpathSync(bundle) !== bundle) fail();
  const executable = join(bundle, 'Contents/MacOS/NativeComputerFixture');
  const infoPath = join(bundle, 'Contents/Info.plist'), resourcesPath = join(bundle, 'Contents/_CodeSignature/CodeResources');
  const before = [bytes(executable), bytes(infoPath), bytes(resourcesPath)];
  const info = plist.parse(before[1].toString('utf8'));
  if (info.CFBundleIdentifier !== 'com.usebrian.NativeComputerFixture' || info.CFBundleExecutable !== 'NativeComputerFixture') fail();
  command(['--verify', '--strict', '--all-architectures', '-R',
    `=${developerID} and ${signerRequirement} and identifier "com.usebrian.NativeComputerFixture"`, bundle]);
  // Check both signing targets before accepting pins, and again after outer sealing.
  verifyNativeFixtureEntitlements(bundle);
  const records = extractVisualFixtureCodeData(before[0], architectures, before[1], before[2]);
  if (![executable, infoPath, resourcesPath].every((path, i) => bytes(path).equals(before[i]))) fail();
  if (records.some(r => typeof r.cdHash !== 'string' || !/^[a-f0-9]{40}$/.test(r.cdHash) || /^0{40}$/.test(r.cdHash))) fail();
  const hashes = records.map(r => Buffer.from(r.cdHash, 'hex')).sort(Buffer.compare);
  if (hashes.length < 1 || hashes.length > 2 || hashes.some((h, i) => i && h.equals(hashes[i - 1]))) fail();
  return { records, hashes };
}

async function approval(app, team, architectures) {
  const capture = captureReleaseLibraryInventoryData(app, { architectures });
  const verified = await requireVerifiedCapturedInventory(capture, { teamIdentifier: team });
  return requireApprovedBootstrapInventory(verified);
}
function verifyBindings(app, expected, team, fixtureHashes) {
  const helper = join(app, nativeHelperRelativePath);
  command(['--verify', '--strict', '--all-architectures', '-R', `=${developerID} and certificate leaf[subject.OU] = "${team}"`, helper]);
  verifyNativeHelperEntitlements(helper);
  verifyBootstrapApprovalCoverage(bytes(helper), expected);
  verifyVisualFixturePinCoverage(bytes(helper), fixtureHashes);
  const parent = bytes(join(app, 'Contents/MacOS/Use Brian'));
  for (const slice of extractPackagedParentLibraryConstraints(parent)) {
    compareObservedLibraryConstraintPolicy(slice.rawBlob, { teamIdentifier: team, cdHashes: expected.libraryCDHashes });
  }
}

// Capture the original empty/linker-only helper BEFORE the ordinary signer.
// stampBootstrapApproval later refuses a pre-signed or already-populated anchor.
export function captureUnstampedHelper(app) {
  const original = bytes(join(app, nativeHelperRelativePath));
  validateUnstampedBootstrapAnchor(original);
  validateUnstampedVisualFixturePin(original);
  return original;
}

export async function verifyPackagedNativeBootstrap(app, team) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch) || !/^[A-Z0-9]{10}$/.test(team ?? '')) fail();
  command(['--verify', '--strict', '--all-architectures', '-R', `=${developerID} and certificate leaf[subject.OU] = "${team}" and identifier "ai.usebrian.desktop"`, app]);
  const expected = await approval(app, team, [process.arch === 'arm64' ? 'arm64' : 'x86_64']);
  const fixture = verifiedFixture(app, nativeApprovalArchitectures(bytes(join(app, nativeHelperRelativePath))), `certificate leaf[subject.OU] = "${team}"`);
  verifyBindings(app, expected, team, fixture.hashes);
}

export async function sealNativeBootstrap(options, unstampedHelper) {
  const { app, identity, keychain } = options;
  const { team, architectures } = context(app, identity);
  const expected = await approval(app, team, architectures);
  const helper = join(app, nativeHelperRelativePath);
  const fixtureArchitectures = nativeApprovalArchitectures(unstampedHelper);
  const fixtureRequirement = `certificate leaf = H"${identity}"`;
  const fixture = verifiedFixture(app, fixtureArchitectures, fixtureRequirement);
  const stamped = stampNativeApprovalRecords(unstampedHelper, expected, fixture.hashes);
  // The first signing pass finalized nested libraries; only the excluded helper
  // and root signatures change now. No nested-library re-signing after approval.
  const fd = fs.openSync(helper, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) fail();
    fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, stamped);
  } finally { fs.closeSync(fd); }
  const base = ['--force', '--sign', identity, '--timestamp', '--options', 'runtime'];
  if (keychain) base.push('--keychain', keychain);
  command([...base, '--entitlements', nativeHelperEntitlements, helper]);
  const rootOptions = options.optionsForFile?.(app);
  if (!rootOptions || typeof rootOptions.entitlements !== 'string' || rootOptions.hardenedRuntime !== true ||
      rootOptions.additionalArguments?.length || rootOptions.signatureFlags?.length) fail();
  const temp = fs.mkdtempSync(join(tmpdir(), 'brian-bootstrap-sign-'));
  fs.chmodSync(temp, 0o700);
  try {
    const constraint = join(temp, 'libraries.plist');
    fs.writeFileSync(constraint, plist.build({ 'validation-category': 6, 'team-identifier': team,
      cdhash: { '$in': expected.libraryCDHashes } }), { mode: 0o600, flag: 'wx' });
    const args = [...base, '--entitlements', rootOptions.entitlements];
    if (rootOptions.requirements) args.push('--requirements', rootOptions.requirements);
    if (rootOptions.timestamp) args.push(`--timestamp=${rootOptions.timestamp}`);
    command([...args, '--enforce-constraint-validity', '--library-constraint', constraint, app]);
    command(['--verify', '--deep', '--strict', '--all-architectures', app]);
    context(app, identity);
    verifyBindings(app, expected, team, fixture.hashes);
    const finalFixture = verifiedFixture(app, fixtureArchitectures, fixtureRequirement);
    if (JSON.stringify(finalFixture.records) !== JSON.stringify(fixture.records)) fail();
    // Rebuild a fresh CMS/ASAR-checked inventory after signing. Excluded helper
    // and main hashes intentionally differ; the library pins and ASAR may not.
    const final = await approval(app, team, architectures);
    if (final.electronVersion !== expected.electronVersion || !final.asarDigest.equals(expected.asarDigest) ||
        final.libraryCDHashes.length !== expected.libraryCDHashes.length ||
        final.libraryCDHashes.some((hash, i) => !hash.equals(expected.libraryCDHashes[i]))) fail();
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  return expected;
}
