import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { OfficeHistory } from "../history/office-history";

describe("[COMP:app-web/office-history-sharing] Office history", () => {
  it("starts with an accessible immutable-version surface", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeHistory artifactId="00000000-0000-4000-8000-000000000001" artifactTitle="Report" currentVersion={2} canEdit /></I18nProvider>);
    expect(html).toContain(`aria-label="${en.office.versionHistory}"`);
    expect(html).toContain(en.office.noVersions);
  });
});
