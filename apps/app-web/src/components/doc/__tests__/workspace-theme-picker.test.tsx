// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { DocTheme } from "@/lib/api/doc-themes";
import { WorkspaceThemePicker } from "../workspace-theme-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const state = vi.hoisted(() => ({
  palette: "notion", resolved: "light", customThemeId: null as string | null,
  themes: [] as DocTheme[], setPalette: vi.fn(), setMode: vi.fn(),
  applyTheme: vi.fn(), deleteTheme: vi.fn(), confirm: vi.fn(), settings: vi.fn(),
}));
vi.mock("@/lib/theme", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/theme")>(), useTheme: () => state,
}));
vi.mock("@/lib/custom-themes", () => ({ useCustomThemes: () => state }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: state.confirm }));
vi.mock("@/lib/workspace-settings-events", () => ({ openWorkspaceSettings: state.settings }));
vi.mock("../create-theme-dialog", () => ({ CreateThemeDialog: ({ open }: { open: boolean }) => open ? <div data-create-theme-dialog /> : null }));

describe("[COMP:app-web/workspace-theme-picker] rail theme control", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    state.palette = "notion"; state.resolved = "light"; state.customThemeId = null;
    state.themes = [{
      id: "theme-a", workspaceId: "workspace-a", createdBy: "person-a", name: "Forest",
      description: null, prompt: "Green accents",
      seed: { name: "Forest", primary: "#008800", accent: "#66aa66", neutral: "#ffffff", mood: "light" },
      tokens: { light: { primary: "#008800", background: "#ffffff" }, dark: {} },
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    }];
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  });
  async function render() {
    await act(async () => root.render(<I18nProvider locale="en" dict={en}><WorkspaceThemePicker /></I18nProvider>));
  }
  const trigger = () => container.querySelector<HTMLButtonElement>("[data-workspace-theme-picker]")!;
  async function click(element: HTMLElement) {
    // Select rejects clicks that did not begin on an unhighlighted option.
    await act(async () => element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
    await act(async () => element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    await act(async () => element.click());
  }
  function option(text: string) {
    return [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) => element.textContent?.includes(text))!;
  }

  it("names the active theme and switches the existing light/dark presets", async () => {
    await render();
    expect(trigger().getAttribute("aria-label")).toBe("Theme: Default");
    await click(trigger());
    await click(option(en.settings.general.paletteDefaultDark));
    expect(state.setPalette).toHaveBeenCalledWith("notion");
    expect(state.setMode).toHaveBeenCalledWith("dark");
    state.resolved = "dark";
    await render();
    expect(trigger().getAttribute("aria-label")).toBe("Theme: Default Dark");
  });

  it("applies custom themes through the shared provider and updates the swatch name", async () => {
    await render(); await click(trigger()); await click(option("Forest"));
    expect(state.applyTheme).toHaveBeenCalledWith(state.themes[0]);
    state.palette = "custom"; state.customThemeId = "theme-a";
    await render();
    expect(trigger().getAttribute("aria-label")).toBe("Theme: Forest");
  });

  it("retains confirmation before deleting a custom theme", async () => {
    await render(); await click(trigger());
    const deleteButton = () => document.querySelector<HTMLButtonElement>(`button[aria-label="${en.settings.general.customThemeDelete}: Forest"]`)!;
    state.confirm.mockResolvedValueOnce(false);
    await click(deleteButton());
    expect(state.deleteTheme).not.toHaveBeenCalled();
    await click(trigger());
    state.confirm.mockResolvedValueOnce(true);
    await click(deleteButton());
    expect(state.deleteTheme).toHaveBeenCalledWith("theme-a");
  });

  it("closes the phone drawer before opening the create dialog or theme settings", async () => {
    const close = vi.fn(); window.addEventListener("doc:sidebar-close", close);
    try {
      await render(); await click(trigger());
      await click(document.querySelector<HTMLButtonElement>(`button[aria-label="${en.settings.general.customThemeEdit}: Forest"]`)!);
      expect(state.settings).toHaveBeenCalledWith("preferences");
      expect(close).toHaveBeenCalledOnce();
      await click(trigger()); await click(option(en.settings.general.createYourOwn));
      expect(container.querySelector("[data-create-theme-dialog]")).not.toBeNull();
      expect(close).toHaveBeenCalledTimes(2);
      expect(state.applyTheme).not.toHaveBeenCalled();
    } finally { window.removeEventListener("doc:sidebar-close", close); }
  });
});
