/** Firefox Remote Agent launch/discovery planning. [COMP:app-desktop/firefox-native-host] */
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type FirefoxRemoteEndpoint = {
  wsHost: string;
  wsPort: number;
  profileDir: string;
  modifiedAtMs: number;
};

export function firefoxExecutableCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Firefox.app/Contents/MacOS/firefox",
      join(home, "Applications", "Firefox.app", "Contents", "MacOS", "firefox"),
    ];
  }
  if (platform === "win32") {
    return [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]
      .filter((root): root is string => Boolean(root))
      .map((root) => join(root, "Mozilla Firefox", "firefox.exe"));
  }
  if (platform === "linux") return ["/usr/bin/firefox", "/usr/local/bin/firefox"];
  return [];
}

export function firefoxProfilesRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string | null {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Firefox", "Profiles");
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "Mozilla", "Firefox", "Profiles");
  if (platform === "linux") return join(home, ".mozilla", "firefox");
  return null;
}

export async function findFirefoxExecutable(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard install location.
    }
  }
  return null;
}

function parseEndpoint(raw: string, profileDir: string, modifiedAtMs: number): FirefoxRemoteEndpoint | null {
  try {
    const value = JSON.parse(raw) as { ws_host?: unknown; ws_port?: unknown };
    if (typeof value.ws_host !== "string" || typeof value.ws_port !== "number") return null;
    if (!Number.isInteger(value.ws_port) || value.ws_port < 1 || value.ws_port > 65_535) return null;
    if (!["127.0.0.1", "localhost", "::1"].includes(value.ws_host)) return null;
    return { wsHost: value.ws_host, wsPort: value.ws_port, profileDir, modifiedAtMs };
  } catch {
    return null;
  }
}

export async function discoverFirefoxRemoteEndpoint(profilesRoot: string): Promise<FirefoxRemoteEndpoint | null> {
  let entries: string[];
  try {
    entries = await readdir(profilesRoot);
  } catch {
    return null;
  }
  const candidates = await Promise.all(
    entries.map(async (entry) => {
      const profileDir = join(profilesRoot, entry);
      const endpointFile = join(profileDir, "WebDriverBiDiServer.json");
      try {
        const [raw, info] = await Promise.all([readFile(endpointFile, "utf8"), stat(endpointFile)]);
        return parseEndpoint(raw, profileDir, info.mtimeMs);
      } catch {
        return null;
      }
    }),
  );
  return candidates
    .filter((candidate): candidate is FirefoxRemoteEndpoint => candidate !== null)
    .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)[0] ?? null;
}

export function launchFirefoxForControl(
  executablePath: string,
  spawnProcess: typeof spawn = spawn,
): ChildProcess {
  const child = spawnProcess(executablePath, ["--remote-debugging-port=0"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

export async function waitForFirefoxRemoteEndpoint(
  profilesRoot: string,
  opts: { afterMs: number; timeoutMs?: number; pollMs?: number } = { afterMs: 0 },
): Promise<FirefoxRemoteEndpoint | null> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  do {
    const endpoint = await discoverFirefoxRemoteEndpoint(profilesRoot);
    if (endpoint && endpoint.modifiedAtMs >= opts.afterMs) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  return null;
}
