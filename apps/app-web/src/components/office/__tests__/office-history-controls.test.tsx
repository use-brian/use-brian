import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { OfficeHistoryControls } from "../office-history-controls";

describe("[COMP:app-web/office-history] Office history controls", () => {
  it("uses localized shortcut hints and manager-provided disabled state", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeHistoryControls canUndo={false} canRedo onUndo={vi.fn()} onRedo={vi.fn()} /></I18nProvider>);
    expect(html).toContain(`aria-label="${en.office.historyControls}"`);
    expect(html).toContain(`${en.office.undo} (${en.office.undoShortcut})`);
    expect(html).toContain(`${en.office.redo} (${en.office.redoShortcut})`);
    expect(html.match(/disabled=""/g)).toHaveLength(1);
  });
});
