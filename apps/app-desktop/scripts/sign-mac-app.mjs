// electron-builder's mac.sign hook: keep its identity, temporary keychain,
// traversal and signing implementation. Only the native helper's entitlement
// profile differs from Electron. This does not enable helper admission.
import { signAsync } from '@electron/osx-sign';
import { withNativeHelperSigningPolicy, nativeHelperRelativePath } from './mac-native-signing-policy.mjs';
import { captureUnstampedHelper, sealNativeBootstrap } from './mac-release-bootstrap.mjs';

export default async function signMacApp(options, packager) {
  // Builder also calls custom sign hooks when no identity was found. Preserve
  // its credential-free local-build skip, never substitute an identity or sign
  // a credential-configured/forced release ad hoc.
  if (process.env.BRIAN_NATIVE_PACKAGE_CHECK !== '1' && options?.identity === undefined && packager && !packager.forceCodeSigning &&
      !packager.platformSpecificBuildOptions?.identity &&
      ![process.env.CSC_LINK, process.env.CSC_NAME, process.env.CSC_KEYCHAIN].some(value => value?.trim())) return;
  if (typeof options?.identity !== 'string' || !options.identity.trim() || options.identity.trim() === '-') {
    throw new Error('Native Mac signer requires electron-builder’s selected signing identity');
  }
  const selected = withNativeHelperSigningPolicy(options);
  const unstampedHelper = captureUnstampedHelper(options.app);
  const helper = `${options.app}/${nativeHelperRelativePath}`;
  const original = selected.optionsForFile;
  let helperVisited = false;
  selected.optionsForFile = path => {
    const result = original(path);
    if (path === helper) helperVisited = true;
    return result;
  };
  // Explicit binaries are used by electron-builder for extensionless helpers.
  selected.binaries = [...new Set([...(options.binaries ?? []), helper])];
  await signAsync(selected);
  if (!helperVisited) throw new Error('Native helper was skipped by the Mac signer');
  const approval = await sealNativeBootstrap(selected, unstampedHelper);
  if (process.env.BRIAN_NATIVE_PACKAGE_CHECK === '1') {
    // Explicit operator package check only. Reuse the selected keychain before
    // builder notarization; copies only, no production mutation or publication.
    const { checkPackagedAdmission } = await import('./mac-packaged-admission-check.mjs');
    await checkPackagedAdmission(selected, approval);
    console.log('PASS packaged-parent framework substitution check. Native control remains disabled; inspector/task acceptance is separate.');
  }
}
