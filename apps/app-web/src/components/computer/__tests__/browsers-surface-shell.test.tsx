// @vitest-environment jsdom
/**
 * [COMP:app-web/browsers-surface] Route-backed top-bar view switch.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pathname = "/w/ws-1/computer";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    className,
    "aria-current": ariaCurrent,
  }: {
    children: ReactNode;
    href: string;
    className?: string;
    "aria-current"?: "page";
  }) => (
    <a href={href} className={className} aria-current={ariaCurrent}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    computer: {
      sessions: {
        liveView: "Live browser",
        profilesView: "Browser profiles",
        viewSwitcherAria: "Browser view",
      },
    },
  }),
}));

vi.mock("@/components/operator/operator-topbar", () => ({
  OperatorTopbar: ({ center, right }: { center?: ReactNode; right?: ReactNode }) => (
    <header>
      {center}
      {right}
    </header>
  ),
}));

vi.mock("../connect-browser-button", () => ({
  ConnectBrowserButton: () => null,
}));

import { BrowsersSurfaceShell } from "../browsers-surface-shell";

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(route: string) {
  pathname = route;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<BrowsersSurfaceShell workspaceId="ws-1">body</BrowsersSurfaceShell>));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/browsers-surface] browser top-bar view", () => {
  it.each(["/w/ws-1/computer", "/w/ws-1/computer/session-1"])(
    "marks %s as Live browser",
    async (route) => {
      await mount(route);
      expect(container?.querySelector('a[href="/w/ws-1/computer"]')?.getAttribute("aria-current")).toBe(
        "page",
      );
    },
  );

  it.each(["/w/ws-1/computer/profiles", "/w/ws-1/computer/profiles/"])(
    "marks %s as Browser profiles",
    async (route) => {
      await mount(route);
      expect(
        container
          ?.querySelector('a[href="/w/ws-1/computer/profiles"]')
          ?.getAttribute("aria-current"),
      ).toBe("page");
    },
  );
});
