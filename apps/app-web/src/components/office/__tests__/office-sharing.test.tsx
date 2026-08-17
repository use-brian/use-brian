import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { OfficeSharing } from "../sharing/office-sharing";

describe("[COMP:app-web/office-history-sharing] Office sharing", () => {
  it("renders a localized loading state before the access projection arrives", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeSharing artifactId="00000000-0000-4000-8000-000000000001" /></I18nProvider>);
    expect(html).toContain(en.office.sharingLoading);
  });
});
