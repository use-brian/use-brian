import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { OfficeComments } from "../comments/office-comments";
import { uid } from "./editor-fixtures";
describe("[COMP:app-web/office-comments] Office comments", () => {
  it("requires an exact target and explains explicit @Brian invocation", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeComments artifactId={uid(1)} version={2} targetIds={[uid(10)]} canComment /></I18nProvider>);
    expect(html).toContain(en.office.commentPlaceholder);
    expect(html).toContain("@Brian");
  });
});
