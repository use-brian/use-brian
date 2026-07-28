/**
 * Firefox native-host registration for the packaged desktop executable.
 * [COMP:app-desktop/firefox-native-host]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";

export const FIREFOX_NATIVE_HOST_NAME = "ai.usebrian.browser";
export const FIREFOX_EXTENSION_ID = "browser@usebrian.ai";
export const FIREFOX_NATIVE_HOST_REGISTRY_KEY =
  `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${FIREFOX_NATIVE_HOST_NAME}`;

export type FirefoxNativeHostManifest = {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_extensions: string[];
};

export function buildFirefoxNativeHostManifest(executablePath: string): FirefoxNativeHostManifest {
  return {
    name: FIREFOX_NATIVE_HOST_NAME,
    description: "Use Brian Firefox browser-control companion",
    path: executablePath,
    type: "stdio",
    allowed_extensions: [FIREFOX_EXTENSION_ID],
  };
}

export function firefoxNativeHostManifestPath(opts: {
  platform: NodeJS.Platform;
  home: string;
  userData: string;
}): string | null {
  if (opts.platform === "darwin") {
    return join(
      opts.home,
      "Library",
      "Application Support",
      "Mozilla",
      "NativeMessagingHosts",
      `${FIREFOX_NATIVE_HOST_NAME}.json`,
    );
  }
  if (opts.platform === "win32") {
    return join(opts.userData, "native-messaging", `${FIREFOX_NATIVE_HOST_NAME}.json`);
  }
  if (opts.platform === "linux") {
    return join(opts.home, ".mozilla", "native-messaging-hosts", `${FIREFOX_NATIVE_HOST_NAME}.json`);
  }
  return null;
}

export function isFirefoxNativeHostArgv(argv: readonly string[]): boolean {
  return argv.some(
    (arg) =>
      arg === FIREFOX_EXTENSION_ID ||
      arg.startsWith("moz-extension://") ||
      arg.endsWith(`/${FIREFOX_NATIVE_HOST_NAME}.json`) ||
      arg.endsWith(`\\${FIREFOX_NATIVE_HOST_NAME}.json`),
  );
}

type RegisterOptions = {
  platform: NodeJS.Platform;
  home: string;
  userData: string;
  executablePath: string;
  execFile?: typeof execFile;
};

export async function registerFirefoxNativeHost(opts: RegisterOptions): Promise<string | null> {
  const manifestPath = firefoxNativeHostManifestPath(opts);
  if (!manifestPath) return null;
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(buildFirefoxNativeHostManifest(opts.executablePath), null, 2)}\n`,
    { mode: 0o600 },
  );
  if (opts.platform === "win32") {
    const run = opts.execFile ?? execFile;
    await new Promise<void>((resolve, reject) => {
      run(
        "reg.exe",
        ["ADD", FIREFOX_NATIVE_HOST_REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"],
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }
  return manifestPath;
}
