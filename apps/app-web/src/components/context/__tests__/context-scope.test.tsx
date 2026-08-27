import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ContextScopeChips } from "../context-scope-chips";
import { ContextScopePicker } from "../context-scope-picker";
import type { ContextProject, ContextTeam } from "@/lib/api/context-scopes";

vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: ({
    value,
    items,
    disabled,
  }: {
    value: string;
    items: Array<{ value: string; label: string }>;
    disabled?: boolean;
  }) => (
    <div data-picker-value={value} data-picker-disabled={disabled ? "true" : "false"}>
      {items.map((item) => <span key={item.value}>{item.label}</span>)}
    </div>
  ),
}));

const TEAM: ContextTeam = {
  id: "team-1",
  name: "Accounting",
  key: "accounting",
  description: null,
  color: null,
  status: "active",
  readAll: false,
  readGrantGroupIds: [],
  memberCount: 2,
};

const PROJECT: ContextProject = {
  id: "project-1",
  workspaceId: "workspace-1",
  name: "Atlas",
  normalizedName: "atlas",
  description: null,
  icon: null,
  status: "active",
  entityId: null,
};

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" dict={en}>{node}</I18nProvider>,
  );
}

describe("[COMP:app-web/context-scope] stable picker and chips", () => {
  it("shows human labels for stable ids without leaking raw identifiers", () => {
    const html = render(
      <ContextScopeChips
        teamId={TEAM.id}
        projectId={PROJECT.id}
        teams={[TEAM]}
        projects={[PROJECT]}
      />,
    );
    expect(html).toContain("Accounting");
    expect(html).toContain("Atlas");
    expect(html).not.toContain(TEAM.id);
    expect(html).not.toContain(PROJECT.id);
  });

  it("renders Company-wide when neither axis is bound", () => {
    expect(render(
      <ContextScopeChips teamId={null} projectId={null} teams={[TEAM]} projects={[PROJECT]} />,
    )).toContain("Company-wide");
  });

  it("never labels an undisclosed legacy requirement as Company-wide", () => {
    const html = render(
      <ContextScopeChips
        teamIds={[]}
        projectIds={[]}
        hasRestrictedContext
        teams={[TEAM]}
        projects={[PROJECT]}
      />,
    );
    expect(html).toContain("Additional restricted context");
    expect(html).not.toContain("Company-wide");
  });

  it("filters archived registries and can lock each immutable axis independently", () => {
    const html = render(
      <ContextScopePicker
        teams={[TEAM, { ...TEAM, id: "team-archived", name: "Old Team", status: "archived" }]}
        projects={[PROJECT, { ...PROJECT, id: "project-archived", name: "Old Project", status: "archived" }]}
        teamId={TEAM.id}
        projectId={null}
        teamDisabled
        onTeamChange={vi.fn()}
        onProjectChange={vi.fn()}
      />,
    );
    expect(html).toContain("Accounting");
    expect(html).toContain("Atlas");
    expect(html).not.toContain("Old Team");
    expect(html).not.toContain("Old Project");
    expect(html.match(/data-picker-disabled="true"/g)).toHaveLength(1);
    expect(html.match(/data-picker-disabled="false"/g)).toHaveLength(1);
  });
});
