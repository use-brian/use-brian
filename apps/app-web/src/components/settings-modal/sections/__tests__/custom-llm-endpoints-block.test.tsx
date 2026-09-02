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

  it("keeps the fallback toggle copy honest about cost and announcement", () => {
    // The opt-in is the ONLY thing standing between byo-llm-key.md's two
    // stated objections and a silent swap: an admin flipping this is
    // consenting to workspace content reaching a provider they did not pick,
    // and to being billed for the turn. If the copy stops saying both, the
    // switch stops being informed consent.
    expect(en.customLlmEndpoints.fallbackDesc).toContain("Off by default");
    expect(en.customLlmEndpoints.fallbackDesc).toMatch(/billed/i);
    expect(en.customLlmEndpoints.fallbackDesc).toMatch(/says it happened|the reply says/i);
  });
});
