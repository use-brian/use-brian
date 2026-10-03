import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Tool calls are mocked. These checks establish hook composition, not Mac signing.
describe('native helper signing in the existing Mac release hook', () => {
  it('reuses builder identity/keychain and traversal with a closed helper profile', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-signing-')));
    const app = join(root, 'Use Brian.app');
    const helper = join(app, 'Contents/Resources/computer-control/brian-native-computer-helper');
    mkdirSync(join(helper, '..'), { recursive: true });
    writeFileSync(helper, 'fixture, not executable');
    const inherited = { entitlements: 'build/entitlements.mac.plist', hardenedRuntime: true,
      additionalArguments: ['--options', 'runtime,library'], timestamp: 'https://timestamp.apple.com/ts01' };
    const signAsync = vi.fn(async (options) => {
      expect(options.identity).toBe('BUILDER-SELECTED-IDENTITY');
      expect(options.keychain).toBe('/private/builder.keychain');
      expect(options.binaries).toEqual([helper]);
      expect(options.optionsForFile(app)).toBe(inherited);
      const policy = options.optionsForFile(helper);
      expect(policy.hardenedRuntime).toBe(true);
      expect(policy.additionalArguments).toEqual([]);
      expect(policy.signatureFlags).toEqual([]);
      expect(policy.timestamp).toBe(inherited.timestamp);
      expect(readFileSync(policy.entitlements, 'utf8')).toContain('<dict/>');
    });
    const originalHelper = Buffer.alloc(64);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const approval = { fixtureApproval: true };
    const sealNativeBootstrap = vi.fn(async () => approval);
    const checkPackagedAdmission = vi.fn(async () => ({ passed: true }));
    vi.doMock('../../scripts/mac-packaged-admission-check.mjs', () => ({ checkPackagedAdmission }));
    const captureUnstampedHelper = vi.fn(() => originalHelper);
    vi.doMock('../../scripts/mac-release-bootstrap.mjs', () => ({ sealNativeBootstrap, captureUnstampedHelper }));
    vi.doMock('@electron/osx-sign', () => ({ signAsync }));
    try {
      const { default: sign } = await import(new URL('../../scripts/sign-mac-app.mjs', import.meta.url).href);
      const options = { app, platform: 'darwin', identity: 'BUILDER-SELECTED-IDENTITY',
        keychain: '/private/builder.keychain', binaries: [helper], optionsForFile: () => inherited };
      await sign(options);
      expect(signAsync).toHaveBeenCalledOnce();
      expect(captureUnstampedHelper).toHaveBeenCalledWith(app);
      expect(sealNativeBootstrap).toHaveBeenCalledWith(expect.objectContaining({ identity: options.identity }), originalHelper);
      expect(captureUnstampedHelper.mock.invocationCallOrder[0]).toBeLessThan(signAsync.mock.invocationCallOrder[0]);
      expect(signAsync.mock.invocationCallOrder[0]).toBeLessThan(sealNativeBootstrap.mock.invocationCallOrder[0]);
      expect(checkPackagedAdmission).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      vi.stubEnv('BRIAN_NATIVE_PACKAGE_CHECK', '1');
      await sign(options);
      expect(checkPackagedAdmission).toHaveBeenCalledWith(expect.objectContaining({ identity: options.identity }), approval);
      expect(sealNativeBootstrap.mock.invocationCallOrder.at(-1)).toBeLessThan(checkPackagedAdmission.mock.invocationCallOrder[0]);
      checkPackagedAdmission.mockRejectedValue(new Error('package check refused'));
      await expect(sign(options)).rejects.toThrow('package check refused');
      vi.stubEnv('BRIAN_NATIVE_PACKAGE_CHECK', '0');
      sealNativeBootstrap.mockClear();
      expect(options.optionsForFile()).toBe(inherited);
      signAsync.mockImplementation(async () => {});
      await expect(sign(options)).rejects.toThrow('skipped');
      signAsync.mockRejectedValue(new Error('codesign failed'));
      await expect(sign(options)).rejects.toThrow('codesign failed');
      expect(sealNativeBootstrap).not.toHaveBeenCalled();
      signAsync.mockClear();
      for (const identity of ['', '-', undefined]) {
        await expect(sign({ ...options, identity })).rejects.toThrow('selected signing identity');
      }
      expect(signAsync).not.toHaveBeenCalled();
      for (const key of ['CSC_NAME', 'CSC_LINK', 'CSC_KEYCHAIN']) vi.stubEnv(key, '');
      const localPackager = { forceCodeSigning: false, platformSpecificBuildOptions: {} };
      await sign({ ...options, identity: undefined }, localPackager);
      expect(signAsync).not.toHaveBeenCalled();
      await expect(sign({ ...options, identity: undefined }, { ...localPackager, forceCodeSigning: true }))
        .rejects.toThrow('selected signing identity');
      vi.stubEnv('BRIAN_NATIVE_PACKAGE_CHECK', '1');
      await expect(sign({ ...options, identity: undefined }, localPackager)).rejects.toThrow('selected signing identity');
      vi.stubEnv('BRIAN_NATIVE_PACKAGE_CHECK', '0');
      vi.stubEnv('CSC_NAME', 'configured release identity');
      await expect(sign({ ...options, identity: undefined }, localPackager)).rejects.toThrow('selected signing identity');
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock('@electron/osx-sign'); vi.doUnmock('../../scripts/mac-release-bootstrap.mjs');
      vi.doUnmock('../../scripts/mac-packaged-admission-check.mjs'); vi.resetModules(); log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the custom signer while constraining native control to the supported action surface', () => {
    const config = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
    expect(config).toContain('sign: scripts/sign-mac-app.mjs');
    const helper = readFileSync(new URL('../../native/computer-control/Helper.swift', import.meta.url), 'utf8');
    expect(helper).toContain('ObservationDispatcher');
    expect(helper).toContain('guard supportedGrant(payload), grant == nil');
    expect(helper).toContain('guard supportedExecution(command) else { return result("denied") }');
    expect(helper).toContain('func semanticKind(_ kind: String) -> Bool { ["invoke", "setValue", "select", "scroll"].contains(kind) }');
  });
});
