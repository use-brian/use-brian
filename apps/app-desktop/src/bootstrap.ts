/** Select Firefox native-host mode before Electron GUI code is imported. */
import { spawn } from "node:child_process";
import { homedir, release } from "node:os";
import { screenCaptureDisabledFeatures } from "./system-audio-policy.js";
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
    openControl: () => {
      const child = spawn(process.execPath, ["usebrian://firefox-control"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    },
  }).catch((error) => {
    process.stderr.write(`Use Brian Firefox companion failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  // Await startup imports so Electron cannot become ready before its bounded
  // screen-backend compatibility switch is set. Native-host mode stays headless.
  const { app } = await import("electron");
  const features = screenCaptureDisabledFeatures(process.platform, release(), process.versions.electron);
  if (features.length > 0) {
    const existing = app.commandLine.getSwitchValue("disable-features").split(",").filter(Boolean);
    app.commandLine.appendSwitch("disable-features", [...new Set([...existing, ...features])].join(","));
  }
  await import("./main.js");
}
