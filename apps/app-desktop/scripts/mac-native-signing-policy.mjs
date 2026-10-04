import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { spawnSync } from "node:child_process";
import plist from "plist";

export const nativeHelperRelativePath =
  "Contents/Resources/computer-control/brian-native-computer-helper";
export const nativeFixtureRelativePath =
  "Contents/Resources/computer-control/NativeComputerFixture.app";
export const nativeFixtureExecutableRelativePath =
  `${nativeFixtureRelativePath}/Contents/MacOS/NativeComputerFixture`;
export const nativeHelperEntitlements = fileURLToPath(
  new URL("../build/entitlements.native-computer.plist", import.meta.url),
);

const signKeys = new Set([
  "app", "keychain", "platform", "identity", "binaries", "optionsForFile",
  "identityValidation", "ignore", "preAutoEntitlements",
  "preEmbedProvisioningProfile", "provisioningProfile", "strictVerify", "type", "version",
]);
const fileKeys = new Set([
  "entitlements", "hardenedRuntime", "requirements", "signatureFlags", "timestamp",
  "additionalArguments",
]);
const fail = (reason) => { throw new Error(`Native helper signing policy: ${reason}`); };

function record(value, keys) {
  if (!value || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail("unsupported options object");
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!keys.has(key) || !("value" in descriptor) || !descriptor.enumerable) {
      fail("unsupported option or accessor");
    }
  }
}

function canonicalPath(value) {
  if (typeof value !== "string" || !path.posix.isAbsolute(value) ||
      /[\\\x00-\x1f\x7f]/u.test(value) || path.posix.normalize(value) !== value ||
      value.endsWith("/")) fail("expected canonical absolute POSIX path");
  return value;
}

function perFile(value) {
  // osx-sign 1.3.1 accepts an absent result and merges its defaults.
  if (value == null) return;
  record(value, fileKeys);
  const strings = (v) => Array.isArray(v) && v.every((item) => typeof item === "string");
  for (const [key, option] of Object.entries(value)) {
    if (option === undefined) continue;
    const valid = key === "hardenedRuntime" ? typeof option === "boolean"
      : key === "additionalArguments" ? strings(option)
      : ["entitlements", "signatureFlags"].includes(key)
        ? typeof option === "string" || strings(option)
        : typeof option === "string";
    if (!valid) fail(`unsupported ${key}`);
  }
}

// Run both before notarization and during final afterSign verification. Missing
// output is not proof of entitlement absence; require the signed empty profile.
function verifyEmptyNativeEntitlements(target, name) {
  const result = spawnSync('/usr/bin/codesign', ['--display', '--entitlements', ':-', target],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 });
  let policy;
  try {
    if (result.status !== 0 || typeof result.stdout !== 'string' || !result.stdout.trim()) throw new Error();
    policy = plist.parse(result.stdout);
  } catch { throw new Error(`Could not verify ${name.toLowerCase()} entitlements`); }
  if (!policy || Object.getPrototypeOf(policy) !== Object.prototype || Object.keys(policy).length !== 0) {
    throw new Error(`${name} requires the empty entitlement profile`);
  }
}

export function verifyNativeHelperEntitlements(helper) {
  verifyEmptyNativeEntitlements(helper, "Native helper");
}

export function verifyNativeFixtureEntitlements(bundle) {
  verifyEmptyNativeEntitlements(bundle, "Native fixture");
  verifyEmptyNativeEntitlements(`${bundle}/Contents/MacOS/NativeComputerFixture`, "Native fixture executable");
}

/**
 * Prepare the installed @electron/osx-sign 1.3.1 SignOptions for a custom signer:
 *   await signAsync(withNativeHelperSigningPolicy(signOptions, signOptions.app));
 * No signing, credentials, platform commands, or authority/barrier changes.
 *
 * Paths must exist in the finished, quiescent package. Read-only realpath checks
 * reject native aliases/symlinks rather than silently signing them as Electron.
 * This is not a race-proof filesystem sandbox or proof of a signed package.
 * The caller still owns traversal/ignore selection and final signature checks;
 * it must actually submit the helper and fixture for signing, not ignore/skip it.
 */
export function withNativeHelperSigningPolicy(signOptions, appPath) {
  record(signOptions, signKeys);
  if (appPath === undefined) appPath = signOptions.app;
  canonicalPath(appPath);
  if (!appPath.endsWith(".app") || signOptions.app !== appPath) fail("app path mismatch");
  if (signOptions.platform !== undefined && signOptions.platform !== "darwin") {
    fail("only the darwin package is supported");
  }
  const original = signOptions.optionsForFile;
  if (original !== undefined && typeof original !== "function") fail("unsupported optionsForFile");
  const realApp = fs.realpathSync(appPath);
  const protectedPaths = [
    [nativeHelperRelativePath, false],
    [nativeFixtureRelativePath, true],
    [nativeFixtureExecutableRelativePath, false],
  ].map(([relative, directory]) => {
    const lexical = `${appPath}/${relative}`;
    const resolved = fs.realpathSync(lexical);
    const stat = fs.lstatSync(lexical);
    if (resolved !== `${realApp}/${relative}` ||
        !(directory ? stat.isDirectory() : stat.isFile())) {
      fail("native path alias or non-file/directory");
    }
    return { lexical, resolved };
  });

  return {
    ...signOptions,
    optionsForFile(filePath) {
      canonicalPath(filePath);
      // Reject aliases for either fixture signing target as well as the helper.
      const isNative = protectedPaths.some(({ lexical }) => filePath === lexical);
      const resolved = fs.realpathSync(filePath);
      for (const target of protectedPaths) {
        if ((filePath === target.lexical && resolved !== target.resolved) ||
            (filePath !== target.lexical && (resolved === target.resolved ||
              filePath.toLowerCase() === target.lexical.toLowerCase()))) fail("native path confusion");
      }
      const options = original === undefined ? undefined : original.call(signOptions, filePath);
      perFile(options); // In particular, never accept a Promise from an async callback.
      if (!isNative) return options; // Preserve identity and every supported option.
      // Do not spread Electron's per-file options. Explicitly clear raw arguments
      // and signature flags; neither may override the closed native policy.
      return {
        entitlements: nativeHelperEntitlements,
        hardenedRuntime: true,
        signatureFlags: [],
        additionalArguments: [],
        requirements: options?.requirements,
        timestamp: options?.timestamp,
      };
    },
  };
}
