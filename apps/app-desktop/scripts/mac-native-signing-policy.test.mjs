import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  withNativeHelperSigningPolicy, nativeHelperRelativePath, nativeHelperEntitlements,
} from "./mac-native-signing-policy.mjs";

const app = "/package/Brian.app";
const helper = `${app}/${nativeHelperRelativePath}`;
const broad = Object.freeze({
  entitlements: Object.freeze([
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
  ]),
  hardenedRuntime: false,
  signatureFlags: Object.freeze(["kill", "debugger"]),
  additionalArguments: Object.freeze([
    "--entitlements", "/electron.plist", "--options", "none", "--deep",
  ]),
  requirements: "=designated => anchor apple generic",
  timestamp: "https://timestamp.apple.com/ts01",
});

// No package/fixture writes or signing: model the read-only filesystem boundary.
function packagePaths(t, resolve = (p) => p) {
  t.mock.method(fs, "realpathSync", resolve);
  t.mock.method(fs, "lstatSync", () => ({ isFile: () => true }));
}

test("exact helper gets empty entitlements and no inherited broad flags/arguments", (t) => {
  packagePaths(t);
  const calls = [];
  const input = Object.freeze({
    app, platform: "darwin", identity: "existing-identity", keychain: "existing-keychain",
    preAutoEntitlements: true,
    optionsForFile(file) { assert.equal(this, input); calls.push(file); return broad; },
  });
  const output = withNativeHelperSigningPolicy(input, app);
  assert.notEqual(output, input);
  for (const key of Object.keys(input).filter((k) => k !== "optionsForFile")) {
    assert.strictEqual(output[key], input[key]);
  }
  assert.deepEqual(output.optionsForFile(helper), {
    entitlements: nativeHelperEntitlements, hardenedRuntime: true,
    signatureFlags: [], additionalArguments: [],
    requirements: broad.requirements, timestamp: broad.timestamp,
  });
  const first = output.optionsForFile(helper);
  first.additionalArguments.push("--deep");
  assert.deepEqual(output.optionsForFile(helper).additionalArguments, []);
  assert.deepEqual(calls, [helper, helper, helper]);
  assert.equal(broad.hardenedRuntime, false);
});

test("root, Electron, fixture, Siri and basename lookalikes are unchanged by identity", (t) => {
  packagePaths(t);
  const files = [
    app, `${app}/Contents/MacOS/Brian`,
    `${app}/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`,
    `${app}/Contents/Resources/computer-control/NativeComputerFixture.app`,
    `${app}/Contents/Resources/computer-control/NativeComputerFixture.app/Contents/MacOS/NativeComputerFixture`,
    `${app}/Contents/Extensions/Brian Siri.appex`,
    `${app}/Contents/Extensions/Brian Siri.appex/Contents/MacOS/BrianSiri`,
    `${app}/Contents/MacOS/brian-native-computer-helper`,
    `${helper}.backup`, `/other/Brian.app/${nativeHelperRelativePath}`,
  ];
  const seen = [];
  const wrapped = withNativeHelperSigningPolicy({ app, optionsForFile(file) {
    seen.push(file); return broad;
  } });
  for (const file of files) assert.strictEqual(wrapped.optionsForFile(file), broad);
  assert.deepEqual(seen, files);
});

test("absent callback/results retain defaults for others, never for helper", (t) => {
  packagePaths(t);
  for (const optionsForFile of [undefined, () => undefined, () => null]) {
    const wrapped = withNativeHelperSigningPolicy({ app, optionsForFile });
    assert.equal(wrapped.optionsForFile(helper).entitlements, nativeHelperEntitlements);
    assert.equal(wrapped.optionsForFile(app), optionsForFile?.(app));
  }
});

test("reject ambiguous paths instead of normalizing into helper", (t) => {
  packagePaths(t);
  const wrapped = withNativeHelperSigningPolicy({ app });
  for (const file of [
    "Contents/Resources/computer-control/brian-native-computer-helper",
    `${app}//${nativeHelperRelativePath}`, `${app}/./${nativeHelperRelativePath}`,
    `${app}/elsewhere/../${nativeHelperRelativePath}`, `${helper}/`,
    `${helper}\0`, helper.replaceAll("/", "\\"), helper.toUpperCase(),
    null, new URL("file:///package/Brian.app"),
  ]) assert.throws(() => wrapped.optionsForFile(file), /signing policy/);
  for (const badApp of ["Brian.app", `${app}/`, "/package/../Brian.app", "/package/Brian"]) {
    assert.throws(() => withNativeHelperSigningPolicy({ app: badApp }), /signing policy/);
  }
  assert.throws(() => withNativeHelperSigningPolicy({ app }, "/other/Brian.app"), /mismatch/);
});

test("reject helper symlink/ancestor aliases, aliases submitted as other files, and missing paths", (t) => {
  packagePaths(t, (p) => p === helper ? "/elsewhere/helper" : p);
  assert.throws(() => withNativeHelperSigningPolicy({ app }), /alias/);
  fs.realpathSync.mock.mockImplementation((p) => p);
  fs.lstatSync.mock.mockImplementation(() => ({ isFile: () => false }));
  assert.throws(() => withNativeHelperSigningPolicy({ app }), /non-file/);
  fs.lstatSync.mock.mockImplementation(() => ({ isFile: () => true }));
  const wrapped = withNativeHelperSigningPolicy({ app });
  fs.realpathSync.mock.mockImplementation((p) => p === "/alias" ? helper : p);
  assert.throws(() => wrapped.optionsForFile("/alias"), /confusion/);
  fs.realpathSync.mock.mockImplementation((p) => p === helper ? "/replacement" : p);
  assert.throws(() => wrapped.optionsForFile(helper), /confusion/);
  fs.realpathSync.mock.mockImplementation(() => { throw new Error("ENOENT"); });
  assert.throws(() => withNativeHelperSigningPolicy({ app }), /ENOENT/);
});

test("reject unsupported option surfaces and callback results", (t) => {
  packagePaths(t);
  for (const input of [
    null, [], { app, platform: "mas" }, { app, optionsForFile: {} },
    { app, additionalArguments: ["--deep"] }, { app, entitlements: "/broad.plist" },
    { app, "entitlements-inherit": "/broad.plist" },
    { app, get optionsForFile() { throw new Error("must not invoke getter"); } },
  ]) assert.throws(() => withNativeHelperSigningPolicy(input), /signing policy/);
  for (const result of [
    Promise.resolve(broad), [], "entitlements.plist", { unknown: true },
    { hardenedRuntime: "true" }, { additionalArguments: "--deep" },
    { entitlements: [true] }, { timestamp: false },
    { get entitlements() { throw new Error("must not invoke getter"); } },
  ]) {
    const wrapped = withNativeHelperSigningPolicy({ app, optionsForFile: () => result });
    assert.throws(() => wrapped.optionsForFile(helper), /signing policy/);
    assert.throws(() => wrapped.optionsForFile(app), /signing policy/);
  }
  const wrapped = withNativeHelperSigningPolicy({ app, optionsForFile() { throw new Error("original failure"); } });
  assert.throws(() => wrapped.optionsForFile(helper), /original failure/);
});

test("checked-in helper plist is an empty dictionary, unlike Electron entitlements", () => {
  const require = createRequire(import.meta.url);
  // Use the desktop's installed plist parser; no new dependency or subprocess.
  const plist = require("plist");
  assert.deepEqual(plist.parse(fs.readFileSync(nativeHelperEntitlements, "utf8")), {});
  const electron = plist.parse(fs.readFileSync(
    new URL("../build/entitlements.mac.plist", import.meta.url), "utf8",
  ));
  for (const key of broad.entitlements) assert.equal(electron[key], true);
});
