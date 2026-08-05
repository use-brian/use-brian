import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

const navigation = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), forward: vi.fn(), prefetch: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock("@/components/doc/doc-sidebar-data", () => ({ useSidebarData: () => ({ sidebarCollapsed: false, setSidebarCollapsed: vi.fn() }) }));
import { OfficeHome } from "../office-home";

describe("[COMP:app-web/office-home] Office home", () => {
  beforeEach(() => {
    navigation.search = "";
  });

  it("does not duplicate sidebar filters in the content pane", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeHome workspaceId="11111111-1111-4111-8111-111111111111" initialArtifacts={[]} /></I18nProvider>);
    expect(html).not.toContain("data-office-filter-bar");
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain(">Active<");
    expect(html).not.toContain(">All<");
    expect(html).toContain(">Overview<");
    expect(html).toContain("Start with your first templates");
    expect(html).toContain("General presentation");
    expect(html).toContain("Letterhead");
    expect(html).toContain("/office/templates?starter=general-presentation");
    expect(html).toContain("/office/templates?starter=letterhead");
  });

  it("keeps lifecycle-specific empty collections compact", () => {
    navigation.search = "view=trash";
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeHome workspaceId="11111111-1111-4111-8111-111111111111" initialArtifacts={[]} /></I18nProvider>);
    expect(html).toContain("No Office artifacts yet");
    expect(html).not.toContain("Start with your first templates");
    expect(html).not.toContain("starter=general-presentation");
  });

  it("reflects sidebar-selected lifecycle and family in the top bar breadcrumb", () => {
    navigation.search = "view=trash&family=presentation";
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeHome workspaceId="11111111-1111-4111-8111-111111111111" initialArtifacts={[]} /></I18nProvider>);
    expect(html.indexOf(">Trash<")).toBeGreaterThan(-1);
    expect(html.indexOf(">Trash<")).toBeLessThan(html.indexOf(">Presentations<"));
    expect(html).not.toContain("data-office-filter-bar");
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

  it("marks a version-zero artifact with no job as a failed start", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeHome workspaceId="11111111-1111-4111-8111-111111111111" initialArtifacts={[
      { artifactId: "44444444-4444-4444-8444-444444444444", family: "presentation", mode: "artifact", title: "Company introduction", version: 0, lifecycleState: "active", role: "edit" },
    ]} /></I18nProvider>);
    expect(html).toContain("Start failed");
    expect(html).not.toContain(">Working<");
  });

  it("recovers an empty shell when an older API serializes bigint zero as a string", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeHome workspaceId="11111111-1111-4111-8111-111111111111" initialArtifacts={[
      { artifactId: "55555555-5555-4555-8555-555555555555", family: "presentation", mode: "artifact", title: "Company introduction", version: "0" as unknown as number, lifecycleState: "active", role: "edit" },
    ]} /></I18nProvider>);
    expect(html).toContain("Start failed");
    expect(html).not.toContain(">Working<");
  });
});
