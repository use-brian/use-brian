import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

const navigation = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(navigation.query) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a>,
}));

import { OrganizationSidebarPanel } from "../organization-sidebar-panel";

function render(query: string) {
  navigation.query = query;
  return renderToStaticMarkup(
    <I18nProvider locale="en" dict={en}>
      <OrganizationSidebarPanel workspaceId="workspace-1" />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/sidebar-panel-organization] Organization sidebar panel", () => {
  it("lists the four canonical sections with their destinations", () => {
    const html = render("");
    expect(html).toContain(`aria-label="${en.organization.sectionsAriaLabel}"`);
    for (const href of [
      "/w/workspace-1/organization",
      "/w/workspace-1/organization?section=people",
      "/w/workspace-1/organization?section=departments",
      "/w/workspace-1/organization?section=access",
    ]) expect(html).toContain(`href="${href}"`);
    for (const label of [en.organization.structureTab, en.organization.peopleTab, en.organization.departmentsTab, en.organization.accessTab]) expect(html).toContain(label);
  });

  it("marks exactly the URL-selected section and falls back to Structure", () => {
    expect(render("section=access").match(/aria-current="page"/g)).toHaveLength(1);
    expect(render("section=access")).toMatch(/href="\/w\/workspace-1\/organization\?section=access" aria-current="page"/);
    expect(render("section=unknown")).toMatch(/href="\/w\/workspace-1\/organization" aria-current="page"/);
  });

  it("is the sidebar body while Organization is the active surface", () => {
    const source = readFileSync(new URL("../../doc-sidebar.tsx", import.meta.url), "utf8");
    expect(source).toContain('sidebarSurface === "organization" ? (\n          <OrganizationSidebarPanel workspaceId={workspaceId} />');
  });
});
