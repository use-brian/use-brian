import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default async function signSiriExtension(context) {
  if (context.electronPlatformName !== "darwin") return;

  const extensionPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "PlugIns",
    "Brian Siri.appex",
  );
  const entitlementsPath = join(
    __dirname,
    "..",
    "native",
    "siri-companion",
    "BrianSiri.entitlements",
  );
  const identities = execFileSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  const identity = identities.match(/\b([0-9A-F]{40})\b.*Developer ID Application/)?.[1] ?? "-";
  const args = ["--force", "--sign", identity, "--entitlements", entitlementsPath];
  if (identity !== "-") args.push("--timestamp", "--options", "runtime");
  args.push(extensionPath);

  execFileSync("/usr/bin/codesign", args, { stdio: "inherit" });
}
