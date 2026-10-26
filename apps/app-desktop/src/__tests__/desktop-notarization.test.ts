import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the exact transitive library electron-builder loads. Mock only the
// macOS/Apple boundaries; keep its actual promise-retry orchestration intact.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const packagerRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
const notarizeRequire = createRequire(packagerRequire.resolve('@electron/notarize'));
const { notarize } = notarizeRequire('./index.js');
const signature = notarizeRequire('./check-signature.js');
const notarytool = notarizeRequire('./notarytool.js');
const staple = notarizeRequire('./staple.js');
const options = { appPath: '/tmp/Fictional Desktop.app', appleId: 'release@example.com',
  appleIdPassword: 'fictional-password', teamId: 'EXAMPLETEAM' };

function appleBoundaries() {
  return {
    signature: vi.spyOn(signature, 'checkSignatures').mockResolvedValue(undefined),
    available: vi.spyOn(notarytool, 'isNotaryToolAvailable').mockResolvedValue(true),
    submit: vi.spyOn(notarytool, 'notarizeAndWaitForNotaryTool').mockResolvedValue(undefined),
    staple: vi.spyOn(staple, 'stapleApp').mockResolvedValue(undefined),
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('[COMP:app-desktop/packaging] installed notarization retry', () => {
  it('recovers on the fourth stapling attempt with one notarization submission', async () => {
    vi.useFakeTimers();
    const apple = appleBoundaries();
    const network = new Error('Failed to staple your application with code: 68; network connection lost');
    apple.staple.mockRejectedValueOnce(network).mockRejectedValueOnce(network).mockRejectedValueOnce(network);
    const result = notarize(options).then(() => null, (error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeNull();
    expect(apple.signature).toHaveBeenCalledTimes(1);
    expect(apple.submit).toHaveBeenCalledTimes(1);
    expect(apple.staple).toHaveBeenCalledTimes(4);
  });

  it('fails after four unsuccessful stapling attempts without resubmission', async () => {
    vi.useFakeTimers();
    const apple = appleBoundaries();
    const network = new Error('Failed to staple your application with code: 68');
    apple.staple.mockRejectedValue(network);
    const result = notarize(options).then(() => null, (error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBe(network);
    expect(apple.submit).toHaveBeenCalledTimes(1);
    expect(apple.staple).toHaveBeenCalledTimes(4);
  });

  it('never retries a rejected notarization submission', async () => {
    const apple = appleBoundaries();
    const rejection = new Error('Notarization rejected');
    apple.submit.mockRejectedValue(rejection);
    await expect(notarize(options)).rejects.toBe(rejection);
    expect(apple.submit).toHaveBeenCalledTimes(1);
    expect(apple.staple).not.toHaveBeenCalled();
  });

  it('stops before notarization when signature verification fails', async () => {
    const apple = appleBoundaries();
    const rejection = new Error('Signature invalid');
    apple.signature.mockRejectedValue(rejection);
    await expect(notarize(options)).rejects.toBe(rejection);
    expect(apple.submit).not.toHaveBeenCalled();
    expect(apple.staple).not.toHaveBeenCalled();
  });
});
