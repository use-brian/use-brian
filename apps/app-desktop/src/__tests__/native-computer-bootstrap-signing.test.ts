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
  let root: string, app: string, helper: string;
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
  const stampBootstrapApproval = vi.fn();
  const verifyBootstrapApprovalCoverage = vi.fn();
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
    stampBootstrapApproval.mockReturnValue(Buffer.alloc(64, 9));
    extractPackagedParentLibraryConstraints.mockReturnValue([{ rawBlob: Buffer.from('constraint') }]);
    vi.doMock('node:child_process', () => ({ execFileSync, spawnSync }));
    vi.doMock('../../scripts/mac-bootstrap-inventory.mjs', () => ({ captureReleaseLibraryInventoryData,
      requireVerifiedCapturedInventory, requireApprovedBootstrapInventory }));
    vi.doMock('../../scripts/mac-bootstrap-anchor.mjs', () => ({ stampBootstrapApproval, verifyBootstrapApprovalCoverage }));
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

  it('stamps approved final library pins, signs helper then constrained parent, and verifies without publication', async () => {
    const api = await load();
    const original = api.captureUnstampedHelper(app);
    await api.sealNativeBootstrap(options(), original);
    expect(original).toEqual(Buffer.alloc(64, 7));
    expect(stampBootstrapApproval).toHaveBeenCalledWith(original, expected);
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
    expect(stampBootstrapApproval).not.toHaveBeenCalled();
    expect(signCalls.some(args => args.includes('--sign'))).toBe(false);
    expect(readFileSync(helper)).toEqual(Buffer.alloc(64, 7));
  });

  it('rejects changed final pins and cleans the constraint file after errors', async () => {
    const api = await load();
    requireApprovedBootstrapInventory.mockResolvedValueOnce(expected).mockResolvedValueOnce({ ...expected, asarDigest: Buffer.alloc(32, 4) });
    await expect(api.sealNativeBootstrap(options(), api.captureUnstampedHelper(app))).rejects.toThrow('refused');
    expect(existsSync(constraintPath!)).toBe(false);
  });

  it('after-sign verification is read-only and refuses malformed parent constraints', async () => {
    const api = await load();
    await api.verifyPackagedNativeBootstrap(app, team);
    expect(signCalls.some(args => args.includes('--sign'))).toBe(false);
    expect(stampBootstrapApproval).not.toHaveBeenCalled();
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
