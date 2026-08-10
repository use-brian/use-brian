import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@/lib/workspace-context", () => ({ useWorkspaceContext: () => ({ workspaceId: "workspace-1" }) }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => false) }));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { CustomLlmEndpointsBlock } from "../custom-llm-endpoints-block";

describe("[COMP:app-web/custom-llm-endpoints] endpoint settings block", () => {
  it("renders the shared hosted and self-hosted heading and loading state", () => {
    const html = renderToString(
      <I18nProvider locale="en" dict={en as unknown as Dictionary}>
        <CustomLlmEndpointsBlock />
      </I18nProvider>,
    );
    expect(html).toContain(en.customLlmEndpoints.heading);
    expect(html).toContain(en.customLlmEndpoints.loading);
  });
});
