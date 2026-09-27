import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

const navigation = vi.hoisted(() => ({ search: "", workspaceId: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), forward: vi.fn(), prefetch: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock("@/components/doc/doc-sidebar-data", () => ({ useSidebarData: () => ({ sidebarCollapsed: false, setSidebarCollapsed: vi.fn() }) }));
import { OfficeHome as RealOfficeHome } from "../office-home";
import { attachOfficeMetadata } from "@/lib/office/metadata";
import type { OfficeArtifact } from "@/lib/office/api";
vi.mock("@/lib/workspace-context", () => ({useOptionalWorkspaceContext: () => ({workspaceId: navigation.workspaceId, me: {id: "fixture-viewer"}})}));
function OfficeHome(props: {workspaceId: string; initialArtifacts?: OfficeArtifact[]}) {
  navigation.workspaceId = props.workspaceId;
  return <RealOfficeHome {...props} initialArtifacts={attachOfficeMetadata(props.initialArtifacts ?? [],30_000,performance.now(),"fixture-viewer")} />;
}

describe("[COMP:app-web/office-home] Office home", () => {
  beforeEach(() => {
    navigation.search = "";
  });

  it("keeps file-type filters and template-first New in the top bar", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeHome workspaceId="11111111-1111-4111-8111-111111111111" initialArtifacts={[]} /></I18nProvider>);
    expect(html).not.toContain("data-office-filter-bar");
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain(">Active<");
    expect(html).toContain(">All<");
    expect(html).toContain(">Files<");
    expect(html).toContain("Choose a template to create your first file");
    expect(html).toContain('href="/w/11111111-1111-4111-8111-111111111111/office/new"');
    expect(html).not.toContain("templates?intent=use");
    expect(html).not.toContain("General presentation");
    expect(html).not.toContain("Letterhead");
    expect(html).not.toContain(">Import<");
  });

  it("keeps lifecycle-specific empty collections compact", () => {
    navigation.search = "view=trash";
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeHome workspaceId="11111111-1111-4111-8111-111111111111" initialArtifacts={[]} /></I18nProvider>);
    expect(html).toContain("No Office artifacts yet");
    expect(html).not.toContain("Choose a template to create your first file");
    expect(html).not.toContain("starter=");
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
    expect(html).toContain('data-office-file-grid="true"');
    expect(html).toContain('grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]');
    expect(html.match(/data-office-file-card-footer="true"/g)).toHaveLength(2);
  });

  it.each(["", "family=document", "view=trash", "view=retained", "view=archived"])("excludes cached template shells but preserves failed normal imports (%s)", (search) => {
    navigation.search = search;
    const common = { family: "document" as const, version: 0, lifecycleState: "active" as const, role: "edit" as const, job: { id: "failed-job", status: "failed" as const, stage: "failed", errorCode: null } };
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeHome workspaceId="workspace" initialArtifacts={[
      { ...common, artifactId: "template-shell", mode: "template", title: "Deleted template shell" },
      { ...common, artifactId: "normal-import", mode: "artifact", title: "Failed normal import" },
    ]} /></I18nProvider>);
    expect(html).not.toContain("Deleted template shell");
    expect(html).toContain("Failed normal import");
    expect(html).toContain(">Failed<");
    expect(html.match(/data-office-file-card-footer="true"/g)).toHaveLength(1);
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

  it("shows a typed presentation-fit reason instead of only Failed", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeHome workspaceId="11111111-1111-4111-8111-111111111111" initialArtifacts={[
      { artifactId: "66666666-6666-4666-8666-666666666666", family: "presentation", mode: "artifact", title: "Company introduction", version: 0, lifecycleState: "active", role: "edit", job: { id: "77777777-7777-4777-8777-777777777777", status: "failed", stage: "failed", errorCode: "presentation_fit_failed" } },
    ]} /></I18nProvider>);
    expect(html).toContain(en.office.presentationFitFailed);
    expect(html).not.toContain(">Failed<");
  });

  it("shows a typed presentation-plan reason on the file card", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeHome workspaceId="11111111-1111-4111-8111-111111111111" initialArtifacts={[
      { artifactId: "88888888-8888-4888-8888-888888888888", family: "presentation", mode: "artifact", title: "Company introduction", version: 0, lifecycleState: "active", role: "edit", job: { id: "99999999-9999-4999-8999-999999999999", status: "failed", stage: "failed", errorCode: "presentation_plan_failed" } },
    ]} /></I18nProvider>);
    expect(html).toContain(en.office.presentationPlanFailed);
    expect(html).not.toContain(">Failed<");
  });
});
