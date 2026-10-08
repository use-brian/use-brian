import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { OperatorAppBar } from "../operator-app-bar";
const route = vi.hoisted(() => ({ pathname: "/w/workspace-1/studio" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("@/lib/surface-prefetch", () => ({ useIntentPrefetch: () => () => ({}) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));

describe("[COMP:app-web/operator-app-bar] Home mini apps", () => {
  it.each(["p", "p/page-1", "chat", "tasks", "office", "crm", "feed", "computer", "shopify", "association", "apps/custom-1"])("shows mini apps within Home at %s", (path) => {
    route.pathname = `/w/workspace-1/${path}`;
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en}><OperatorAppBar workspaceId="workspace-1" active={null} homeApps={["tasks", "page", "chat"]} customApps={[]} /></I18nProvider>);
    expect(html).toContain(`aria-label="${en.operatorBar.aria}"`);
    expect(html).not.toContain(en.operatorBar.workspaceApps);
    expect(html).toContain('href="/w/workspace-1/tasks"');
    expect(html).toContain('href="/w/workspace-1/p"');
    expect(html).toContain('href="/w/workspace-1/chat"');
    expect(html).not.toContain('aria-current="page"');
    expect(html).not.toContain('projectId=');
  });
  it.each(["projects", "projects/p1", "organization", "brain", "studio", "workflow", "live"])("hides the complete mini-app row on %s", (path) => {
    route.pathname = `/w/workspace-1/${path}`;
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en}><OperatorAppBar workspaceId="workspace-1" active={null} homeApps={["tasks", "page", "chat"]} customApps={[]} /></I18nProvider>);
    expect(html).toBe("");
  });

});
