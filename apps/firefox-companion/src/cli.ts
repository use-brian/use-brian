#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";
import { runCompanionCommand } from "./commands.js";
import { runFirefoxNativeHost } from "./firefox-native-host.js";
import { isFirefoxNativeHostArgv } from "./firefox-native-registration.js";

async function main(): Promise<void> {
  if (isFirefoxNativeHostArgv(process.argv)) {
    await runFirefoxNativeHost({
      input: process.stdin,
      output: process.stdout,
      error: process.stderr,
      platform: process.platform,
      env: process.env,
      home: homedir(),
    });
    return;
  }
  process.exitCode = await runCompanionCommand(process.argv.slice(2), {
    home: homedir(),
    executablePath: resolve(process.argv[1] ?? ""),
  });
}

void main().catch((error) => {
  process.stderr.write(`Use Brian Firefox companion failed: ${String(error)}\n`);
  process.exitCode = 1;
});
