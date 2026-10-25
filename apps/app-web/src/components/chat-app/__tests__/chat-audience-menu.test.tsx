// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ChatAudienceMenu } from "../chat-audience-menu";
import { SIDEBAR_CLOSE_EVENT } from "@/lib/sidebar-close";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("[COMP:app-web/chat-audience-menu] contextual audience selection", () => {
  let host: HTMLDivElement, root: Root;
  beforeEach(() => {
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  async function render(view: "personal" | "workspace", onSelect: (mode: "personal" | "workspace") => void, heading = true) {
    await act(async () => root.render(<I18nProvider locale="en" dict={en}><ChatAudienceMenu view={view} onSelect={onSelect} heading={heading} /></I18nProvider>));
  }
  async function open() { await act(async () => host.querySelector<HTMLButtonElement>('button')!.click()); }

  it("calls personal chat Chat in both headings while keeping the audience accessible", async () => {
    const select = vi.fn();
    for (const heading of [true, false]) {
      await render("personal", select, heading);
      expect(host.querySelector('button')?.textContent).toBe(en.operatorBar.chat);
      expect(host.querySelector('button')?.getAttribute('aria-label')).toContain(en.chatApp.viewPersonal);
      await open();
      expect(document.querySelector('button[aria-pressed="true"]')?.textContent).toContain(en.chatApp.viewPersonal);
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!.click());
    }
    expect(select.mock.calls).toEqual([["personal"], ["personal"]]);
  });

  it("opens without changing scope, describes both audiences and checks the selected one", async () => {
    const select = vi.fn(); await render("personal", select); await open();
    expect(select).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(en.chatApp.personalScopeDescription);
    expect(document.body.textContent).toContain(en.chatApp.workspaceScopeDescription);
    expect(document.querySelector('button[aria-pressed="true"]')?.textContent).toContain(en.chatApp.viewPersonal);
    const workspace = document.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!;
    await act(async () => workspace.click());
    expect(select).toHaveBeenCalledExactlyOnceWith("workspace");
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    await render("workspace", select);
    expect(host.textContent).toContain(en.chatApp.viewWork);
    expect(host.textContent).not.toContain(en.operatorBar.chat);
    expect(host.querySelector("button")?.getAttribute("aria-label")).toContain(en.chatApp.viewWorkspace);
  });

  it("keeps separate title and fallback popover state while using the same callback", async () => {
    const select = vi.fn();
    await act(async () => root.render(<I18nProvider locale="en" dict={en}><ChatAudienceMenu view="workspace" onSelect={select} heading /><ChatAudienceMenu view="workspace" onSelect={select} /></I18nProvider>));
    expect([...host.querySelectorAll('button')].map(button => button.textContent)).toEqual([en.chatApp.viewWork, en.chatApp.viewWork]);
    await open();
    expect([...host.querySelectorAll('button')].map(button => button.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
    expect(document.querySelectorAll('[data-slot="popover-content"]')).toHaveLength(1);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!.click());
    expect(select).toHaveBeenCalledExactlyOnceWith('personal');
  });

  it("closes a phone drawer when its heading changes audience", async () => {
    const close = vi.fn(); window.addEventListener(SIDEBAR_CLOSE_EVENT, close);
    try {
      await render('personal', vi.fn()); await open();
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!.click());
      expect(close).toHaveBeenCalledOnce();
    } finally { window.removeEventListener(SIDEBAR_CLOSE_EVENT, close); }
  });
});
