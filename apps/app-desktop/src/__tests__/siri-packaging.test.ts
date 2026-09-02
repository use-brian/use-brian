import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("[COMP:app-desktop/siri] App Intents packaging", () => {
  it("declares a launchable ExtensionKit App Intents provider", () => {
    const plist = read("../../native/siri-companion/Info.plist");
    const project = read(
      "../../native/siri-companion/BrianSiri.xcodeproj/project.pbxproj",
    );

    expect(plist).toContain("<key>EXAppExtensionAttributes</key>");
    expect(plist).toContain("<key>EXExtensionPointIdentifier</key>");
    expect(plist).toContain("<string>com.apple.appintents-extension</string>");
    expect(plist).not.toContain("<key>NSExtension</key>");
    expect(plist).not.toContain("com.apple.appintents-service");
    expect(project).toContain(
      'productType = "com.apple.product-type.extensionkit-extension";',
    );
  });

  it("embeds and signs the extension in Contents/Extensions", () => {
    const builder = read("../../electron-builder.yml");
    const signer = read("../../scripts/sign-siri-extension.mjs");
    const verifier = read("../../scripts/verify-siri-extension.mjs");

    expect(builder).toContain("afterPack: scripts/sign-siri-extension.mjs");
    expect(builder).toContain("afterSign: scripts/verify-siri-extension.mjs");
    expect(builder).toContain("to: Extensions/Brian Siri.appex");
    expect(builder).toContain('"Contents/Extensions/Brian Siri\\\\.appex"');
    expect(builder).not.toContain("to: PlugIns/Brian Siri.appex");
    expect(signer).toContain('"Extensions"');
    expect(signer).not.toContain('"PlugIns"');
    expect(signer).toContain("context.packager.codeSigningInfo.value");
    expect(signer).toContain('args.push("--keychain", keychain)');
    expect(verifier).toContain('"--verify", "--strict", extensionPath');
    expect(verifier).toContain("releaseSigningConfigured");
    expect(verifier).toContain('"--verify", "--deep", "--strict"');
    expect(verifier).toContain("com.apple.security.app-sandbox");
  });

  it("builds the extension with the desktop version before packaging", () => {
    const packageJson = JSON.parse(read("../../package.json")) as {
      scripts: Record<string, string>;
    };
    const build = read("../../native/siri-companion/build.sh");
    const release = read("../../../../scripts/package-desktop.sh");

    expect(packageJson.scripts["build:siri"]).toBe(
      "bash native/siri-companion/build.sh",
    );
    expect(packageJson.scripts.package).toContain(
      "pnpm run build:siri && electron-builder --mac",
    );
    expect(build).toContain('MARKETING_VERSION="$VERSION"');
    expect(build).toContain('CURRENT_PROJECT_VERSION="$VERSION"');
    expect(release).toContain(
      "pnpm --filter @use-brian/app-desktop run build:siri",
    );
  });

  it("opens the supported bounded ask deep link", () => {
    const intent = read("../../native/siri-companion/AskBrianIntent.swift");

    expect(intent).toContain('components.scheme = "usebrian"');
    expect(intent).toContain('components.host = "ask"');
    expect(intent).toContain("prompt.utf16.count <= 8_000");
    expect(intent).toContain("NSWorkspace.shared.open(url)");
  });
});
