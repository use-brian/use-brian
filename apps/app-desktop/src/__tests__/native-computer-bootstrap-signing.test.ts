import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const plist = createRequire(import.meta.url)('plist') as { parse(xml: string): unknown };

// Composition tests only: signing, CMS verification and artifact parsing are
// mocked. The real parsers have their existing byte-level suites. No Mac or
// certificate acceptance is implied by these tests.
describe('R1 release bootstrap signing composition', () => {
  let root: string, app: string, helper: string, fixture: string;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  const identity = 'A'.repeat(40);
  const team = 'ABCDE12345';
  const expected = { electronVersion: '43.2.0', asarDigest: Buffer.alloc(32, 1),
    libraryCDHashes: [Buffer.alloc(20, 2), Buffer.alloc(20, 3)] };
  let signCalls: string[][], constraintPath: string | undefined;
  const execFileSync = vi.fn();
  const spawnSync = vi.fn();
  const captureReleaseLibraryInventoryData = vi.fn();
  const requireVerifiedCapturedInventory = vi.fn();
  const requireApprovedBootstrapInventory = vi.fn();
  const stampNativeApprovalRecords = vi.fn();
  const validateUnstampedBootstrapAnchor = vi.fn();
  const verifyBootstrapApprovalCoverage = vi.fn();
  const validateUnstampedVisualFixturePin = vi.fn();
  const nativeApprovalArchitectures = vi.fn();
  const verifyVisualFixturePinCoverage = vi.fn();
  const extractVisualFixtureCodeData = vi.fn();
  const fixtureRecords = [{ architecture: 'arm64', cdHash: '05'.repeat(20) },
    { architecture: 'x86_64', cdHash: '04'.repeat(20) }];
  const fixtureHashes = [Buffer.alloc(20, 4), Buffer.alloc(20, 5)];
  const extractPackagedParentLibraryConstraints = vi.fn();
  const compareObservedLibraryConstraintPolicy = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks(); vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    root = realpathSync(mkdtempSync(join(tmpdir(), 'bootstrap-signing-')));
    app = join(root, 'Use Brian.app');
    helper = join(app, 'Contents/Resources/computer-control/brian-native-computer-helper');
    for (const file of [helper, join(app, 'Contents/MacOS/Use Brian')]) {
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.alloc(64, 7));
    }
    fixture = join(app, 'Contents/Resources/computer-control/NativeComputerFixture.app');
    for (const [relative, data] of [
      ['Contents/MacOS/NativeComputerFixture', Buffer.alloc(64, 8)],
      ['Contents/Info.plist', '<plist><dict><key>CFBundleIdentifier</key><string>com.usebrian.NativeComputerFixture</string><key>CFBundleExecutable</key><string>NativeComputerFixture</string></dict></plist>'],
      ['Contents/_CodeSignature/CodeResources', Buffer.alloc(64, 6)],
    ] as const) {
      const path = join(fixture, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data);
    }
    nativeApprovalArchitectures.mockReturnValue(['arm64', 'x86_64']);
    extractVisualFixtureCodeData.mockReturnValue(fixtureRecords);
    signCalls = []; constraintPath = undefined;
    execFileSync.mockImplementation((tool, args) => {
      expect(tool).toBe('/usr/bin/codesign'); signCalls.push(args);
      // Model codesign's CLI boundary, not just fragments of policy text:
      // without '=', -R loads a file rather than compiling an expression.
      if (args.includes('-R')) expect(args[args.indexOf('-R') + 1]).toMatch(/^=anchor apple generic and /);
      if (args.includes('--library-constraint')) {
        constraintPath = args[args.indexOf('--library-constraint') + 1];
        const value = plist.parse(readFileSync(constraintPath!, 'utf8')) as any;
        expect(value['validation-category']).toBe(6);
        expect(value['team-identifier']).toBe(team);
        expect(value.cdhash.$in).toEqual(expected.libraryCDHashes);
      }
      return '';
    });
    spawnSync.mockImplementation((_tool, args) => ({ status: 0,
      stdout: args.includes('--entitlements') ? '<plist><dict/></plist>' : '', stderr: `TeamIdentifier=${team}` }));
    captureReleaseLibraryInventoryData.mockReturnValue({ captured: true });
    requireVerifiedCapturedInventory.mockResolvedValue({ privateReceipt: true });
    requireApprovedBootstrapInventory.mockResolvedValue(expected);
    stampNativeApprovalRecords.mockReturnValue(Buffer.alloc(64, 9));
    extractPackagedParentLibraryConstraints.mockReturnValue([{ rawBlob: Buffer.from('constraint') }]);
    vi.doMock('node:child_process', () => ({ execFileSync, spawnSync }));
    vi.doMock('../../scripts/mac-bootstrap-inventory.mjs', () => ({ captureReleaseLibraryInventoryData,
      requireVerifiedCapturedInventory, requireApprovedBootstrapInventory, extractVisualFixtureCodeData }));
    vi.doMock('../../scripts/mac-bootstrap-anchor.mjs', () => ({ stampNativeApprovalRecords, verifyBootstrapApprovalCoverage, validateUnstampedBootstrapAnchor,
      validateUnstampedVisualFixturePin, nativeApprovalArchitectures, verifyVisualFixturePinCoverage }));
    vi.doMock('../../scripts/mac-library-constraints.mjs', () => ({ extractPackagedParentLibraryConstraints }));
    vi.doMock('../../scripts/mac-library-constraint-policy.mjs', () => ({ compareObservedLibraryConstraintPolicy }));
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch);
    for (const module of ['node:child_process', '../../scripts/mac-bootstrap-inventory.mjs',
      '../../scripts/mac-bootstrap-anchor.mjs', '../../scripts/mac-library-constraints.mjs',
      '../../scripts/mac-library-constraint-policy.mjs']) vi.doUnmock(module);
    vi.resetModules(); rmSync(root, { recursive: true, force: true });
  });
  const load = () => import(new URL('../../scripts/mac-release-bootstrap.mjs', import.meta.url).href);
  const options = () => ({ app, identity, keychain: '/private/builder.keychain', optionsForFile: () => ({
    entitlements: '/reviewed/parent.plist', hardenedRuntime: true, additionalArguments: [],
  }) });

  it('refuses invalid compiler output before signing or inventory and leaves the helper untouched', async () => {
    const api = await load();
    validateUnstampedBootstrapAnchor.mockImplementation(() => { throw new Error('invalid empty anchor'); });
    expect(() => api.captureUnstampedHelper(app)).toThrow('invalid empty anchor');
    expect(validateUnstampedBootstrapAnchor).toHaveBeenCalledWith(Buffer.alloc(64, 7));
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(captureReleaseLibraryInventoryData).not.toHaveBeenCalled();
    expect(stampNativeApprovalRecords).not.toHaveBeenCalled();
    expect(readFileSync(helper)).toEqual(Buffer.alloc(64, 7));
  });

  it('stamps approved final library pins, signs helper then constrained parent, and verifies without publication', async () => {
    const api = await load();
    const original = api.captureUnstampedHelper(app);
    await api.sealNativeBootstrap(options(), original);
    expect(original).toEqual(Buffer.alloc(64, 7));
    expect(validateUnstampedBootstrapAnchor).toHaveBeenCalledWith(original);
    expect(stampNativeApprovalRecords).toHaveBeenCalledWith(original, expected, fixtureHashes);
    expect(validateUnstampedVisualFixturePin).toHaveBeenCalledWith(original);
    expect(nativeApprovalArchitectures).toHaveBeenCalledWith(original);
    expect(requireVerifiedCapturedInventory).toHaveBeenCalledWith({ captured: true }, { teamIdentifier: team });
    expect(captureReleaseLibraryInventoryData).toHaveBeenCalledWith(app, { architectures: ['arm64'] });
    const signs = signCalls.filter(args => args.includes('--sign'));
    expect(signs).toHaveLength(2);
    expect(signs[0].at(-1)).toBe(helper); expect(signs[1].at(-1)).toBe(app);
    for (const args of signs) {
      expect(args[args.indexOf('--sign') + 1]).toBe(identity);
      expect(args[args.indexOf('--keychain') + 1]).toBe('/private/builder.keychain');
      expect(args).not.toContain('--deep');
    }
    const fixtureChecks = signCalls.filter(args => args.at(-1) === fixture);
    expect(fixtureChecks).toHaveLength(2);
    for (const args of fixtureChecks) {
      expect(args).toEqual(['--verify', '--strict', '--all-architectures', '-R',
        expect.stringContaining(`certificate leaf = H"${identity}" and identifier "com.usebrian.NativeComputerFixture"`), fixture]);
    }
    expect(signCalls.indexOf(fixtureChecks[0])).toBeLessThan(signCalls.indexOf(signs[0]));
    expect(signCalls.indexOf(signs[1])).toBeLessThan(signCalls.indexOf(fixtureChecks[1]));
    expect(extractVisualFixtureCodeData).toHaveBeenCalledTimes(2);
    expect(extractVisualFixtureCodeData).toHaveBeenCalledWith(Buffer.alloc(64, 8), ['arm64', 'x86_64'],
      readFileSync(join(fixture, 'Contents/Info.plist')), Buffer.alloc(64, 6));
    expect(extractVisualFixtureCodeData.mock.invocationCallOrder[0]).toBeLessThan(stampNativeApprovalRecords.mock.invocationCallOrder[0]);
    expect(stampNativeApprovalRecords.mock.invocationCallOrder[0]).toBeLessThan(
      execFileSync.mock.invocationCallOrder[signCalls.indexOf(signs[0])]);
    expect(verifyVisualFixturePinCoverage).toHaveBeenCalledWith(Buffer.alloc(64, 9), fixtureHashes);
    expect(signs[1]).toContain('--enforce-constraint-validity');
    expect(signCalls[0].join(' ')).toContain(`certificate leaf = H"${identity}"`);
    expect(requireApprovedBootstrapInventory).toHaveBeenCalledTimes(2);
    expect(verifyBootstrapApprovalCoverage).toHaveBeenCalledWith(Buffer.alloc(64, 9), expected);
    expect(compareObservedLibraryConstraintPolicy).toHaveBeenCalledWith(Buffer.from('constraint'), {
      teamIdentifier: team, cdHashes: expected.libraryCDHashes,
    });
    expect(existsSync(constraintPath!)).toBe(false);
  });

  it('rejects a broadened signed helper profile before returning to builder notarization', async () => {
    const api = await load();
    spawnSync.mockImplementation((_tool, args) => ({ status: 0,
      stdout: args.includes('--entitlements') ? '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>' : '',
      stderr: `TeamIdentifier=${team}` }));
    await expect(api.sealNativeBootstrap(options(), api.captureUnstampedHelper(app))).rejects.toThrow('empty entitlement profile');
    expect(existsSync(constraintPath!)).toBe(false);
  });

  it('does not mutate/sign when independent inventory approval fails', async () => {
    const api = await load(); requireApprovedBootstrapInventory.mockRejectedValue(new Error('unapproved library'));
    await expect(api.sealNativeBootstrap(options(), api.captureUnstampedHelper(app))).rejects.toThrow('unapproved library');
    expect(stampNativeApprovalRecords).not.toHaveBeenCalled();
    expect(signCalls.some(args => args.includes('--sign'))).toBe(false);
    expect(readFileSync(helper)).toEqual(Buffer.alloc(64, 7));
    expect(extractVisualFixtureCodeData).not.toHaveBeenCalled();
  });

  it('rejects changed final pins and cleans the constraint file after errors', async () => {
    const api = await load();
    requireApprovedBootstrapInventory.mockResolvedValueOnce(expected).mockResolvedValueOnce({ ...expected, asarDigest: Buffer.alloc(32, 4) });
    await expect(api.sealNativeBootstrap(options(), api.captureUnstampedHelper(app))).rejects.toThrow('refused');
    expect(existsSync(constraintPath!)).toBe(false);
  });

  it.each([{ records: [] }, { records: [fixtureRecords[0], fixtureRecords[0]] }])('rejects empty or duplicate fixture pins %# before signing', async ({ records }) => {
    const api = await load(); extractVisualFixtureCodeData.mockReturnValue(records);
    await expect(api.sealNativeBootstrap(options(), api.captureUnstampedHelper(app))).rejects.toThrow('refused');
    expect(stampNativeApprovalRecords).not.toHaveBeenCalled();
    expect(signCalls.some(args => args.includes('--sign'))).toBe(false);
    expect(readFileSync(helper)).toEqual(Buffer.alloc(64, 7));
  });

  it('refuses an invalid empty visual pin before the ordinary signing pass', async () => {
    const api = await load();
    validateUnstampedVisualFixturePin.mockImplementation(() => { throw new Error('invalid empty visual pin'); });
    expect(() => api.captureUnstampedHelper(app)).toThrow('invalid empty visual pin');
    expect(execFileSync).not.toHaveBeenCalled();
    expect(readFileSync(helper)).toEqual(Buffer.alloc(64, 7));
  });

  it('rejects a changed final fixture identity and cleans temporary constraints', async () => {
    const api = await load();
    extractVisualFixtureCodeData.mockReturnValueOnce(fixtureRecords).mockReturnValueOnce([
      { ...fixtureRecords[0], cdHash: '06'.repeat(20) }, fixtureRecords[1],
    ]);
    await expect(api.sealNativeBootstrap(options(), api.captureUnstampedHelper(app))).rejects.toThrow('refused');
    expect(verifyVisualFixturePinCoverage).toHaveBeenCalledWith(Buffer.alloc(64, 9), fixtureHashes);
    expect(requireApprovedBootstrapInventory).toHaveBeenCalledTimes(1);
    expect(existsSync(constraintPath!)).toBe(false);
  });

  it.each(['', 'zz'.repeat(20), '01'.repeat(19), '00'.repeat(20), '01'.repeat(20) + 'zz'])(
    'rejects invalid fixture CDHash %s before mutation/signing', async cdHash => {
      const api = await load(); extractVisualFixtureCodeData.mockReturnValue([{ architecture: 'arm64', cdHash }]);
      await expect(api.sealNativeBootstrap(options(), api.captureUnstampedHelper(app))).rejects.toThrow('refused');
      expect(stampNativeApprovalRecords).not.toHaveBeenCalled();
      expect(signCalls.some(args => args.includes('--sign'))).toBe(false);
      expect(readFileSync(helper)).toEqual(Buffer.alloc(64, 7));
    });

  it('after-sign verification is read-only and refuses malformed parent constraints', async () => {
    const api = await load();
    await api.verifyPackagedNativeBootstrap(app, team);
    expect(signCalls.some(args => args.includes('--sign'))).toBe(false);
    expect(stampNativeApprovalRecords).not.toHaveBeenCalled();
    expect(verifyVisualFixturePinCoverage).toHaveBeenCalledWith(Buffer.alloc(64, 7), fixtureHashes);
    compareObservedLibraryConstraintPolicy.mockImplementation(() => { throw new Error('wrong constraint'); });
    await expect(api.verifyPackagedNativeBootstrap(app, team)).rejects.toThrow('wrong constraint');
  });

  it('rejects ad-hoc identities and a missing signing team before inventory work', async () => {
    const api = await load();
    await expect(api.sealNativeBootstrap({ ...options(), identity: '-' }, api.captureUnstampedHelper(app))).rejects.toThrow('refused');
    spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: 'TeamIdentifier=not set' });
    await expect(api.sealNativeBootstrap(options(), api.captureUnstampedHelper(app))).rejects.toThrow('refused');
    expect(captureReleaseLibraryInventoryData).not.toHaveBeenCalled();
  });
});
