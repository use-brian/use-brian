/** Select Firefox native-host mode before Electron GUI code is imported. */
import { homedir } from "node:os";
import { isFirefoxNativeHostArgv } from "./firefox-native-registration.js";
import { runFirefoxNativeHost } from "./firefox-native-host.js";

if (isFirefoxNativeHostArgv(process.argv)) {
  void runFirefoxNativeHost({
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    platform: process.platform,
    env: process.env,
    home: homedir(),
  }).catch((error) => {
    process.stderr.write(`Use Brian Firefox companion failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  void import("./main.js");
}
