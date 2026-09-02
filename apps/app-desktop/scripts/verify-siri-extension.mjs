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

  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", appPath],
    {
      stdio: "inherit",
    },
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
