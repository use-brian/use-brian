import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

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

describe("macOS native fixture signing hooks (mocked tools, not native signing)", () => {
  it("discovers the identity before signing the adjacent fixture and preserves extension signing", async () => {
    const execFileSync = vi.fn((tool: string, _args: string[], _options: unknown) => tool === "/usr/bin/security"
      ? "1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 Developer ID Application: Test" : "");
    const hardenMacBootstrap = vi.fn(async () => {});
    vi.doMock("../../scripts/electron-fuses.mjs", () => ({ hardenMacBootstrap }));
    vi.doMock("node:child_process", () => ({ execFileSync }));
    for (const key of ["CSC_NAME", "CSC_LINK", "CSC_KEYCHAIN"]) vi.stubEnv(key, "");
    try {
      const { default: sign } = await import(new URL("../../scripts/sign-siri-extension.mjs", import.meta.url).href);
      await sign({ electronPlatformName: "darwin", appOutDir: "/output", packager: {
        appInfo: { productFilename: "Use Brian" },
        codeSigningInfo: { value: Promise.resolve({ keychainFile: "/temporary/keychain" }) },
      } });
      expect(hardenMacBootstrap).toHaveBeenCalledOnce();
      expect(hardenMacBootstrap.mock.invocationCallOrder[0]).toBeLessThan(execFileSync.mock.invocationCallOrder[0]);
      expect(execFileSync.mock.calls[0]?.[0]).toBe("/usr/bin/security");
      const calls = execFileSync.mock.calls;
      const fixture = "/output/Use Brian.app/Contents/Resources/computer-control/NativeComputerFixture.app";
      const signed = calls.find(([, args]) => args.includes("--sign") && args.at(-1) === fixture)?.[1];
      expect(signed).toEqual(["--force", "--sign", "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
        "--timestamp", "--options", "runtime", "--keychain", "/temporary/keychain", fixture]);
      expect(calls.some(([, args]) => args.includes("--sign") && args.at(-1)?.endsWith("Brian Siri.appex"))).toBe(true);
    } finally { vi.doUnmock("node:child_process"); vi.doUnmock("../../scripts/electron-fuses.mjs"); vi.unstubAllEnvs(); vi.resetModules(); }
  });

  it("verifies helper and fixture with the release parent team; missing team fails closed", async () => {
    const execFileSync = vi.fn((_tool: string, _args: string[], _options: unknown) => "");
    let helperXML = '<plist version="1.0"><dict/></plist>';
    const spawnSync = vi.fn((_tool: string, args: string[]) => ({ status: 0,
      stdout: args.at(-1)?.endsWith("brian-native-computer-helper") ? helperXML : "",
      stderr: args.includes("--verbose=4") ? "TeamIdentifier=ABCDE12345" : "com.apple.security.app-sandbox" }));
    const verifyMacBootstrap = vi.fn(async (_app: string) => {});
    const verifyPackagedNativeBootstrap = vi.fn(async () => {});
    vi.doMock("../../scripts/mac-release-bootstrap.mjs", () => ({ verifyPackagedNativeBootstrap }));
    vi.doMock("../../scripts/electron-fuses.mjs", () => ({ verifyMacBootstrap }));
    vi.doMock("node:child_process", () => ({ execFileSync, spawnSync }));
    try {
      const { default: verify } = await import(new URL("../../scripts/verify-siri-extension.mjs", import.meta.url).href);
      const context = { electronPlatformName: "darwin", appOutDir: "/output", packager: {
        appInfo: { productFilename: "Use Brian" }, platformSpecificBuildOptions: { identity: "Developer ID Application: Test" },
      } };
      await verify(context);
      expect(verifyMacBootstrap).toHaveBeenCalledWith("/output/Use Brian.app");
      expect(verifyPackagedNativeBootstrap).toHaveBeenCalledWith("/output/Use Brian.app", "ABCDE12345");
      expect(verifyMacBootstrap.mock.invocationCallOrder[0]).toBeLessThan(execFileSync.mock.invocationCallOrder[0]);
      const checks = execFileSync.mock.calls.filter(([, args]) => args.includes("-R"));
      expect(checks).toHaveLength(4);
      for (const [, args] of checks) {
        const requirement = args[args.indexOf("-R") + 1];
        expect(requirement).toContain('certificate leaf[subject.OU] = "ABCDE12345"');
        expect(requirement).toContain('certificate 1[field.1.2.840.113635.100.6.2.6] exists');
        expect(requirement).toContain('certificate leaf[field.1.2.840.113635.100.6.1.13] exists');
      }
      for (const xml of [
        '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>',
        '<plist><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>',
        '<plist><dict><key>unknown</key><false/></dict></plist>',
        '<plist><array/></plist>', '<plist><date>2026-01-01T00:00:00Z</date></plist>',
      ]) {
        helperXML = xml;
        await expect(verify(context)).rejects.toThrow('empty entitlement profile');
      }
      helperXML = '';
      await expect(verify(context)).rejects.toThrow('Could not verify native helper entitlements');
      helperXML = '<plist version="1.0"><dict/></plist>';
      expect(checks[0][1].join(" ")).toContain('identifier "ai.usebrian.desktop"');
      expect(checks[2][1].join(" ")).toContain('identifier "com.usebrian.NativeComputerFixture"');
      expect(checks[3][1].at(-1)).toBe("/output/Use Brian.app/Contents/Frameworks/Electron Framework.framework");
      expect(checks[3][1]).toContain("--all-architectures");
      // The normal default-keychain identity path has no CSC_* configuration.
      // Its developer-signed artifact must never enter the local ad-hoc branch.
      for (const key of ['CSC_LINK', 'CSC_NAME', 'CSC_KEYCHAIN']) vi.stubEnv(key, '');
      execFileSync.mockClear();
      await verify({ ...context, packager: { ...context.packager, platformSpecificBuildOptions: {} } });
      expect(execFileSync.mock.calls.some(([, args]) => args.includes('--sign'))).toBe(false);
      expect(execFileSync.mock.calls.filter(([, args]) => args.includes('-R'))).toHaveLength(4);
      execFileSync.mockImplementation((_tool, args) => {
        if (args.includes("--verify") && args.at(-1)?.endsWith("Electron Framework.framework")) throw new Error("framework invalid seal");
        return "";
      });
      await expect(verify(context)).rejects.toThrow("framework invalid seal");
      execFileSync.mockImplementation((_tool, args) => {
        if (args.includes("-R") && args.at(-1)?.endsWith("NativeComputerFixture.app")) throw new Error("fixture wrong team or signature");
        return "";
      });
      await expect(verify(context)).rejects.toThrow("fixture wrong team or signature");
      execFileSync.mockImplementation((_tool, args) => {
        if (args.includes("--verify") && args.at(-1)?.endsWith("NativeComputerFixture.app")) throw new Error("fixture missing or invalid seal");
        return "";
      });
      await expect(verify(context)).rejects.toThrow("fixture missing or invalid seal");
      execFileSync.mockReturnValue("");
      spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "TeamIdentifier=not set" });
      await expect(verify(context)).rejects.toThrow("non-ad-hoc signing team");
      execFileSync.mockClear();
      verifyMacBootstrap.mockRejectedValue(new Error("unsafe fuse"));
      await expect(verify(context)).rejects.toThrow("unsafe fuse");
      expect(execFileSync).not.toHaveBeenCalled();
    } finally { vi.doUnmock("node:child_process"); vi.doUnmock("../../scripts/electron-fuses.mjs"); vi.doUnmock("../../scripts/mac-release-bootstrap.mjs"); vi.unstubAllEnvs(); vi.resetModules(); }
  });
});


it("afterPack refuses fuse failures before signing and skips unsupported platforms", async () => {
  const hardenMacBootstrap = vi.fn(async () => { throw new Error("unknown fuse"); });
  const execFileSync = vi.fn();
  vi.doMock("../../scripts/electron-fuses.mjs", () => ({ hardenMacBootstrap }));
  vi.doMock("node:child_process", () => ({ execFileSync }));
  try {
    const { default: sign } = await import(new URL("../../scripts/sign-siri-extension.mjs", import.meta.url).href);
    await sign({ electronPlatformName: "linux" });
    await sign({ electronPlatformName: "win32" });
    expect(hardenMacBootstrap).not.toHaveBeenCalled();
    await expect(sign({ electronPlatformName: "darwin" })).rejects.toThrow("unknown fuse");
    expect(execFileSync).not.toHaveBeenCalled();
  } finally { vi.doUnmock("node:child_process"); vi.doUnmock("../../scripts/electron-fuses.mjs"); vi.resetModules(); }
});
