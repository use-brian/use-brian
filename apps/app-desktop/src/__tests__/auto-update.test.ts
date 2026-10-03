import { describe, it, expect } from "vitest";

import {
  INITIAL_UPDATE_STATE,
  UPDATE_AUTO_INSTALL_IDLE_SECONDS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_INITIAL_CHECK_DELAY_MS,
  UPDATE_OPEN_CHECK_MIN_INTERVAL_MS,
  describeUpdateState,
  reduceUpdateState,
  rendererUpdateStatus,
  shouldAutoInstall,
  shouldCheckInState,
  shouldCheckOnOpen,
  shouldEnableAutoUpdate,
  type UpdateEvent,
  type UpdateState,
} from "../auto-update.js";

/** Fold a sequence of events from the initial state. */
function run(events: UpdateEvent[], from: UpdateState = INITIAL_UPDATE_STATE): UpdateState {
  return events.reduce(reduceUpdateState, from);
}

describe("[COMP:app-desktop/auto-update] Auto-update decision core", () => {
  describe("shouldEnableAutoUpdate", () => {
    it("enables on a packaged build with the flag on", () => {
      const gate = shouldEnableAutoUpdate({ isPackaged: true, autoUpdate: true });
      expect(gate.enabled).toBe(true);
    });

    it("disables on an unpackaged dev run (no app-update.yml feed)", () => {
      const gate = shouldEnableAutoUpdate({ isPackaged: false, autoUpdate: true });
      expect(gate.enabled).toBe(false);
      expect(gate.reason).toMatch(/unpackaged/i);
    });

    it("disables when the kill-switch is set, even packaged", () => {
      const gate = shouldEnableAutoUpdate({ isPackaged: true, autoUpdate: false });
      expect(gate.enabled).toBe(false);
      expect(gate.reason).toMatch(/USEBRIAN_DISABLE_AUTO_UPDATE/);
    });
  });

  describe("reduceUpdateState", () => {
    it("walks the happy path: idle → checking → downloading → ready", () => {
      expect(run([{ kind: "checking" }])).toEqual({ phase: "checking" });
      expect(run([{ kind: "checking" }, { kind: "available", version: "1.2.3" }])).toEqual({
        phase: "downloading",
        version: "1.2.3",
        percent: 0,
      });
      expect(
        run([
          { kind: "checking" },
          { kind: "available", version: "1.2.3" },
          { kind: "progress", percent: 41.7 },
        ]),
      ).toEqual({ phase: "downloading", version: "1.2.3", percent: 41.7 });
      expect(
        run([
          { kind: "checking" },
          { kind: "available", version: "1.2.3" },
          { kind: "downloaded", version: "1.2.3" },
        ]),
      ).toEqual({ phase: "ready", version: "1.2.3" });
    });

    it("returns to idle on a no-update result", () => {
      expect(run([{ kind: "checking" }, { kind: "not-available" }])).toEqual({ phase: "idle" });
    });

    it("moves to error with the message on a failed check", () => {
      expect(run([{ kind: "checking" }, { kind: "error", message: "net down" }])).toEqual({
        phase: "error",
        message: "net down",
      });
    });

    it("keeps ready sticky against later checks, no-update results, and errors", () => {
      const ready: UpdateState = { phase: "ready", version: "1.2.3" };
      // A later periodic check must not clobber the restart affordance: the
      // downloaded update is still on disk, installable.
      expect(reduceUpdateState(ready, { kind: "checking" })).toBe(ready);
      expect(reduceUpdateState(ready, { kind: "not-available" })).toBe(ready);
      expect(reduceUpdateState(ready, { kind: "error", message: "x" })).toBe(ready);
      expect(reduceUpdateState(ready, { kind: "progress", percent: 50 })).toBe(ready);
      // The same version becoming "available" again is a re-check echo, not news.
      expect(reduceUpdateState(ready, { kind: "available", version: "1.2.3" })).toBe(ready);
    });

    it("lets a newer download supersede a ready update", () => {
      const ready: UpdateState = { phase: "ready", version: "1.2.3" };
      expect(reduceUpdateState(ready, { kind: "available", version: "1.3.0" })).toEqual({
        phase: "downloading",
        version: "1.3.0",
        percent: 0,
      });
      expect(reduceUpdateState(ready, { kind: "downloaded", version: "1.3.0" })).toEqual({
        phase: "ready",
        version: "1.3.0",
      });
    });

    it("ignores a stray progress event outside a download", () => {
      expect(reduceUpdateState({ phase: "idle" }, { kind: "progress", percent: 10 })).toEqual({
        phase: "idle",
      });
      expect(reduceUpdateState({ phase: "checking" }, { kind: "progress", percent: 10 })).toEqual({
        phase: "checking",
      });
    });
  });

  describe("describeUpdateState", () => {
    it("offers a check from idle", () => {
      expect(describeUpdateState({ phase: "idle" })).toEqual({
        label: "Check for Updates…",
        enabled: true,
        action: "check",
      });
    });

    it("disables the item while checking", () => {
      expect(describeUpdateState({ phase: "checking" })).toEqual({
        label: "Checking for Updates…",
        enabled: false,
        action: "none",
      });
    });

    it("shows rounded download progress, disabled", () => {
      expect(describeUpdateState({ phase: "downloading", version: "1.2.3", percent: 41.7 })).toEqual(
        { label: "Downloading Update… 42%", enabled: false, action: "none" },
      );
    });

    it("offers restart with the version once downloaded", () => {
      expect(describeUpdateState({ phase: "ready", version: "1.2.3" })).toEqual({
        label: "Restart to Update (v1.2.3)",
        enabled: true,
        action: "restart",
      });
    });

    it("offers a retry check after an error", () => {
      expect(describeUpdateState({ phase: "error", message: "net down" })).toEqual({
        label: "Check for Updates…",
        enabled: true,
        action: "check",
      });
    });
  });

  describe("check cadence", () => {
    it("checks unless electron-updater is busy, including while an update is staged", () => {
      expect(shouldCheckInState({ phase: "idle" })).toBe(true);
      expect(shouldCheckInState({ phase: "error", message: "x" })).toBe(true);
      expect(shouldCheckInState({ phase: "ready", version: "1.2.3" })).toBe(true);
      expect(shouldCheckInState({ phase: "checking" })).toBe(false);
      expect(shouldCheckInState({ phase: "downloading", version: "1.2.3", percent: 5 })).toBe(false);
    });

    it("a newer release found while one is staged supersedes it (no restart into the stale one)", () => {
      const staged = run([{ kind: "available", version: "1.2.3" }, { kind: "downloaded", version: "1.2.3" }]);
      expect(shouldCheckInState(staged)).toBe(true);
      const after = [
        { kind: "checking" },
        { kind: "available", version: "1.2.4" },
      ].reduce<UpdateState>((s, e) => reduceUpdateState(s, e as UpdateEvent), staged);
      expect(after).toEqual({ phase: "downloading", version: "1.2.4", percent: 0 });
    });

    it("throttles app-open checks but always allows the first", () => {
      const idle: UpdateState = { phase: "idle" };
      expect(shouldCheckOnOpen(idle, null, 1_000)).toBe(true);
      expect(shouldCheckOnOpen(idle, 1_000, 1_000 + UPDATE_OPEN_CHECK_MIN_INTERVAL_MS - 1)).toBe(false);
      expect(shouldCheckOnOpen(idle, 1_000, 1_000 + UPDATE_OPEN_CHECK_MIN_INTERVAL_MS)).toBe(true);
      expect(shouldCheckOnOpen({ phase: "checking" }, null, 1_000)).toBe(false);
    });

    it("checks soon after launch and at least hourly", () => {
      expect(UPDATE_INITIAL_CHECK_DELAY_MS).toBeLessThanOrEqual(15_000);
      expect(UPDATE_CHECK_INTERVAL_MS).toBeLessThanOrEqual(60 * 60 * 1000);
    });
  });

  describe("renderer status", () => {
    it("surfaces downloading and ready only", () => {
      expect(rendererUpdateStatus({ phase: "idle" })).toBeNull();
      expect(rendererUpdateStatus({ phase: "checking" })).toBeNull();
      expect(rendererUpdateStatus({ phase: "error", message: "x" })).toBeNull();
      expect(rendererUpdateStatus({ phase: "downloading", version: "1.2.3", percent: 41.6 })).toEqual({
        phase: "downloading",
        version: "1.2.3",
        percent: 42,
      });
      expect(rendererUpdateStatus({ phase: "ready", version: "1.2.3" })).toEqual({ phase: "ready", version: "1.2.3" });
    });
  });

  describe("auto-install", () => {
    const ready: UpdateState = { phase: "ready", version: "1.2.3" };
    const away = { windowVisible: false, recording: false, systemIdleSeconds: UPDATE_AUTO_INSTALL_IDLE_SECONDS };

    it("installs a staged update only when nobody is using the app", () => {
      expect(shouldAutoInstall({ state: ready, ...away })).toBe(true);
      expect(shouldAutoInstall({ state: ready, ...away, windowVisible: true })).toBe(false);
      expect(shouldAutoInstall({ state: ready, ...away, recording: true })).toBe(false);
      expect(shouldAutoInstall({ state: ready, ...away, systemIdleSeconds: UPDATE_AUTO_INSTALL_IDLE_SECONDS - 1 })).toBe(false);
    });

    it("never installs without a staged update", () => {
      expect(shouldAutoInstall({ state: { phase: "idle" }, ...away })).toBe(false);
      expect(shouldAutoInstall({ state: { phase: "downloading", version: "1.2.3", percent: 90 }, ...away })).toBe(false);
    });
  });
});
