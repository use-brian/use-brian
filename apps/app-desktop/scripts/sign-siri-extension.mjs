import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function availableSigningIdentity(context) {
  // Force electron-builder to import CSC_LINK now, then reuse the same temporary
  // keychain its parent-app signer will use after this hook.
  const signingInfo = await context.packager.codeSigningInfo.value;
  const keychain =
    signingInfo?.keychainFile ?? process.env.CSC_KEYCHAIN?.trim() ?? null;
  const requested = process.env.CSC_NAME?.trim();
  if (requested) return { identity: requested, keychain };

  try {
    const args = ["find-identity", "-v", "-p", "codesigning"];
    if (keychain) args.push(keychain);
    const identities = execFileSync("/usr/bin/security", args, {
      encoding: "utf8",
    });
    const identity =
      identities.match(/\b([0-9A-F]{40})\b.*Developer ID Application/)?.[1] ??
      "-";
    return { identity, keychain };
  } catch {
    return { identity: "-", keychain };
  }
}

export default async function signSiriExtension(context) {
  if (context.electronPlatformName !== "darwin") return;

  const extensionPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Extensions",
    "Brian Siri.appex",
  );
  const entitlementsPath = join(
    __dirname,
    "..",
    "native",
    "siri-companion",
    "BrianSiri.entitlements",
  );
  const { identity, keychain } = await availableSigningIdentity(context);
  if (identity === "-" && process.env.CSC_LINK) {
    throw new Error(
      "The Siri extension could not find the Developer ID identity from CSC_LINK.",
    );
  }

  const args = [
    "--force",
    "--sign",
    identity,
    "--entitlements",
    entitlementsPath,
  ];
  if (identity !== "-") args.push("--timestamp", "--options", "runtime");
  if (keychain) args.push("--keychain", keychain);
  args.push(extensionPath);

  execFileSync("/usr/bin/codesign", args, { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", extensionPath], {
    stdio: "inherit",
  });
}
