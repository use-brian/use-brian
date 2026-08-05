import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), forward: vi.fn(), prefetch: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/doc/doc-sidebar-data", () => ({ useSidebarData: () => ({ sidebarCollapsed: false, setSidebarCollapsed: vi.fn() }) }));
import { OfficeHome } from "../office-home";

describe("[COMP:app-web/office-home] Office home", () => {
  it("keeps lifecycle and family filters in one left-anchored bar", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeHome workspaceId="11111111-1111-4111-8111-111111111111" initialArtifacts={[]} /></I18nProvider>);
    const bar = html.match(/<div data-office-filter-bar="left" class="([^"]+)">/);
    expect(bar?.[1]).toContain("flex-wrap");
    expect(bar?.[1]).not.toContain("justify-between");
    expect(html.indexOf(">Active<")).toBeLessThan(html.indexOf(">All<"));
    expect(html).toContain('aria-hidden="true" class="hidden h-5 w-px bg-border sm:block"');
  });

  it("renders both admitted artifact families and their editor links", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeHome workspaceId="11111111-1111-4111-8111-111111111111" initialArtifacts={[
      { artifactId: "22222222-2222-4222-8222-222222222222", family: "document", title: "Plan", version: 2, lifecycleState: "active", role: "edit" },
      { artifactId: "33333333-3333-4333-8333-333333333333", family: "presentation", title: "Pitch", version: 1, lifecycleState: "active", role: "comment" },
    ]} /></I18nProvider>);
    expect(html).toContain("Plan");
    expect(html).toContain("Pitch");
    expect(html).toContain("/office/22222222-2222-4222-8222-222222222222");
    expect(html).toContain("/office/33333333-3333-4333-8333-333333333333");
  });
});
