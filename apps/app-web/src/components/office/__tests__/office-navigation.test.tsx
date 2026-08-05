import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), forward: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/doc/doc-sidebar-data", () => ({
  useSidebarData: () => ({ sidebarCollapsed: false, setSidebarCollapsed: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a>,
}));

import { OfficeTopbar } from "../office-topbar";
import { OfficeTemplateCard, OfficeTemplateLibrary, officeTemplateNameFromFile, readOfficeStarterTemplate } from "../template-library";

function wrap(node: React.ReactNode) {
  return renderToStaticMarkup(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>);
}

describe("[COMP:app-web/office-navigation] Office route chrome", () => {
  it("renders a visible Office-home breadcrumb and nested route segments", () => {
    const html = wrap(<OfficeTopbar workspaceId="workspace-1" breadcrumbs={[{ label: "Templates", href: "/w/workspace-1/office/templates" }, { label: "Sales deck" }]} right={<span>RIGHT</span>} />);
    expect(html).toContain('aria-label="Office breadcrumbs"');
    expect(html).toContain('href="/w/workspace-1/office"');
    expect(html).toContain('href="/w/workspace-1/office/templates"');
    expect(html).toContain("Sales deck");
    expect(html).toContain("RIGHT");
  });

  it("accepts only the supported starter-template deep links", () => {
    expect(readOfficeStarterTemplate(new URLSearchParams("starter=general-presentation"))).toBe("general-presentation");
    expect(readOfficeStarterTemplate(new URLSearchParams("starter=letterhead"))).toBe("letterhead");
    expect(readOfficeStarterTemplate(new URLSearchParams("starter=unknown"))).toBeNull();
    expect(readOfficeStarterTemplate(new URLSearchParams())).toBeNull();
  });

  it("offers exactly Upload and guided Generate as template creation paths", () => {
    expect(officeTemplateNameFromFile("Company overview.pptx")).toBe("Company overview");
    expect(officeTemplateNameFromFile("Letterhead.DOCX")).toBe("Letterhead");
    const html = wrap(<OfficeTemplateLibrary workspaceId="workspace-1" />);
    expect(html).toContain("Upload template");
    expect(html).toContain("Generate template");
    expect(html).not.toContain("New template");
  });

  it("renders visual template cards with explicit Document and Presentation identities", () => {
    const base = { lifecycleState: "admitted" as const, currentVersionId: "version-1", sensitivity: "internal" as const, updatedAt: "2026-08-05T00:00:00.000Z" };
    const html = wrap(<div>
      <OfficeTemplateCard workspaceId="workspace-1" template={{ ...base, id: "doc-template", family: "document", name: "Letterhead", description: "Company letters", draftArtifactId: "doc-artifact" }} />
      <OfficeTemplateCard workspaceId="workspace-1" template={{ ...base, id: "ppt-template", family: "presentation", name: "Company deck", description: "Company presentations", draftArtifactId: "ppt-artifact" }} />
    </div>);
    expect(html).toContain('data-office-template-card="document"');
    expect(html).toContain('data-office-template-family="presentation"');
    expect(html).toContain('data-office-card-preview-shell="document"');
    expect(html).toContain('href="/w/workspace-1/office/templates/ppt-template"');
    expect(html).toContain('href="/w/workspace-1/office/new?templateId=ppt-template&amp;templateVersionId=version-1"');
    expect(html).toContain("Use template");
    expect(html).toContain("Document");
    expect(html).toContain("Presentation");
  });

  it("keeps draft templates in the shared editor but blocks artifact creation", () => {
    const html = wrap(<OfficeTemplateCard workspaceId="workspace-1" template={{ id: "draft-template", family: "document", name: "Draft", description: "Work in progress", lifecycleState: "draft", currentVersionId: null, draftArtifactId: "draft-artifact", sensitivity: "internal", updatedAt: "2026-08-05T00:00:00.000Z" }} />);
    expect(html).toContain('href="/w/workspace-1/office/draft-artifact?templateId=draft-template"');
    expect(html).toContain("Edit template");
    expect(html).not.toContain("Use template");
  });
});
