import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { OfficeSuggestions } from "../suggestions/office-suggestions";

describe("[COMP:app-web/office-suggestions] Suggestion review", () => {
  it("renders an accessible review surface without speculative editor content", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeSuggestions artifactId="00000000-0000-4000-8000-000000000001" canDecide /></I18nProvider>);
    expect(html).toContain(`aria-label="${en.office.suggestions}"`);
    expect(html).toContain(en.office.noSuggestions);
  });
});
