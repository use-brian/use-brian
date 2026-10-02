import { verifyMacBootstrap } from "./electron-fuses.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNativeHelperEntitlements } from "./mac-native-signing-policy.mjs";
import { verifyPackagedNativeBootstrap } from "./mac-release-bootstrap.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default async function verifySiriExtension(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  // Acceptance check only: never repair unsafe fuses after signing.
  await verifyMacBootstrap(appPath);

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
  // Auto-discovered Developer ID identities need no CSC_* hints. Inspect the
  // actual artifact before deciding whether a credential-free local repair is
  // permissible; never rewrite a developer-signed/notarized package ad hoc.
  const signing = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", appPath], { encoding: "utf8" });
  if (signing.status !== 0) throw new Error("Could not inspect desktop signing team");
  const team = `${signing.stdout}\n${signing.stderr}`.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
  const releaseSigningConfigured = Boolean(
    team || process.env.CSC_LINK?.trim() ||
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
    const extensionEntitlements = join(
      __dirname,
      "..",
      "native",
      "siri-companion",
      "BrianSiri.entitlements",
    );

    // The stock Electron bundle contains signed nested frameworks. Packaging
    // changes invalidate their resource seals, so a root-only ad-hoc signature
    // still fails strict verification. Re-sign nested code first, restore the
    // extension's dedicated sandbox entitlement, then seal the parent last.
    execFileSync(
      "/usr/bin/codesign",
      ["--force", "--deep", "--sign", "-", appPath],
      { stdio: "inherit" },
    );
    execFileSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        "-",
        "--entitlements",
        extensionEntitlements,
        extensionPath,
      ],
      { stdio: "inherit" },
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

  // The private native-control helper is executable code, not an unsigned asset.
  // Verify its nested signature independently after the complete app is sealed.
  execFileSync("/usr/bin/codesign", ["--verify", "--strict",
    join(appPath, "Contents", "Resources", "computer-control", "brian-native-computer-helper")], { stdio: "inherit" });

  const frameworkPath = join(appPath, "Contents", "Frameworks", "Electron Framework.framework");
  // Verify the framework's OWN static signature/resource seal, not just a nested
  // designated requirement in the launcher's resource envelope.
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", frameworkPath], { stdio: "inherit" });

  const fixturePath = join(appPath, "Contents", "Resources", "computer-control", "NativeComputerFixture.app");
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", fixturePath], { stdio: "inherit" });

  // Release verification must reject ad-hoc, wrong-ID or cross-team nested code.
  // Local ad-hoc packages may still build, but the helper refuses their authority.
  if (releaseSigningConfigured) {
    if (!team) throw new Error("Desktop requires a non-ad-hoc signing team");
    const sameTeam = `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`;
    for (const [path, identifier] of [
      [appPath, "ai.usebrian.desktop"],
      [join(appPath, "Contents", "Resources", "computer-control", "brian-native-computer-helper"), null],
      [fixturePath, "com.usebrian.NativeComputerFixture"],
      [frameworkPath, null],
    ]) {
      // codesign interprets -R as a filename unless the expression starts '='.
      const requirement = "=" + sameTeam + (identifier ? ` and identifier "${identifier}"` : "");
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", "-R", requirement, path], { stdio: "inherit" });
    }
    // Verify the final artifact, not just the options passed to the signer.
    // The standalone helper must never inherit Electron's executable-memory or
    // library-validation exceptions. Missing/unparseable output is not absence.
    verifyNativeHelperEntitlements(join(appPath, "Contents", "Resources", "computer-control", "brian-native-computer-helper"));
    await verifyPackagedNativeBootstrap(appPath, team);
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
