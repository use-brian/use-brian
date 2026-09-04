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
    expect(verifier).toContain('["--force", "--deep", "--sign", "-", appPath]');
    expect(verifier).toContain('"BrianSiri.entitlements"');
    expect(verifier).toContain('"entitlements.mac.plist"');
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

  it("opens the supported bounded Use Brian deep link", () => {
    const intent = read("../../native/siri-companion/UseBrianIntent.swift");

    expect(intent).toContain("struct UseBrianIntent: AppIntent");
    expect(intent).toContain("intent: UseBrianIntent()");
    expect(intent).toContain(
      'static let title: LocalizedStringResource = "Use Brian"',
    );
    expect(intent).toContain('Summary("Use Brian \\(\\.$request)")');
    expect(intent).toContain('shortTitle: "Use Brian"');
    expect(intent).not.toContain('LocalizedStringResource = "Ask Brian"');
    expect(intent).not.toContain('Summary("Ask Brian');
    expect(intent).not.toContain('shortTitle: "Ask Brian"');
    expect(intent).toContain('components.scheme = "usebrian"');
    expect(intent).toContain('components.host = "use"');
    expect(intent).toContain("prompt.utf16.count <= 8_000");
    expect(intent).toContain("NSWorkspace.shared.open(url)");
    expect(intent).toContain("func perform() async throws -> some IntentResult {");
    expect(intent).toContain("return .result()");
    expect(intent).not.toContain("ProvidesDialog");
    expect(intent).not.toContain("Opening Brian with your request.");
    expect(intent).toContain("struct AskBrianIntent: AppIntent");
    expect(intent).toContain("static var isDiscoverable: Bool { false }");
    expect(intent).toContain("try await openUseBrian(request)");
  });

  it("opens the bundled signed shortcut through a fixed trusted-renderer bridge", () => {
    const preload = read("../../src/preload.cjs");
    const main = read("../../src/main.ts");
    const builder = read("../../electron-builder.yml");
    const template = readFileSync(
      new URL("../../native/siri-companion/Use Brian.shortcut", import.meta.url),
    );

    expect(preload).toContain(
      'openSiriSetup: () => ipcRenderer.invoke("Use Brian:open-siri-setup")',
    );
    expect(preload).toContain('ipcRenderer.on("Use Brian:use-brian"');
    expect(preload).toContain("onUseBrian: (callback) =>");
    expect(preload).not.toContain('"Use Brian:ask-brian"');
    expect(main).toContain('ipcMain.handle("Use Brian:open-siri-setup"');
    expect(main).toContain('process.platform !== "darwin"');
    expect(main).toContain("event.sender.id !== mainWindow.webContents.id");
    expect(main).toContain("siriShortcutTemplatePath()");
    expect(main).toContain("shell.openPath(templatePath)");
    expect(main).not.toContain('shell.openExternal("shortcuts://create-shortcut")');
    expect(main).toContain('SIRI_SHORTCUT_TEMPLATE_NAME = "Use Brian.shortcut"');
    expect(builder).toContain("from: native/siri-companion/Use Brian.shortcut");
    expect(builder).toContain("to: siri/Use Brian.shortcut");
    expect(template.subarray(0, 4).toString("ascii")).toBe("AEA1");
  });
});
