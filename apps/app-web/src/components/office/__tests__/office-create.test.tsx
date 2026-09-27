/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

import { attachOfficeMetadata } from "@/lib/office/metadata";
import { resetSurfaceCache } from "@/lib/surface-cache";
vi.mock("@/lib/workspace-context", () => ({useOptionalWorkspaceContext: () => ({workspaceId: "workspace", me: {id: "viewer"}})}));
const mocks = vi.hoisted(() => ({ create: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams("templateId=template&templateVersionId=version"),
}));
vi.mock("../office-topbar", () => ({ OfficeTopbar: () => null }));
vi.mock("@/lib/office/api", async (original) => ({
  ...await original<Record<string, unknown>>(),
  getOfficeCapabilities: async () => ({ generationAvailable: true, generationFamilies: ["document"] }),
  listOfficeTemplates: async () => attachOfficeMetadata([{ id: "template", currentVersionId: "version", lifecycleState: "admitted", family: "document", name: "Contract" }], 30_000, performance.now(), "viewer"),
  createOfficeArtifact: mocks.create,
}));
import { OfficeCreate } from "../office-create";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.clearAllMocks(); resetSurfaceCache(); });

describe("[COMP:app-web/office-navigation] Office create validation", () => {
  it.each([
    ["outcome", 4_000], ["audience", 1_000], ["context", 4_000],
  ] as const)("preserves over-limit %s text, blocks submission and recovers at the boundary", async (field, limit) => {
    const host = document.createElement("div");
    const root = createRoot(host);
    mocks.create.mockResolvedValue({ artifactId: "created" });
    await act(async () => root.render(<I18nProvider locale="en" dict={en}><OfficeCreate workspaceId="workspace" /></I18nProvider>));
    const set = (id: string, value: string) => {
      const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#office-create-${id}`)!;
      const prototype = input.tagName === "INPUT" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    act(() => { set("outcome", "Contract"); set("audience", "Client"); });
    act(() => set(field, "x".repeat(limit + 1)));
    const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#office-create-${field}`)!;
    expect(input.value).toHaveLength(limit + 1);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector(`#office-create-${field}-help`)?.textContent).toContain(`exceeds its ${limit}-character limit`);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.create).not.toHaveBeenCalled();
    act(() => set(field, "x".repeat(limit)));
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0][field === "context" ? "additionalContext" : field]).toHaveLength(limit);
    act(() => root.unmount());
  });
});
