import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function packageFixture(gatekeeperExit = 0, extraArgs: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "desktop-package-test-"));
  dirs.push(root);
  for (const path of ["scripts", "bin", "apps/app-desktop/release"]) mkdirSync(join(root, path), { recursive: true });
  const sourceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  for (const name of ["package-desktop.sh", "desktop-keychain.sh"]) copyFileSync(join(sourceRoot, "scripts", name), join(root, "scripts", name));
  writeFileSync(join(root, "apps/app-desktop/package.json"), JSON.stringify({ version: "0.0.12" }));
  const builder = join(root, "apps/app-desktop/node_modules/electron-builder");
  const library = join(builder, "node_modules/app-builder-lib");
  mkdirSync(join(library, "certs"), { recursive: true });
  for (const directory of [builder, library]) writeFileSync(join(directory, "package.json"), "{}");
  writeFileSync(join(library, "certs/root_certs.keychain"), "dummy-public-chain");
  for (const file of ["usebrian.dmg", "usebrian.zip"]) writeFileSync(join(root, "apps/app-desktop/release", file), "fictional artifact");
  const log = join(root, "calls.jsonl");
  for (const command of ["uname", "security", "pnpm", "codesign", "xcrun", "spctl"]) {
    writeFileSync(join(root, "bin", command), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
// Do not record security's credential arguments even in a disposable fixture.
if ('${command}' !== 'security') fs.appendFileSync(process.env.PACKAGE_TEST_LOG, JSON.stringify(['${command}', ...args]) + '\\n');
if ('${command}' === 'pnpm' && args.includes('electron-builder')) fs.appendFileSync(process.env.PACKAGE_TEST_LOG, JSON.stringify(['native-package-check-mode', process.env.BRIAN_NATIVE_PACKAGE_CHECK]) + '\\n');
if ('${command}' === 'uname') console.log('Darwin');
if ('${command}' === 'security' && args[0] === 'find-identity') console.log('1) ${"A".repeat(40)} "Developer ID Application: Example"');
if ('${command}' === 'spctl') process.exit(${gatekeeperExit});
`, { mode: 0o755 });
  }
  const result = spawnSync("bash", [join(root, "scripts/package-desktop.sh"), "--version", "0.0.13", "--arm64", ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, TMPDIR: root, PACKAGE_TEST_LOG: log,
      BRIAN_NATIVE_PACKAGE_CHECK: "1", // inherited mode must not silently opt in
      CSC_LINK: Buffer.from("fictional-certificate").toString("base64"), CSC_KEY_PASSWORD: "fixture-password",
      APPLE_ID: "release@example.com", APPLE_APP_SPECIFIC_PASSWORD: "fixture-password", APPLE_TEAM_ID: "EXAMPLETEAM" },
  });
  const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  return { ...result, calls, root };
}

describe("[COMP:app-desktop/packaging] desktop packaging", () => {
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
    expect(result.calls).toContainEqual(["native-package-check-mode", "0"]);
    expect(JSON.parse(readFileSync(join(result.root, "apps/app-desktop/package.json"), "utf8")).version).toBe("0.0.13");
    expect(result.stdout + result.stderr).not.toContain("fixture-password");
  }, 30_000);

  it("explicitly passes the package check to the existing signer without publication", () => {
    const result = packageFixture(0, ["--native-package-check"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContainEqual(["native-package-check-mode", "1"]);
    expect(result.calls.find(call => call.includes("electron-builder"))?.slice(-2)).toEqual(["--publish", "never"]);
  }, 30_000);

  it.each(["--publish", "--no-build"])("refuses package-check combined with %s before build/version mutation", flag => {
    const result = packageFixture(0, ["--native-package-check", flag]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot combine");
    expect(result.calls.some(call => call[0] === "pnpm")).toBe(false);
    expect(JSON.parse(readFileSync(join(result.root, "apps/app-desktop/package.json"), "utf8")).version).toBe("0.0.12");
  });

  it("fails when Gatekeeper rejects the signed installer", () => {
    const result = packageFixture(7);
    expect(result.status).toBe(7);
    expect(result.stdout).not.toContain("==> Done.");
  }, 30_000);
});
