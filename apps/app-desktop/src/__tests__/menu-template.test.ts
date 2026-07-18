import { describe, it, expect, vi } from "vitest";

import {
  buildMenuTemplate,
  type MenuTemplateHandlers,
  type MenuTemplateOptions,
} from "../menu-template.js";

const handlers: MenuTemplateHandlers = {
  onQuickCapture: () => {},
  onSignIn: () => {},
  onSignOut: () => {},
  onUpdate: () => {},
  onSwitchTarget: () => {},
  onUninstall: () => {},
};

/** Default options; spread + override per test. */
function opts(over: Partial<MenuTemplateOptions> = {}): MenuTemplateOptions {
  return { isMac: true, isDev: false, appName: "Use Brian", update: null, ...over };
}

/** Collect every `role` string in a template tree (top level + one submenu deep). */
function roles(template: ReturnType<typeof buildMenuTemplate>): string[] {
  const out: string[] = [];
  for (const item of template) {
    if (item.role) out.push(item.role);
    const sub = item.submenu;
    if (Array.isArray(sub)) for (const s of sub) if (s.role) out.push(s.role);
  }
  return out;
}

/** Flatten one submenu level into a single item list. */
function allItems(template: ReturnType<typeof buildMenuTemplate>) {
  return template.flatMap((m) => (Array.isArray(m.submenu) ? m.submenu : []));
}

/** MacOS-only roles that must never leak onto a Windows/Linux menu. */
const MAC_ONLY_ROLES = ["hide", "hideOthers", "unhide", "about", "zoom", "front"];

describe("[COMP:app-desktop/menu-template] buildMenuTemplate", () => {
  it("macOS: first menu is the app name and carries the macOS-only roles", () => {
    const t = buildMenuTemplate(opts(), handlers);
    expect(t[0].label).toBe("Use Brian");
    const r = roles(t);
    expect(r).toContain("hide");
    expect(r).toContain("about");
    expect(r).toContain("quit");
  });

  it("Windows: first menu is File and omits every macOS-only role", () => {
    const t = buildMenuTemplate(opts({ isMac: false }), handlers);
    expect(t[0].label).toBe("File");
    const r = roles(t);
    for (const macOnly of MAC_ONLY_ROLES) expect(r).not.toContain(macOnly);
    expect(r).toContain("quit"); // Electron renders the "quit" role as "Exit" on Windows
  });

  it("exposes Quick Capture on the cross-platform CommandOrControl accelerator", () => {
    for (const isMac of [true, false]) {
      const t = buildMenuTemplate(opts({ isMac }), handlers);
      const capture = allItems(t).find((i) => i.label === "Quick Capture");
      expect(capture?.accelerator).toBe("CommandOrControl+Shift+Space");
    }
  });

  it("offers View-menu zoom on both platforms, with a hidden Cmd/Ctrl+= zoom-in alias", () => {
    for (const isMac of [true, false]) {
      const t = buildMenuTemplate(opts({ isMac }), handlers);
      const r = roles(t);
      expect(r).toContain("resetZoom");
      expect(r).toContain("zoomIn");
      expect(r).toContain("zoomOut");
      const alias = allItems(t).find((i) => i.accelerator === "CommandOrControl+=");
      expect(alias?.role).toBe("zoomIn");
      expect(alias?.visible).toBe(false);
    }
  });

  it("includes DevTools only in dev", () => {
    const prod = buildMenuTemplate(opts(), handlers);
    const dev = buildMenuTemplate(opts({ isDev: true }), handlers);
    expect(roles(prod)).not.toContain("toggleDevTools");
    expect(roles(dev)).toContain("toggleDevTools");
  });

  it("omits the update item entirely when update is null (auto-update disabled)", () => {
    for (const isMac of [true, false]) {
      const t = buildMenuTemplate(opts({ isMac }), handlers);
      expect(allItems(t).find((i) => i.label === "Check for Updates…")).toBeUndefined();
    }
  });

  it("macOS: places the update item in the app menu right after About", () => {
    const t = buildMenuTemplate(
      opts({ update: { label: "Check for Updates…", enabled: true } }),
      handlers,
    );
    const appMenu = t[0].submenu;
    if (!Array.isArray(appMenu)) throw new Error("expected an app submenu array");
    expect(appMenu[0]?.role).toBe("about");
    expect(appMenu[1]?.label).toBe("Check for Updates…");
  });

  it("Windows: places the update item in the File menu before Exit", () => {
    const t = buildMenuTemplate(
      opts({ isMac: false, update: { label: "Check for Updates…", enabled: true } }),
      handlers,
    );
    const file = t[0].submenu;
    if (!Array.isArray(file)) throw new Error("expected a File submenu array");
    const updateIdx = file.findIndex((i) => i.label === "Check for Updates…");
    const quitIdx = file.findIndex((i) => i.role === "quit");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(quitIdx).toBeGreaterThan(updateIdx);
  });

  it("renders the state-derived label/enabled and clicks through to onUpdate", () => {
    const onUpdate = vi.fn();
    const t = buildMenuTemplate(
      opts({ update: { label: "Restart to Update (v1.2.3)", enabled: true } }),
      { ...handlers, onUpdate },
    );
    const item = allItems(t).find((i) => i.label === "Restart to Update (v1.2.3)");
    expect(item?.enabled).toBe(true);
    (item?.click as () => void)();
    expect(onUpdate).toHaveBeenCalledTimes(1);

    const busy = buildMenuTemplate(
      opts({ update: { label: "Downloading Update… 42%", enabled: false } }),
      handlers,
    );
    expect(allItems(busy).find((i) => i.label === "Downloading Update… 42%")?.enabled).toBe(false);
  });
});

describe("[COMP:app-desktop/menu-template] target indicator + switch (§2.1/§2.3)", () => {
  const CLOUD = { kind: "cloud" as const, label: "Use Brian Cloud" };
  const LOCAL = { kind: "local" as const, label: "Local Brain (localhost:3003)" };

  it("omits every target item when no target is passed (pre-dual-target menu)", () => {
    for (const isMac of [true, false]) {
      const items = allItems(buildMenuTemplate(opts({ isMac }), handlers));
      expect(items.find((i) => i.label?.startsWith("Target:"))).toBeUndefined();
      expect(items.find((i) => i.label === "Sign In")).toBeDefined();
    }
  });

  it("cloud target: shows the disabled indicator, the switch-to-local item, and keeps Sign In/Out", () => {
    for (const isMac of [true, false]) {
      const items = allItems(buildMenuTemplate(opts({ isMac, target: CLOUD }), handlers));
      const indicator = items.find((i) => i.label === "Target: Use Brian Cloud");
      expect(indicator?.enabled).toBe(false);
      expect(items.find((i) => i.label === "Switch to Local Brain…")).toBeDefined();
      expect(items.find((i) => i.label === "Sign In")).toBeDefined();
      expect(items.find((i) => i.label === "Sign Out")).toBeDefined();
    }
  });

  it("local target: hides Sign In/Out (no login exists) and offers the switch back to cloud", () => {
    for (const isMac of [true, false]) {
      const items = allItems(buildMenuTemplate(opts({ isMac, target: LOCAL }), handlers));
      expect(items.find((i) => i.label === "Sign In")).toBeUndefined();
      expect(items.find((i) => i.label === "Sign Out")).toBeUndefined();
      const indicator = items.find((i) => i.label === "Target: Local Brain (localhost:3003)");
      expect(indicator?.enabled).toBe(false);
      expect(items.find((i) => i.label === "Switch to Use Brian Cloud")).toBeDefined();
    }
  });

  it("clicking the switch item invokes onSwitchTarget", () => {
    const onSwitchTarget = vi.fn();
    const items = allItems(
      buildMenuTemplate(opts({ target: CLOUD }), { ...handlers, onSwitchTarget }),
    );
    const item = items.find((i) => i.label === "Switch to Local Brain…");
    (item?.click as () => void)();
    expect(onSwitchTarget).toHaveBeenCalledTimes(1);
  });

  it("uninstall item renders in the macOS app menu only when enabled, and clicks through", () => {
    // Absent by default (dev runs, and when the flag is omitted entirely).
    expect(
      allItems(buildMenuTemplate(opts(), handlers)).find((i) => i.label?.startsWith("Uninstall")),
    ).toBeUndefined();

    const onUninstall = vi.fn();
    const items = allItems(
      buildMenuTemplate(opts({ uninstall: true }), { ...handlers, onUninstall }),
    );
    const item = items.find((i) => i.label === "Uninstall Use Brian…");
    expect(item).toBeDefined();
    (item?.click as () => void)();
    expect(onUninstall).toHaveBeenCalledTimes(1);
  });

  it("uninstall item never renders off-mac even when the flag is set", () => {
    const items = allItems(buildMenuTemplate(opts({ isMac: false, uninstall: true }), handlers));
    expect(items.find((i) => i.label?.startsWith("Uninstall"))).toBeUndefined();
  });
});
