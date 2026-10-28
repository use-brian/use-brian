// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import { WorkspaceStructureSwitcher } from "../workspace-structure-switcher";

const ports = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: ports.push }) }));
vi.mock("next/link", () => ({ default: ({ href, children, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props} onClick={event => { event.preventDefault(); onClick?.(event); }}>{children}</a> }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));
vi.mock("@/lib/surface-prefetch", () => ({ useIntentPrefetch: () => () => ({}) }));

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ports.push.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("[COMP:app-web/workspace-structure-switcher] Projects and Organization views", () => {
  it("follows the active view without remembering a previous selection, and uses workspace-local routes", async () => {
    for (const view of ["projects", "organization", "projects"] as const) {
      await act(async () => root.render(<WorkspaceStructureSwitcher workspaceId="workspace-a" view={view} />));
      expect(host.querySelector('[aria-current="page"]')?.getAttribute("href")).toBe(`/w/workspace-a/${view}`);
      expect([...host.querySelectorAll("a")].map(link => link.getAttribute("href"))).toEqual(["/w/workspace-a/projects", "/w/workspace-a/organization"]);
      expect(host.querySelector("nav")?.getAttribute("aria-label")).toBe(en.workspaceNav.projectsAndOrganization);
    }
    await act(async () => root.render(<WorkspaceStructureSwitcher workspaceId="workspace-b" view="organization" />));
    expect(host.querySelector('[aria-current="page"]')?.getAttribute("href")).toBe("/w/workspace-b/organization");
    expect(ports.push).not.toHaveBeenCalled();
  });

  it("closes the drawer on both view links, including the current view", async () => {
    const close = vi.fn(); window.addEventListener("doc:sidebar-close", close);
    try {
      await act(async () => root.render(<WorkspaceStructureSwitcher workspaceId="workspace-a" view="projects" />));
      for (const link of host.querySelectorAll("a")) await act(async () => link.click());
      expect(close).toHaveBeenCalledTimes(2);
    } finally { window.removeEventListener("doc:sidebar-close", close); }
  });

  it.each(["projects", "organization"] as const)("keeps both views available in the compact %s menu and closes the drawer on selection", async view => {
    const close = vi.fn(); window.addEventListener("doc:sidebar-close", close);
    try {
      await act(async () => root.render(<WorkspaceStructureSwitcher workspaceId="workspace-a" view={view} compact />));
      const trigger = host.querySelector<HTMLButtonElement>("button")!;
      expect(trigger.textContent).toContain(view === "projects" ? en.contextScope.projectsTitle : en.organization.title);
      for (const [label, target] of [[en.contextScope.projectsTitle, "projects"], [en.organization.title, "organization"]]) {
        await act(async () => trigger.click());
        const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)!;
        expect(item).toBeTruthy();
        await act(async () => item.click());
        expect(ports.push).toHaveBeenLastCalledWith(`/w/workspace-a/${target}`);
      }
      expect(close).toHaveBeenCalledTimes(2);
    } finally { window.removeEventListener("doc:sidebar-close", close); }
  });
});
