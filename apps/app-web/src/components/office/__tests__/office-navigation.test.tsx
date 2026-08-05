import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), forward: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/doc/doc-sidebar-data", () => ({
  useSidebarData: () => ({ sidebarCollapsed: false, setSidebarCollapsed: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a>,
}));

import { OfficeTopbar } from "../office-topbar";
import { OfficeCreate } from "../office-create";

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

  it("gives the direct Create page explicit navigation and cancellation", () => {
    const html = wrap(<OfficeCreate workspaceId="workspace-1" />);
    expect(html).toContain("Create with Brian");
    expect(html).toContain("Back to Office");
    expect(html).toContain("Cancel");
    expect(html).toContain("Generate");
  });
});
