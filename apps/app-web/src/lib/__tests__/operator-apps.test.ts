// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OPERATOR_APP,
  OPERATOR_APP_KEYS,
  homePath,
  operatorAppFromSurface,
  operatorAppPath,
  operatorAppStorageKey,
  readOperatorApp,
  writeOperatorApp,
} from "../operator-apps";

describe("[COMP:app-web/operator-app-bar] operator app registry", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("maps operator surfaces to their app and leaves the rest null", () => {
    expect(operatorAppFromSurface("p")).toBe("page");
    expect(operatorAppFromSurface("tasks")).toBe("tasks");
    expect(operatorAppFromSurface("feed")).toBe("feed");
    expect(operatorAppFromSurface("brain")).toBeNull();
    expect(operatorAppFromSurface("studio")).toBeNull();
    expect(operatorAppFromSurface("workflow")).toBeNull();
    expect(operatorAppFromSurface(null)).toBeNull();
  });

  it("builds each app's route", () => {
    expect(operatorAppPath("w1", "page")).toBe("/w/w1/p");
    expect(operatorAppPath("w1", "tasks")).toBe("/w/w1/tasks");
    expect(operatorAppPath("w1", "feed")).toBe("/w/w1/feed");
  });

  it("defaults to Page when nothing is cached", () => {
    expect(readOperatorApp("w1")).toBe(DEFAULT_OPERATOR_APP);
    expect(homePath("w1")).toBe("/w/w1/p");
  });

  it("persists the selection per workspace (the sticky Home contract)", () => {
    writeOperatorApp("w1", "tasks");
    expect(readOperatorApp("w1")).toBe("tasks");
    expect(homePath("w1")).toBe("/w/w1/tasks");
    // Another workspace is unaffected.
    expect(readOperatorApp("w2")).toBe("page");
  });

  it("falls back to the default when the cached app is not enabled", () => {
    // Feed cached, then distribution profiles disconnect → feed disabled.
    writeOperatorApp("w1", "feed");
    expect(readOperatorApp("w1", ["page", "tasks"])).toBe("page");
    expect(homePath("w1", ["page", "tasks"])).toBe("/w/w1/p");
    // Still resolves while enabled.
    expect(readOperatorApp("w1", OPERATOR_APP_KEYS)).toBe("feed");
  });

  it("ignores junk in the cache", () => {
    window.localStorage.setItem(operatorAppStorageKey("w1"), "nonsense");
    expect(readOperatorApp("w1")).toBe("page");
  });
});
