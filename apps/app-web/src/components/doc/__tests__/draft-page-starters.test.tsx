// @vitest-environment jsdom
/** [COMP:app-web/empty-page-landing] Original starters inside an editable draft. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { DraftPageStarters } from "../empty-page-landing";

vi.mock("@/lib/api/views", async (original) => ({
  ...await original<typeof import("@/lib/api/views")>(),
  listWorkspaceAssistants: async () => [],
}));
vi.mock("@/lib/chat-model", () => ({
  useChatModelTier: () => ({ model: "pro", setModel: vi.fn(), plan: null }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});

describe("[COMP:app-web/empty-page-landing] Minimal original starters", () => {
  it("keeps original controls and suggestions without another welcome heading", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const submit = vi.fn();
    const template = vi.fn();
    const render = async (active: boolean, pageId = "page-a") => act(async () => root.render(
      <I18nProvider locale="en" dict={en}>
        <DraftPageStarters key={pageId} active={active} workspaceId="ws_1" cards={[]}
          onOpenCard={() => {}} onStartBlank={() => {}}
          onStartFromTemplate={template} onSubmitPrompt={submit} />
      </I18nProvider>,
    ));
    await render(true);
    expect(host.querySelector("h1")).toBeNull();
    expect(host.textContent).not.toContain(en.docPage.landing.startBlank);
    for (const suggestion of en.docPage.landing.suggestions) expect(host.textContent).toContain(suggestion);
    expect(host.querySelector(`button[aria-label="${en.attachments.attach}"]`)).not.toBeNull();
    const input = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Keep my unsent question");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await render(false);
    expect(host.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("Keep my unsent question");
    await act(async () => {
      [...host.querySelectorAll("button")].find(button => button.textContent?.includes(en.docPage.landing.startFromTemplate))!.click();
      host.querySelector<HTMLButtonElement>(`button[aria-label="${en.docPage.landing.send}"]`)!.click();
    });
    expect(template).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith("Keep my unsent question", expect.objectContaining({ fileIds: [] }));
    expect(host.querySelector("textarea")).toBeNull();
    await render(true);
    await render(false, "page-b");
    expect(host.querySelector("textarea")).toBeNull();
  });
});
