import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a>,
}));

import { OfficeSidebarNavigation } from "../office-sidebar-panel";

function render(pathname: string, search = "") {
  return renderToStaticMarkup(
    <I18nProvider locale="en" dict={en}>
      <OfficeSidebarNavigation workspaceId="workspace-1" pathname={pathname} searchParams={new URLSearchParams(search)} />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/office-navigation] Office sidebar navigation", () => {
  it("keeps all Office destinations reachable from every Office route", () => {
    const html = render("/w/workspace-1/office/new");
    expect(html).toContain('aria-label="Office navigation"');
    expect(html).toContain('href="/w/workspace-1/office"');
    expect(html).toContain('href="/w/workspace-1/office/new"');
    expect(html).toContain('href="/w/workspace-1/office/templates"');
    expect(html).toContain('href="/w/workspace-1/office?family=document"');
    expect(html).toContain('href="/w/workspace-1/office?view=trash"');
    expect(html).toContain('aria-current="page"');
  });

  it("marks URL-backed family and lifecycle views active", () => {
    const documents = render("/w/workspace-1/office", "family=document");
    expect(documents).toMatch(/href="\/w\/workspace-1\/office\?family=document" aria-current="page"/);
    const archived = render("/w/workspace-1/office", "view=archived");
    expect(archived).toMatch(/href="\/w\/workspace-1\/office\?view=archived" aria-current="page"/);
  });
});
