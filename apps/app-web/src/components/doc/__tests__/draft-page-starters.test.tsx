// @vitest-environment jsdom
/** [COMP:app-web/empty-page-landing] Draft links without a second request box. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { DraftPageStarters } from "../empty-page-landing";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe("[COMP:app-web/empty-page-landing] Minimal draft links", () => {
  it("keeps original suggestions and templates without another composer", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const submit = vi.fn();
    const template = vi.fn();
    try {
      await act(async () => root.render(<I18nProvider locale="en" dict={en}>
        <DraftPageStarters active workspaceId="ws_1" cards={[]} onOpenCard={() => {}} onStartBlank={() => {}} onSubmitPrompt={submit} onStartFromTemplate={template} />
      </I18nProvider>));
      expect(host.querySelector("textarea")).toBeNull();
      expect(host.querySelector("input[type=file]")).toBeNull();
      expect(host.querySelector("h1")).toBeNull();
      const buttons = [...host.querySelectorAll("button")];
      expect(buttons.map(button => button.textContent)).toEqual([...en.docPage.landing.suggestions, en.docPage.landing.startFromTemplate]);
      await act(async () => { buttons[0].click(); buttons[3].click(); });
      expect(submit).toHaveBeenCalledWith(en.docPage.landing.suggestions[0], expect.objectContaining({ fileIds: [] }));
      expect(template).toHaveBeenCalledOnce();
    } finally { await act(async () => root.unmount()); }
  });
});
