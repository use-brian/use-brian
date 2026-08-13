// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { snapshotToYDoc } from "@use-brian/office-model";
import { DocumentEditor } from "../document-editor";
import { documentFixture } from "./editor-fixtures";

describe("[COMP:app-web/office-document-editor] adaptive Document controls", () => {
  it("renders desktop/tablet and phone surfaces from the same action registry with accessible toolbar semantics", () => {
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container); const doc = snapshotToYDoc(documentFixture());
    act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><DocumentEditor snapshot={documentFixture()} baseVersion={1} role="edit" suggestMode={false} doc={doc} synced onCommand={vi.fn()} /></I18nProvider>));
    expect(container.querySelector('[data-document-toolbar-surface="desktop-tablet"] [role="toolbar"]')).not.toBeNull();
    expect(container.querySelector('[data-document-toolbar-surface="phone"] [role="toolbar"]')).not.toBeNull();
    expect(container.querySelectorAll(`button[aria-label="${en.office.bold}"]`)).toHaveLength(2);
    expect(container.querySelector('[spellcheck="true"]')).not.toBeNull();
    act(() => root.unmount()); doc.destroy(); container.remove();
  });
});
