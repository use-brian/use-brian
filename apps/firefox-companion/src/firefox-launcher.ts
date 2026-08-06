/** Firefox Remote Agent launch/discovery planning. [COMP:ext/firefox-companion] */
import { access, readdir, readFile, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
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
  if (platform === "linux") {
    return [
      ...(env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, "firefox")),
      "/run/current-system/sw/bin/firefox",
      join(home, ".nix-profile", "bin", "firefox"),
      "/usr/bin/firefox",
      "/usr/local/bin/firefox",
    ].filter((candidate, index, all) => all.indexOf(candidate) === index);
  }
  return [];
}

export function firefoxProfilesRoots(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  const configured = env.USE_BRIAN_FIREFOX_PROFILE_ROOT?.trim();
  if (configured) return isAbsolute(configured) ? [configured] : [];
  if (platform === "darwin") return [join(home, "Library", "Application Support", "Firefox", "Profiles")];
  if (platform === "win32" && env.APPDATA) return [join(env.APPDATA, "Mozilla", "Firefox", "Profiles")];
  if (platform === "linux") {
    const xdgConfigHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : join(home, ".config");
    return [
      ...(env.MOZ_APP_DATA && isAbsolute(env.MOZ_APP_DATA) ? [env.MOZ_APP_DATA] : []),
      join(home, ".mozilla", "firefox"),
      join(xdgConfigHome, "mozilla", "firefox"),
    ].filter((root, index, all) => all.indexOf(root) === index);
  }
  return [];
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
    const wsHost = value.ws_host === "[::1]" ? "::1" : value.ws_host;
    if (!["127.0.0.1", "localhost", "::1"].includes(wsHost)) return null;
    return { wsHost, wsPort: value.ws_port, profileDir, modifiedAtMs };
  } catch {
    return null;
  }
}

async function firefoxProfileDirectories(profilesRoot: string): Promise<string[]> {
  const directories: string[] = [];
  try {
    directories.push(...(await readdir(profilesRoot)).map((entry) => join(profilesRoot, entry)));
  } catch {
    // profiles.ini can still point entirely outside the conventional root.
  }

  for (const iniPath of [join(profilesRoot, "profiles.ini"), join(profilesRoot, "..", "profiles.ini")]) {
    let raw: string;
    try {
      raw = await readFile(iniPath, "utf8");
    } catch {
      continue;
    }
    for (const section of raw.split(/^\s*\[/m).slice(1)) {
      if (!/^Profile\d+\]/.test(section)) continue;
      const path = /^Path=(.+)$/m.exec(section)?.[1]?.trim();
      if (!path) continue;
      const isRelative = /^IsRelative=1\s*$/m.test(section);
      directories.push(isRelative && !isAbsolute(path) ? resolve(dirname(iniPath), path) : path);
    }
  }

  return directories.filter((directory, index, all) => all.indexOf(directory) === index);
}

export async function discoverFirefoxRemoteEndpoint(
  profilesRoots: readonly string[],
): Promise<FirefoxRemoteEndpoint | null> {
  const profileDirectories = (
    await Promise.all(profilesRoots.map((profilesRoot) => firefoxProfileDirectories(profilesRoot)))
  ).flat();
  const candidates = await Promise.all(
    profileDirectories.map(async (profileDir) => {
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
  const child = spawnProcess(executablePath, ["--new-instance", "--remote-debugging-port=0"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

export async function waitForFirefoxRemoteEndpoint(
  profilesRoots: readonly string[],
  opts: { afterMs: number; timeoutMs?: number; pollMs?: number } = { afterMs: 0 },
): Promise<FirefoxRemoteEndpoint | null> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  do {
    const endpoint = await discoverFirefoxRemoteEndpoint(profilesRoots);
    if (endpoint && endpoint.modifiedAtMs >= opts.afterMs) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  return null;
}
