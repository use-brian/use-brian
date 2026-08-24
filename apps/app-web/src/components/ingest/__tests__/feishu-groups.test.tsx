import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { FeishuGroupManager } from "../feishu-groups";

describe("[COMP:app-web/studio-feishu-ingest] Feishu group manager", () => {
  it("starts fail-closed with the ambient permission and loading state visible", () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en" dict={en as unknown as Dictionary}>
        <FeishuGroupManager instanceId="connector-1" onChange={() => {}} />
      </I18nProvider>,
    );

    expect(html).toContain("im:message.group_msg");
    expect(html).toContain(en.studioPage.ingestRules.feishu.permissionNote);
    expect(html).toContain(en.studioPage.ingestRules.feishu.working);
  });
});
