// @vitest-environment jsdom
/**
 * [COMP:app-web/redeem] The packaged desktop renderer keeps the billing CTA
 * inside its HashRouter and supplies the shared redeem form with the same
 * workspace resolution as the Next route.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testMocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
}));

vi.mock("@/lib/auth-fetch", () => ({
  getValidAccessToken: async () => "test-token",
  authFetch: testMocks.authFetch,
}));
vi.mock("@/lib/offline/idb", () => ({ idbGet: async () => null, idbSet: async () => {} }));
vi.mock("@/lib/theme", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/workspace-context", () => ({ WorkspaceContextProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/custom-themes", () => ({ CustomThemesProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/doc/doc-sidebar-data", () => ({
  DocSidebarDataProvider: ({ children }: { children: ReactNode }) => children,
  useSidebarData: () => ({ homeApps: ["page"], homeAppsLoading: false }),
}));
vi.mock("@/contexts/brain-surface-context", () => ({ BrainSurfaceProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/contexts/primary-assistant", () => ({ PrimaryAssistantProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/ui/confirm-dialog", () => ({ ConfirmDialogProvider: () => null }));
vi.mock("@/components/ui/prompt-dialog", () => ({ PromptDialogProvider: () => null }));
vi.mock("@/components/ui/kind-picker-dialog", () => ({ KindPickerDialogProvider: () => null }));
vi.mock("@/components/desktop-link-recovery", () => ({ DesktopLinkRecovery: () => null }));
vi.mock("@/components/chrome/desktop-chat-window", () => ({ DesktopChatWindow: () => null }));
vi.mock("@/components/workspace-picker", () => ({ WorkspacePicker: () => null }));
vi.mock("@/components/doc/workspace-chrome", () => ({ WorkspaceChrome: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/app/redeem/redeem-form", () => ({
  RedeemForm: ({ targetWorkspaceId, prefilledCode }: { targetWorkspaceId: string | null; prefilledCode: string }) => (
    <div data-redeem-workspace={targetWorkspaceId ?? ""} data-redeem-code={prefilledCode} />
  ),
}));

import { App } from "../app";

let root: Root;
let host: HTMLDivElement;

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 0));
    });
  }
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testMocks.authFetch.mockReset().mockResolvedValue(
    new Response(
      JSON.stringify({
        workspaces: [
          { id: "workspace-one", name: "Workspace One" },
          { id: "workspace-two", name: "Workspace Two" },
        ],
      }),
    ),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.history.replaceState(null, "", "/");
});

describe("[COMP:app-web/redeem] bundled desktop routing", () => {
  it("uses the router-aware Link for the billing redemption CTA", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/settings-modal/sections/billing-section.tsx",
      ),
      "utf8",
    );
    expect(source).toContain('import Link from "next/link"');
    expect(source).toMatch(/<Link\s+href=\{`\/redeem\?ws=/);
    expect(source).not.toMatch(/<a\s+href=\{`\/redeem\?ws=/);
  });

  it("renders the shared form for the requested workspace and promo code", async () => {
    window.history.replaceState(
      null,
      "",
      "#/redeem?ws=workspace-two&code=WELCOME",
    );
    await act(async () => root.render(<App />));
    await settle();

    const form = host.querySelector<HTMLElement>("[data-redeem-workspace]");
    expect(form?.dataset.redeemWorkspace).toBe("workspace-two");
    expect(form?.dataset.redeemCode).toBe("WELCOME");
  });

  it("falls back to the first accessible workspace for an invalid override", async () => {
    window.history.replaceState(null, "", "#/redeem?ws=not-accessible");
    await act(async () => root.render(<App />));
    await settle();

    expect(
      host.querySelector<HTMLElement>("[data-redeem-workspace]")?.dataset
        .redeemWorkspace,
    ).toBe("workspace-one");
  });
});
