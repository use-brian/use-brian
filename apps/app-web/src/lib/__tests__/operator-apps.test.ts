// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OPERATOR_APP,
  OPERATOR_APP_KEYS,
  customAppIdFromPathname,
  customAppPath,
  homeAppFromPathname,
  homeAppPath,
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

  it("keeps the app-bar order with Feed 4th, Browsers 5th, Chat 6th", () => {
    expect(OPERATOR_APP_KEYS).toEqual([
      "page",
      "tasks",
      "crm",
      "feed",
      "browsers",
      "chat",
    ]);
  });

  it("maps operator surfaces to their app and leaves the rest null", () => {
    expect(operatorAppFromSurface("p")).toBe("page");
    expect(operatorAppFromSurface("tasks")).toBe("tasks");
    expect(operatorAppFromSurface("feed")).toBe("feed");
    expect(operatorAppFromSurface("computer")).toBe("browsers");
    expect(operatorAppFromSurface("chat")).toBe("chat");
    expect(operatorAppFromSurface("brain")).toBeNull();
    expect(operatorAppFromSurface("studio")).toBeNull();
    expect(operatorAppFromSurface("workflow")).toBeNull();
    // Custom apps share the `apps` surface — identity is the id in the path,
    // not the segment, so the surface map deliberately says nothing.
    expect(operatorAppFromSurface("apps")).toBeNull();
    expect(operatorAppFromSurface(null)).toBeNull();
  });

  it("builds each app's route", () => {
    expect(operatorAppPath("w1", "page")).toBe("/w/w1/p");
    expect(operatorAppPath("w1", "tasks")).toBe("/w/w1/tasks");
    expect(operatorAppPath("w1", "feed")).toBe("/w/w1/feed");
    // Browsers reuses the existing /computer route family.
    expect(operatorAppPath("w1", "browsers")).toBe("/w/w1/computer");
    expect(operatorAppPath("w1", "chat")).toBe("/w/w1/chat");
  });

  it("routes custom apps onto the shared /apps surface", () => {
    expect(customAppPath("w1", "app-1")).toBe("/w/w1/apps/app-1");
    expect(homeAppPath("w1", "custom:app-1")).toBe("/w/w1/apps/app-1");
    expect(homeAppPath("w1", "chat")).toBe("/w/w1/chat");
  });

  it("reads the active custom app id off the path", () => {
    expect(customAppIdFromPathname("/w/w1/apps/app-1")).toBe("app-1");
    expect(customAppIdFromPathname("/w/w1/apps/app-1/deep")).toBe("app-1");
    expect(customAppIdFromPathname("/w/w1/chat")).toBeNull();
    expect(customAppIdFromPathname(null)).toBeNull();
    expect(homeAppFromPathname("apps", "/w/w1/apps/app-1")).toBe("custom:app-1");
    expect(homeAppFromPathname("chat", "/w/w1/chat")).toBe("chat");
    expect(homeAppFromPathname("brain", "/w/w1/brain")).toBeNull();
  });

  it("defaults to the config default (Page + Chat) when nothing is cached", () => {
    expect(readOperatorApp("w1")).toBe(DEFAULT_OPERATOR_APP);
    expect(homePath("w1")).toBe("/w/w1/p");
  });

  it("persists the selection per workspace (the sticky Home contract)", () => {
    writeOperatorApp("w1", "tasks");
    expect(readOperatorApp("w1", ["page", "tasks"])).toBe("tasks");
    expect(homePath("w1", ["page", "tasks"])).toBe("/w/w1/tasks");
    // Another workspace is unaffected.
    expect(readOperatorApp("w2", ["page", "tasks"])).toBe("page");
  });

  it("remembers a custom app as the sticky Home selection", () => {
    writeOperatorApp("w1", "custom:app-1");
    expect(readOperatorApp("w1", ["page", "custom:app-1"])).toBe("custom:app-1");
    expect(homePath("w1", ["page", "custom:app-1"])).toBe("/w/w1/apps/app-1");
  });

  it("falls back to the FIRST enabled entry, not a hard-coded Page (T12)", () => {
    // Feed cached, then an admin drops Feed from the workspace's strip.
    writeOperatorApp("w1", "feed");
    expect(readOperatorApp("w1", ["page", "tasks"])).toBe("page");
    expect(homePath("w1", ["page", "tasks"])).toBe("/w/w1/p");
    // Page itself may be deselected — Home must then resolve to whatever IS
    // enabled rather than sending the user to a hidden surface.
    expect(readOperatorApp("w1", ["chat", "tasks"])).toBe("chat");
    expect(homePath("w1", ["chat", "tasks"])).toBe("/w/w1/chat");
    // A removed custom app cannot keep winning Home either.
    writeOperatorApp("w2", "custom:gone");
    expect(homePath("w2", ["tasks"])).toBe("/w/w2/tasks");
    // Still resolves while enabled.
    expect(readOperatorApp("w1", OPERATOR_APP_KEYS)).toBe("feed");
  });

  it("ignores junk in the cache", () => {
    window.localStorage.setItem(operatorAppStorageKey("w1"), "nonsense");
    expect(readOperatorApp("w1", ["page", "chat"])).toBe("page");
  });
});
