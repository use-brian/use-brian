// @vitest-environment jsdom
/**
 * [COMP:app-web/kb-add-source-modal] Connect-a-source dialog.
 *
 * The add-source picker moved from an inline card into a themed dialog
 * (knowledge-ux-revamp D1). Verifies the modal renders the instance-first
 * cascade, gates the submit until the cascade is complete, surfaces the
 * no-connector hint, and hands the created source id to `onConnected` on a
 * successful local-source POST (the GitHub leg differs only in body shape).
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

import { AddSourceModal } from "../add-source-modal";

const dict = en as unknown as Dictionary;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthFetch.mockResolvedValue({ ok: true, json: async () => ({ repos: [] }) });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

function render(ui: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        {ui}
      </I18nProvider>,
    );
  });
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const flush = () => act(async () => { await Promise.resolve(); });

describe("[COMP:app-web/kb-add-source-modal] AddSourceModal", () => {
  it("renders the cascade with the submit gated until it is complete", async () => {
    const onConnected = vi.fn();
    render(
      <AddSourceModal
        workspaceId="ws-1"
        open
        instances={[{ id: "ci-1", label: "GitHub (work)", connectedEmail: "dev@acme.example", sensitivity: null }]}
        onClose={() => {}}
        onConnected={onConnected}
      />,
    );
    await flush();
    const text = document.body.textContent ?? "";
    expect(text).toContain(dict.studioPage.knowledgePage.addRepo);
    expect(text).toContain(dict.studioPage.knowledgePage.connectorLabel);
    const submit = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === dict.studioPage.knowledgePage.addRepoSubmit,
    )!;
    expect(submit.disabled).toBe(true);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("shows the no-connector hint when the workspace has no GitHub instance", async () => {
    render(
      <AddSourceModal workspaceId="ws-1" open instances={[]} onClose={() => {}} onConnected={() => {}} />,
    );
    await flush();
    expect(document.body.textContent).toContain(
      dict.studioPage.knowledgePage.noGithubConnector,
    );
  });

  it("POSTs a local source and hands the created id to onConnected", async () => {
    const onConnected = vi.fn();
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "src-9", validation: { warning: null } }),
    });
    render(
      <AddSourceModal workspaceId="ws-1" open instances={[]} onClose={() => {}} onConnected={onConnected} />,
    );
    await flush();

    // Switch to the local tab, fill the path, submit.
    const localTab = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === dict.studioPage.knowledgePage.sourceTypeLocal,
    )!;
    act(() => localTab.click());
    const pathInput = Array.from(document.body.querySelectorAll("input")).find(
      (i) => i.placeholder === dict.studioPage.knowledgePage.localPathPlaceholder,
    )!;
    act(() => setValue(pathInput, "/srv/kb"));
    const submit = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === dict.studioPage.knowledgePage.addRepoSubmit,
    )!;
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); });

    const postCall = mockAuthFetch.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    )!;
    expect(String(postCall[0])).toContain("/api/workspaces/ws-1/knowledge/sources");
    expect(JSON.parse((postCall[1] as RequestInit).body as string)).toMatchObject({
      sourceType: "local",
      localPath: "/srv/kb",
    });
    expect(onConnected).toHaveBeenCalledWith("src-9", null);
  });
});
