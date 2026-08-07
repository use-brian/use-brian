/** Standalone Firefox companion command surface. [COMP:ext/firefox-companion] */
import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  discoverFirefoxRemoteEndpoint,
  findFirefoxExecutable,
  firefoxExecutableCandidates,
  firefoxProfilesRoots,
  launchFirefoxForControl,
  waitForFirefoxRemoteEndpoint,
  type FirefoxRemoteEndpoint,
} from "./firefox-launcher.js";
import { registerFirefoxNativeHost } from "./firefox-native-registration.js";

const HELP = `Use Brian Firefox companion

Usage:
  use-brian-firefox install   Register this executable with Firefox
  use-brian-firefox start     Start Firefox with local browser control enabled
  use-brian-firefox status    Check for a Firefox browser-control endpoint

Optional environment:
  USE_BRIAN_FIREFOX_PATH          Absolute path to the Firefox executable
  USE_BRIAN_FIREFOX_PROFILE_ROOT  Absolute path to the Firefox profiles root
`;

type RegisterInput = Parameters<typeof registerFirefoxNativeHost>[0];

export type CompanionCommandDeps = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  executablePath: string;
  writeOut: (text: string) => void;
  writeError: (text: string) => void;
  chmodFile: (path: string, mode: number) => Promise<void>;
  registerHost: (input: RegisterInput) => Promise<string | null>;
  findExecutable: (candidates: readonly string[]) => Promise<string | null>;
  discoverEndpoint: (roots: readonly string[]) => Promise<FirefoxRemoteEndpoint | null>;
  launchFirefox: (path: string) => void;
  waitForEndpoint: (
    roots: readonly string[],
    opts: { afterMs: number },
  ) => Promise<FirefoxRemoteEndpoint | null>;
  now: () => number;
};

export function companionProfilesRoots(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  const configured = env.USE_BRIAN_FIREFOX_PROFILE_ROOT?.trim();
  if (!configured) return firefoxProfilesRoots(platform, env, home);
  if (!isAbsolute(configured)) {
    throw new Error("USE_BRIAN_FIREFOX_PROFILE_ROOT must be an absolute path.");
  }
  return [configured];
}

export function companionExecutableCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  const configured = env.USE_BRIAN_FIREFOX_PATH?.trim();
  if (configured && !isAbsolute(configured)) {
    throw new Error("USE_BRIAN_FIREFOX_PATH must be an absolute path.");
  }
  return [
    ...(configured ? [configured] : []),
    ...firefoxExecutableCandidates(platform, env, home),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
}

function defaults(overrides: Partial<CompanionCommandDeps>): CompanionCommandDeps {
  const platform = overrides.platform ?? process.platform;
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? homedir();
  return {
    platform,
    env,
    home,
    executablePath: overrides.executablePath ?? resolve(process.argv[1] ?? ""),
    writeOut: overrides.writeOut ?? ((text) => process.stdout.write(text)),
    writeError: overrides.writeError ?? ((text) => process.stderr.write(text)),
    chmodFile: overrides.chmodFile ?? chmod,
    registerHost: overrides.registerHost ?? registerFirefoxNativeHost,
    findExecutable: overrides.findExecutable ?? findFirefoxExecutable,
    discoverEndpoint: overrides.discoverEndpoint ?? discoverFirefoxRemoteEndpoint,
    launchFirefox: overrides.launchFirefox ?? ((path) => { launchFirefoxForControl(path); }),
    waitForEndpoint: overrides.waitForEndpoint ?? waitForFirefoxRemoteEndpoint,
    now: overrides.now ?? Date.now,
  };
}

export async function runCompanionCommand(
  argv: readonly string[],
  overrides: Partial<CompanionCommandDeps> = {},
): Promise<number> {
  const deps = defaults(overrides);
  const command = argv[0] ?? "help";
  try {
    if (command === "help" || command === "--help" || command === "-h") {
      deps.writeOut(HELP);
      return 0;
    }
    if (command === "install") {
      if (deps.platform === "win32") {
        throw new Error("The standalone companion supports Linux and macOS. Use the desktop app on Windows.");
      }
      if (!deps.executablePath) throw new Error("Could not resolve the companion executable path.");
      await deps.chmodFile(deps.executablePath, 0o755);
      const manifestPath = await deps.registerHost({
        platform: deps.platform,
        home: deps.home,
        userData: join(deps.home, ".usebrian", "firefox-companion"),
        executablePath: deps.executablePath,
      });
      if (!manifestPath) throw new Error(`Firefox is not supported on ${deps.platform}.`);
      deps.writeOut(`Firefox companion registered at ${manifestPath}\n`);
      deps.writeOut("Quit Firefox completely, then run use-brian-firefox start.\n");
      return 0;
    }

    const roots = companionProfilesRoots(deps.platform, deps.env, deps.home);
    if (roots.length === 0) throw new Error(`Firefox is not supported on ${deps.platform}.`);
    if (command === "status") {
      const endpoint = await deps.discoverEndpoint(roots);
      if (!endpoint) {
        deps.writeOut("Firefox is not running with My Browser control enabled.\n");
        return 1;
      }
      deps.writeOut(`Firefox control endpoint found for ${endpoint.profileDir}.\n`);
      return 0;
    }
    if (command === "start") {
      const executable = await deps.findExecutable(
        companionExecutableCandidates(deps.platform, deps.env, deps.home),
      );
      if (!executable) throw new Error("Firefox was not found. Set USE_BRIAN_FIREFOX_PATH to its absolute path.");
      const startedAt = deps.now() - 1_000;
      deps.launchFirefox(executable);
      const endpoint = await deps.waitForEndpoint(roots, { afterMs: startedAt });
      if (!endpoint) {
        throw new Error(
          "Firefox control did not start. Quit every Firefox process, wait a moment, then run this command again.",
        );
      }
      deps.writeOut(`Firefox started for My Browser using ${endpoint.profileDir}.\n`);
      return 0;
    }
    deps.writeError(`Unknown command: ${command}\n\n${HELP}`);
    return 2;
  } catch (error) {
    deps.writeError(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
