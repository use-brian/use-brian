import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default async function verifySiriExtension(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const extensionPath = join(
    appPath,
    "Contents",
    "Extensions",
    "Brian Siri.appex",
  );

  execFileSync("/usr/bin/codesign", ["--verify", "--strict", extensionPath], {
    stdio: "inherit",
  });

  // electron-builder permits local packages when no Developer ID credentials
  // are configured, but copying the extension invalidates the Electron app's
  // original resource seal. Ad-hoc sign the parent so Launch Services has a
  // valid container from which to discover the App Intent.
  const configuredIdentity = context.packager.platformSpecificBuildOptions.identity;
  const releaseSigningConfigured = Boolean(
    process.env.CSC_LINK?.trim() ||
      process.env.CSC_NAME?.trim() ||
      process.env.CSC_KEYCHAIN?.trim() ||
      (typeof configuredIdentity === "string" && configuredIdentity.trim()),
  );
  if (!releaseSigningConfigured) {
    const parentEntitlements = join(
      __dirname,
      "..",
      "build",
      "entitlements.mac.plist",
    );
    execFileSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        "-",
        "--entitlements",
        parentEntitlements,
        "--options",
        "runtime",
        appPath,
      ],
      { stdio: "inherit" },
    );
  }
  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", appPath],
    { stdio: "inherit" },
  );

  const result = spawnSync(
    "/usr/bin/codesign",
    ["--display", "--entitlements", ":-", extensionPath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr || "Could not inspect the Siri extension entitlements.",
    );
  }
  const entitlements = `${result.stdout}\n${result.stderr}`;
  if (!entitlements.includes("com.apple.security.app-sandbox")) {
    throw new Error(
      "The packaged Siri extension lost its App Sandbox entitlement.",
    );
  }
}
