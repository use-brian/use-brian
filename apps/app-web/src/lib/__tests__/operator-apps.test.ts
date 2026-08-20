// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_HOME_APP_KEYS } from "@use-brian/shared/home-apps";
import {
  DEFAULT_OPERATOR_APP,
  OPERATOR_APP_KEYS,
  customAppIdFromPathname,
  customAppPath,
  homeAppFromPathname,
  homeAppBasePath,
  homeAppLocationStorageKey,
  homeAppPath,
  homePath,
  operatorAppFromSurface,
  operatorAppPath,
  operatorAppStorageKey,
  readOperatorApp,
  readHomeAppLocation,
  reorderHomeApps,
  writeOperatorApp,
  writeHomeAppLocation,
} from "../operator-apps";

describe("[COMP:app-web/operator-app-bar] operator app registry", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("is the shared vocabulary, not a copy of it", () => {
    // This used to restate the seven keys, which made it a fourth copy of a
    // list the shared package already owns — and the copy in
    // `operator-apps.ts` had to be edited by hand for every new app, with
    // nothing failing when someone forgot. `OPERATOR_APP_KEYS` is now derived,
    // so the property worth pinning is the derivation itself.
    expect(OPERATOR_APP_KEYS).toBe(BUILTIN_HOME_APP_KEYS);
  });

  it("still starts at Page and keeps Office beside it", () => {
    // The order seeds the default strip and groups Studio's "Hidden" list, so
    // the front of it is a product decision worth holding.
    expect(OPERATOR_APP_KEYS[0]).toBe("page");
    expect(OPERATOR_APP_KEYS[1]).toBe("office");
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

  it("resumes each app's last safe pathname without carrying a query", () => {
    writeHomeAppLocation("w1", "page", "/w/w1/p/page-7");
    writeHomeAppLocation("w1", "feed", "/w/w1/feed/posts?status=draft");

    expect(readHomeAppLocation("w1", "page")).toBe("/w/w1/p/page-7");
    expect(homeAppPath("w1", "page")).toBe("/w/w1/p/page-7");
    // Callers pass `usePathname()`, so a full URL/query is rejected rather than
    // persisted and replayed later.
    expect(readHomeAppLocation("w1", "feed")).toBeNull();
    expect(homeAppPath("w1", "feed")).toBe("/w/w1/feed");
  });

  it("does not let Page's bare shell overwrite a remembered document", () => {
    writeHomeAppLocation("w1", "page", "/w/w1/p/page-7");
    writeHomeAppLocation("w1", "page", "/w/w1/p");
    expect(homeAppPath("w1", "page")).toBe("/w/w1/p/page-7");
  });

  it("rejects cross-workspace and cross-app cached paths", () => {
    window.localStorage.setItem(
      homeAppLocationStorageKey("w1", "tasks"),
      "/w/w2/tasks",
    );
    expect(readHomeAppLocation("w1", "tasks")).toBeNull();
    expect(homeAppPath("w1", "tasks")).toBe(
      homeAppBasePath("w1", "tasks"),
    );
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

describe("[COMP:app-web/operator-app-bar] reorderHomeApps", () => {
  it("moves an entry down into the target's slot", () => {
    expect(reorderHomeApps(["page", "tasks", "crm", "chat"], "page", "crm")).toEqual([
      "tasks",
      "crm",
      "page",
      "chat",
    ]);
  });

  it("moves an entry up into the target's slot", () => {
    expect(reorderHomeApps(["page", "tasks", "crm", "chat"], "chat", "tasks")).toEqual([
      "page",
      "chat",
      "tasks",
      "crm",
    ]);
  });

  it("is a permutation: never drops, duplicates, or invents an entry", () => {
    const before = ["page", "tasks", "crm", "feed", "browsers", "chat"] as const;
    const after = reorderHomeApps(before, "browsers", "page");
    expect(after).toHaveLength(before.length);
    expect([...after].sort()).toEqual([...before].sort());
    expect(after[0]).toBe("browsers");
  });

  it("carries a custom app through a reorder of the built-ins around it", () => {
    expect(reorderHomeApps(["page", "custom:app-1", "chat"], "chat", "page")).toEqual([
      "chat",
      "page",
      "custom:app-1",
    ]);
  });

  it("returns a copy unchanged when either end is absent or identical", () => {
    const before: readonly ("page" | "tasks")[] = ["page", "tasks"];
    // A stale drag id must not drop or duplicate an app.
    expect(reorderHomeApps(before, "crm", "page")).toEqual(["page", "tasks"]);
    expect(reorderHomeApps(before, "page", "crm")).toEqual(["page", "tasks"]);
    expect(reorderHomeApps(before, "page", "page")).toEqual(["page", "tasks"]);
    // Copy, not the same reference — callers persist the result.
    expect(reorderHomeApps(before, "page", "page")).not.toBe(before);
  });

  it("survives the API round trip: any permutation is a valid strip", () => {
    // `validateHomeApps` (the write side) rejects duplicates and unknown keys
    // but not order, which is what makes user-defined ordering a client-only
    // change. Guard the property the page relies on.
    const reordered = reorderHomeApps(OPERATOR_APP_KEYS, "chat", "page");
    expect(new Set(reordered).size).toBe(OPERATOR_APP_KEYS.length);
    expect(homePath("w-order", reordered)).toBe("/w/w-order/chat");
  });
});
