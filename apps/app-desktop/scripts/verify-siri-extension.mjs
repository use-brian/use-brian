import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

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

  // electron-builder permits unsigned local packages when no Developer ID
  // credentials are configured. In that mode the extension is still ad-hoc
  // signed and testable, but the modified parent app intentionally has no valid
  // seal to deep-verify. Release builds must verify the complete bundle.
  const configuredIdentity = context.packager.platformSpecificBuildOptions.identity;
  const releaseSigningConfigured = Boolean(
    process.env.CSC_LINK?.trim() ||
      process.env.CSC_NAME?.trim() ||
      process.env.CSC_KEYCHAIN?.trim() ||
      (typeof configuredIdentity === "string" && configuredIdentity.trim()),
  );
  if (releaseSigningConfigured) {
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", appPath],
      { stdio: "inherit" },
    );
  }

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
