// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ applyCustomTheme: vi.fn(), setPalette: vi.fn(), createDocTheme: vi.fn(), listDocThemes: vi.fn(async () => []) }));
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ ...mocks, customThemeId: null }) }));
vi.mock("@/lib/api/doc-themes", async (original) => ({ ...await original<object>(), ...mocks }));
import { CustomThemesProvider, useCustomThemes } from "../custom-themes";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe("[COMP:app-web/custom-themes-provider] icon generation", () => {
  it("forwards icon guidance and saves and applies the generated theme", async () => {
    const theme = { id: "new", tokens: { light: {}, dark: {} }, seed: { appearance: "dark" } };
    mocks.createDocTheme.mockResolvedValue(theme);
    let context: ReturnType<typeof useCustomThemes>;
    function Consumer() { context = useCustomThemes(); return null; }
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(<CustomThemesProvider workspaceId="ws"><Consumer /></CustomThemesProvider>));
      await act(async () => { await context.createTheme({ fromIcon: true, prompt: "dark" }); });
      expect(mocks.createDocTheme).toHaveBeenCalledWith("ws", { fromIcon: true, prompt: "dark" });
      expect(mocks.applyCustomTheme).toHaveBeenCalledWith("new", theme.tokens, "dark");
      expect(context!.themes).toEqual([theme]); expect(context!.generating).toBe(false);
    } finally { await act(async () => root.unmount()); }
  });
});
