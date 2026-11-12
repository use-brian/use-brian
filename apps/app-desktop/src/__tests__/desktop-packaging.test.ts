import { cpSync, existsSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function packageFixture(gatekeeperExit = 0, options: { stapleFailures?: number; stapleExit?: number; notaryExit?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "desktop-package-test-"));
  dirs.push(root);
  for (const path of ["scripts", "bin", "apps/app-desktop/release"]) mkdirSync(join(root, path), { recursive: true });
  const sourceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  for (const name of ["package-desktop.sh", "desktop-keychain.sh"]) copyFileSync(join(sourceRoot, "scripts", name), join(root, "scripts", name));
  writeFileSync(join(root, "apps/app-desktop/package.json"), JSON.stringify({ version: "0.0.12" }));
  for (const file of ["usebrian.dmg", "usebrian.zip"]) writeFileSync(join(root, "apps/app-desktop/release", file), "fictional artifact");
  const log = join(root, "calls.jsonl");
  for (const command of ["uname", "security", "pnpm", "codesign", "xcrun", "spctl", "sleep"]) {
    writeFileSync(join(root, "bin", command), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
// Do not record security's credential arguments even in a disposable fixture.
if ('${command}' !== 'security') fs.appendFileSync(process.env.PACKAGE_TEST_LOG, JSON.stringify(['${command}', ...args]) + '\\n');
if ('${command}' === 'uname') console.log('Darwin');
if ('${command}' === 'security' && args[0] === 'find-identity') console.log('1) ${"A".repeat(40)} "Developer ID Application: Example"');
if ('${command}' === 'xcrun') {
  if (args[0] === 'stapler' && args[1] === 'validate' && ${options.stapleFailures !== undefined || options.notaryExit !== undefined}) process.exit(1);
  if (args[0] === 'notarytool' && args[1] === 'submit') process.exit(${options.notaryExit ?? 0});
  if (args[0] === 'stapler' && args[1] === 'staple') {
    const attempts = fs.readFileSync(process.env.PACKAGE_TEST_LOG, 'utf8').trim().split('\\n')
      .map(line => JSON.parse(line)).filter(call => call[0] === 'xcrun' && call[1] === 'stapler' && call[2] === 'staple').length;
    if (attempts <= ${options.stapleFailures ?? 0}) process.exit(${options.stapleExit ?? 68});
  }
}
if ('${command}' === 'spctl') process.exit(${gatekeeperExit});
`, { mode: 0o755 });
  }
  const result = spawnSync("bash", [join(root, "scripts/package-desktop.sh"), "--version", "0.0.13", "--arm64"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, TMPDIR: root, PACKAGE_TEST_LOG: log,
      CSC_LINK: Buffer.from("fictional-certificate").toString("base64"), CSC_KEY_PASSWORD: "fixture-password",
      APPLE_ID: "release@example.com", APPLE_APP_SPECIFIC_PASSWORD: "fixture-password", APPLE_TEAM_ID: "EXAMPLETEAM" },
  });
  const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  return { ...result, calls, root };
}

describe("[COMP:app-desktop/packaging] desktop packaging", () => {
  it("ships nonempty tray images under dist without the build-resource directory", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-tray-test-"));
    dirs.push(root);
    const desktop = join(root, "app-desktop");
    const source = fileURLToPath(new URL("../../", import.meta.url));
    for (const directory of ["scripts", "src", "build"]) {
      cpSync(join(source, directory), join(desktop, directory), { recursive: true });
    }
    mkdirSync(join(desktop, "dist"));
    mkdirSync(join(root, "app-web", "public"), { recursive: true });
    copyFileSync(join(source, "../app-web/public/icon.png"), join(root, "app-web/public/icon.png"));
    const result = spawnSync(process.execPath, [join(desktop, "scripts/copy-static.mjs")], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    rmSync(join(desktop, "build"), { recursive: true });
    for (const name of ["icon.png", "trayTemplate.png", "trayTemplate@2x.png"]) {
      const shipped = readFileSync(join(desktop, "dist/tray", name));
      expect(shipped).toEqual(readFileSync(join(source, "build", name)));
      expect(shipped.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(shipped.readUInt32BE(16)).toBeGreaterThan(0);
      expect(shipped.readUInt32BE(20)).toBeGreaterThan(0);
    }
  });

  it("builds the desktop renderer's workspace dependencies before Vite", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["build:renderer"]).toBe(
      'pnpm --filter "app-web^..." run build && pnpm --filter app-web build:desktop',
    );
  });

  // The shell launches real Node command doubles; allow for shared CI CPU.
  it("packages from environment credentials without an env file and pins the requested architecture", () => {
    const result = packageFixture();
    expect(result.status, result.stderr).toBe(0);
    const pnpm = result.calls.filter((call) => call[0] === "pnpm");
    expect(pnpm[0]).toEqual(["pnpm", "--filter", "@use-brian/app-desktop", "run", "build:renderer"]);
    expect(pnpm.at(-1)).toContain("--arm64");
    expect(pnpm.at(-1)?.slice(-2)).toEqual(["--publish", "never"]);
    expect(JSON.parse(readFileSync(join(result.root, "apps/app-desktop/package.json"), "utf8")).version).toBe("0.0.13");
    expect(result.stdout + result.stderr).not.toContain("fixture-password");
  }, 30_000);

  it("retries the DMG ticket download without rebuilding or resubmitting notarization", () => {
    const result = packageFixture(0, { stapleFailures: 3 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter(call => call[0] === "xcrun" && call[1] === "stapler" && call[2] === "staple")).toHaveLength(4);
    expect(result.calls.filter(call => call[0] === "xcrun" && call[1] === "notarytool" && call[2] === "submit")).toHaveLength(1);
    expect(result.calls.filter(call => call[0] === "pnpm" && call.includes("electron-builder"))).toHaveLength(1);
    expect(result.calls.filter(call => call[0] === "sleep")).toEqual([["sleep", "15"], ["sleep", "30"], ["sleep", "60"]]);
    expect(result.calls.some(call => call[0] === "spctl")).toBe(true);
  }, 30_000);

  it("fails after four DMG ticket download errors and never reaches Gatekeeper", () => {
    const result = packageFixture(0, { stapleFailures: 4 });
    expect(result.status).toBe(68);
    expect(result.calls.filter(call => call[0] === "xcrun" && call[1] === "stapler" && call[2] === "staple")).toHaveLength(4);
    expect(result.calls.filter(call => call[0] === "sleep")).toHaveLength(3);
    expect(result.calls.some(call => call[0] === "spctl")).toBe(false);
    expect(result.stdout).not.toContain("==> Done.");
  }, 30_000);

  it("refuses a non-download stapler error immediately", () => {
    const result = packageFixture(0, { stapleFailures: 4, stapleExit: 66 });
    expect(result.status).toBe(66);
    expect(result.calls.filter(call => call[0] === "xcrun" && call[1] === "stapler" && call[2] === "staple")).toHaveLength(1);
    expect(result.calls.some(call => call[0] === "sleep" || call[0] === "spctl")).toBe(false);
  }, 30_000);

  it("does not retry a refused DMG notarization submission", () => {
    const result = packageFixture(0, { notaryExit: 65 });
    expect(result.status).toBe(65);
    expect(result.calls.filter(call => call[0] === "xcrun" && call[1] === "notarytool" && call[2] === "submit")).toHaveLength(1);
    expect(result.calls.some(call => call[0] === "xcrun" && call[1] === "stapler" && call[2] === "staple")).toBe(false);
    expect(result.calls.some(call => call[0] === "sleep" || call[0] === "spctl")).toBe(false);
  }, 30_000);

  it("retains Gatekeeper refusal after a successful DMG stapling retry", () => {
    const result = packageFixture(7, { stapleFailures: 3 });
    expect(result.status).toBe(7);
    expect(result.calls.filter(call => call[0] === "xcrun" && call[1] === "stapler" && call[2] === "staple")).toHaveLength(4);
    expect(result.stdout).not.toContain("==> Done.");
  }, 30_000);

  it("fails when Gatekeeper rejects the signed installer", () => {
    const result = packageFixture(7);
    expect(result.status).toBe(7);
    expect(result.stdout).not.toContain("==> Done.");
  }, 30_000);
});


describe("[COMP:app-desktop/packaging] retired account page", () => {
  it("removes the obsolete page from incremental builds", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-assets-test-"));
    dirs.push(root);
    const desktop = fileURLToPath(new URL("../../", import.meta.url));
    const pkg = join(root, "apps/app-desktop");
    for (const name of ["src", "build", "scripts"]) cpSync(join(desktop, name), join(pkg, name), { recursive: true });
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(root, "apps/app-web/public"), { recursive: true });
    writeFileSync(join(root, "apps/app-web/public/icon.png"), "fictional icon");
    writeFileSync(join(pkg, "dist/signin.html"), "obsolete page");
    const result = spawnSync(process.execPath, [join(pkg, "scripts/copy-static.mjs")], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(pkg, "dist/signin.html"))).toBe(false);
    expect(existsSync(join(desktop, "src/signin.html"))).toBe(false);
    expect(existsSync(join(pkg, "dist/preload.cjs"))).toBe(true);
  });
});


vi.mock("../../scripts/sign-siri-extension.mjs", () => ({ default: vi.fn() }));

const yaml = createRequire(import.meta.url)("js-yaml");
const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));
const builder = yaml.load(readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8"));
const packagingHook = await import(new URL(`../../${builder.afterPack}`, import.meta.url).href);
const siriSigner = await import(new URL("../../scripts/sign-siri-extension.mjs", import.meta.url).href);

function updateConfigFixture(platform = "darwin") {
  const root = mkdtempSync(join(tmpdir(), "desktop-update-config-"));
  dirs.push(root);
  const resources = join(root, platform === "darwin" ? "Use Brian.app/Contents/Resources" : "resources");
  mkdirSync(resources, { recursive: true });
  const configPath = join(resources, "app-update.yml");
  const context = {
    appOutDir: root, electronPlatformName: platform, targets: [],
    packager: {
      config: { publish: builder.publish }, platformSpecificBuildOptions: {},
      appInfo: { updaterCacheDirName: "desktop-test-updater" },
      getResourcesDir: () => resources,
    },
  };
  return { context, configPath };
}

describe("[COMP:app-desktop/packaging] packaged updater configuration", () => {
  it.each(["darwin", "win32"])("includes the release feed in a %s directory package before signing", async (platform) => {
    const { context, configPath } = updateConfigFixture(platform);
    siriSigner.default.mockImplementationOnce(() => {
      expect(yaml.load(readFileSync(configPath, "utf8"))).toEqual({
        provider: builder.publish.provider, owner: builder.publish.owner, repo: builder.publish.repo,
        updaterCacheDirName: "desktop-test-updater",
      });
    });
    await packagingHook.default(context);
    expect(siriSigner.default).toHaveBeenCalledWith(context);
    // Exercise the installed updater library's own config reader, rather than
    // accepting a file that only our packaging code knows how to parse.
    const { AppUpdater } = createRequire(import.meta.url)("electron-updater/out/AppUpdater");
    const updater = new AppUpdater(null, { version: "1.0.0", appUpdateConfigPath: configPath });
    expect(await updater.configOnDisk.value).toMatchObject(builder.publish);
  });

  it("preserves builder-generated signing metadata", async () => {
    const { context, configPath } = updateConfigFixture("win32");
    const generated = yaml.dump({ ...builder.publish, updaterCacheDirName: "desktop-test-updater", publisherName: ["Example Publisher"] });
    writeFileSync(configPath, generated);
    await packagingHook.default(context);
    expect(readFileSync(configPath, "utf8")).toBe(generated);
  });

  it.each(["provider", "owner", "repo", "updaterCacheDirName"])("refuses a conflicting %s before signing", async (key) => {
    const { context, configPath } = updateConfigFixture();
    writeFileSync(configPath, yaml.dump({ ...builder.publish, updaterCacheDirName: "desktop-test-updater", [key]: "wrong" }));
    siriSigner.default.mockClear();
    await expect(packagingHook.default(context)).rejects.toThrow(`app-update.yml: ${key}`);
    expect(siriSigner.default).not.toHaveBeenCalled();
  });

  it("refuses malformed existing metadata before signing", async () => {
    const { context, configPath } = updateConfigFixture();
    writeFileSync(configPath, "provider: [invalid");
    siriSigner.default.mockClear();
    await expect(packagingHook.default(context)).rejects.toThrow();
    expect(siriSigner.default).not.toHaveBeenCalled();
  });

  it.each([null, {}, { provider: "github", owner: "", repo: "desktop" }, { provider: "generic", url: "https://example.com" }])("refuses missing or invalid release configuration: %j", async (publish) => {
    const { context } = updateConfigFixture();
    context.packager.config.publish = publish;
    siriSigner.default.mockClear();
    await expect(packagingHook.default(context)).rejects.toThrow("Desktop packaging requires");
    expect(siriSigner.default).not.toHaveBeenCalled();
  });

  it("honors an explicit platform publish override", async () => {
    const { context } = updateConfigFixture();
    Object.assign(context.packager.platformSpecificBuildOptions, { publish: null });
    await expect(packagingHook.default(context)).rejects.toThrow("Desktop packaging requires");
  });
});
