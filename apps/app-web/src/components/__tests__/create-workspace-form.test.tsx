// @vitest-environment jsdom
/** [COMP:app-web/create-workspace-form] Canonical create validation and accessible recovery. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";

const mocks = vi.hoisted(() => ({ authFetch: vi.fn(), phone: false }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: mocks.authFetch }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "http://localhost:4100" }) }));
vi.mock("@/lib/viewport", () => ({ isPhoneViewport: () => mocks.phone }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));
import { CreateWorkspaceForm } from "../create-workspace-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const t = en.workspaceSwitcher.create;
let host: HTMLDivElement;
let root: Root;
let onCreated: ReturnType<typeof vi.fn>;
let onCancel: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.authFetch.mockReset();
  mocks.phone = false;
  onCreated = vi.fn(); onCancel = vi.fn();
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function mount(autoFocus = false) {
  await act(async () => root.render(<CreateWorkspaceForm onCreated={onCreated} onCancel={onCancel} autoFocus={autoFocus} />));
}
function fields() { return { name: host.querySelector<HTMLInputElement>("input")!, purpose: host.querySelector<HTMLTextAreaElement>("textarea")! }; }
function button(label: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label)!; }
async function enter(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function valid() { const f = fields(); await enter(f.name, "Fictional Cedar Planning"); await enter(f.purpose, "Shared fictional planning."); }
function deferred() {
  let resolve!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((yes, no) => { resolve = yes; reject = no; });
  mocks.authFetch.mockReturnValueOnce(promise);
  return { resolve, reject };
}
async function submit() {
  const submitButton = button(t.submit); submitButton.focus();
  await act(async () => submitButton.click());
  return submitButton;
}
function displaceSubmitFocus() {
  // jsdom does not blur a newly disabled button like Chromium. Reproduce the
  // browser-proven BODY state without focusing another recovery control.
  document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex");
}
async function fail(request: ReturnType<typeof deferred>) {
  await act(async () => request.resolve({ ok: false, json: async () => ({ error: "Request failed" }) }));
}

describe("[COMP:app-web/create-workspace-form] validation and request recovery", () => {
  it("associates stable unique labels and the minimum-purpose hint with each field", async () => {
    await act(async () => root.render(<><CreateWorkspaceForm onCreated={onCreated} /><CreateWorkspaceForm onCreated={onCreated} /></>));
    const inputs = [...host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")];
    expect(new Set(inputs.map(node => node.id)).size).toBe(4);
    for (const node of inputs) {
      expect(node.id).not.toBe("");
      expect(node.labels?.[0]?.textContent).toBe(node.tagName === "INPUT" ? t.namePlaceholder : t.purposePlaceholder);
    }
    for (const purpose of host.querySelectorAll("textarea")) {
      const description = document.getElementById(purpose.getAttribute("aria-describedby")!);
      expect(description?.textContent).toBe(t.purposeMinHint);
    }
    const ids = inputs.map(node => node.id);
    await enter(inputs[0], "Fictional team");
    expect([...host.querySelectorAll("input, textarea")].map(node => node.id)).toEqual(ids);
  });

  it("gates empty, whitespace and short values without a request, then submits trimmed valid data once", async () => {
    await mount();
    expect(button(t.submit).disabled).toBe(true);
    await enter(fields().name, "  "); await enter(fields().purpose, "1234567890");
    expect(button(t.submit).disabled).toBe(true);
    await enter(fields().name, " Fictional team "); await enter(fields().purpose, "123456789");
    expect(button(t.submit).disabled).toBe(true);
    button(t.submit).click(); expect(mocks.authFetch).not.toHaveBeenCalled();
    const request = deferred();
    await enter(fields().purpose, " 1234567890 ");
    expect(button(t.submit).disabled).toBe(false);
    const submitting = await submit();
    expect(submitting.disabled).toBe(true);
    submitting.click();
    expect(mocks.authFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.authFetch.mock.calls[0][1].body)).toEqual({ name: "Fictional team", purpose: "1234567890" });
    await fail(request);
  });

  it("keeps phone opening from raising the text keyboard while retaining desktop autofocus", async () => {
    mocks.phone = true; await mount(true);
    expect(document.activeElement).not.toBe(fields().name);
    expect(fields().name.hasAttribute("autofocus")).toBe(false);
    mocks.phone = false;
    await act(async () => root.render(<CreateWorkspaceForm key="desktop" autoFocus onCreated={onCreated} />));
    expect(document.activeElement).toBe(fields().name);
  });

  it("announces a failed request, retains valid fields and recovers displaced BODY focus without focusing an input", async () => {
    mocks.phone = true; await mount(); await valid();
    const request = deferred(); const submitting = await submit();
    displaceSubmitFocus(); expect(document.activeElement).toBe(document.body);
    await fail(request);
    const error = host.querySelector<HTMLElement>('[role="alert"]');
    expect(error?.textContent).toBe("Request failed");
    expect(document.activeElement).toBe(error);
    expect(error?.tabIndex).toBe(-1);
    expect(fields().name.value).toBe("Fictional Cedar Planning");
    expect(fields().purpose.value).toBe("Shared fictional planning.");
    expect(fields().name.hasAttribute("aria-invalid")).toBe(false);
    expect(fields().purpose.hasAttribute("aria-invalid")).toBe(false);
    expect(button(t.submit).disabled).toBe(false);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("recovers to the error when the submit button itself retains focus", async () => {
    await mount(); await valid(); const request = deferred(); await submit(); await fail(request);
    expect(document.activeElement).toBe(host.querySelector('[role="alert"]'));
  });

  it("does not steal focus deliberately moved to Cancel while the request was pending", async () => {
    await mount(); await valid(); const request = deferred(); await submit();
    button(t.cancel).focus(); await fail(request);
    expect(document.activeElement).toBe(button(t.cancel));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Request failed");
  });

  it("does not recapture focus after a deliberate pending-request field focus then blur", async () => {
    await mount(); await valid(); const request = deferred(); await submit();
    fields().purpose.focus(); fields().purpose.blur(); await fail(request);
    expect(document.activeElement).toBe(document.body);
  });

  it("announces network failure with the translated recovery message", async () => {
    await mount(); await valid(); const request = deferred(); await submit(); displaceSubmitFocus();
    await act(async () => request.reject(new Error("offline")));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t.errorNetwork);
    expect(document.activeElement).toBe(host.querySelector('[role="alert"]'));
    expect(button(t.submit).disabled).toBe(false);
  });

  it("clears a failure on edit and completes one canonical successful retry", async () => {
    await mount(); await valid(); const request = deferred(); await submit(); await fail(request);
    await enter(fields().name, "Fictional Cedar Studio");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const created = { id: "workspace-fictional", name: "Fictional Cedar Studio", iconSeed: null };
    mocks.authFetch.mockResolvedValueOnce({ ok: true, json: async () => created });
    await submit();
    expect(mocks.authFetch).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(created);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels an unsubmitted draft without creating or navigating", async () => {
    await mount(); await valid(); await act(async () => button(t.cancel).click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
    expect(mocks.authFetch).not.toHaveBeenCalled();
  });
});
