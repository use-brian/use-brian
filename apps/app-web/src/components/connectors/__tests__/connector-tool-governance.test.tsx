// @vitest-environment jsdom
/**
 * [COMP:app-web/connector-tool-governance] + [COMP:app-web/connector-tool-list]
 * Merged per-connector governance table (Studio -> Assistants -> Tools).
 *
 * SSR (renderToString) assertions on the initial render — effects never run,
 * so no grant / workspace-policy fetch fires. Covered:
 *   - ConnectorToolList: the "Granted" segment-style toggle (never a native
 *     checkbox) — enabled for writes, disabled active box for reads; the
 *     ungranted-write outer-gate state greying the Allow/Ask/Block control
 *     while keeping the uniform four-box layout; `policyDisabled` read-only
 *     mode; and the legacy no-grants rendering (L1 page unchanged).
 *   - ConnectorToolGovernance: grants toggle for official connectors with
 *     write tools, policy-only fallback for built-ins and custom MCPs,
 *     team-native rows keeping a live Allow/Ask/Block (workspace-backed) with
 *     the workspace hint variant, and the Sales preset affordance for gmail.
 */

import { describe, expect, it } from "vitest";
import { type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { ConnectorToolList, type ConnectorToolListItem, type ToolGrantState } from "../connector-tool-list";
import { ConnectorToolGovernance } from "../connector-tool-governance";

const dict = en as unknown as Dictionary;

function wrap(node: ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

const githubTools: ConnectorToolListItem[] = [
  { name: "githubListIssues", description: "List issues", classification: "read", currentPolicy: "allow" },
  { name: "githubCreateIssue", description: "Create a new issue", classification: "write", currentPolicy: "ask" },
];

function grants(allowed: string[]): ToolGrantState {
  return { allowed: new Set(allowed), saving: false, onToggle: () => {} };
}

describe("[COMP:app-web/connector-tool-list] granted toggle + policy segments", () => {
  it("renders a segment-style Granted toggle per row — no native checkbox anywhere", () => {
    const html = wrap(
      <ConnectorToolList connectorId="github" tools={githubTools} onPolicyChange={() => {}} grants={grants([])} />,
    );
    expect(html).not.toContain('type="checkbox"');
    // Write tool: enabled toggle, un-granted (aria-pressed false).
    expect(html).toContain('data-grant-toggle="github:githubCreateIssue"');
    // Read tool: disabled active box, explained via title only (no text bloat).
    expect(html).toContain('data-grant-toggle="github:githubListIssues"');
    expect(html).toContain(`title="${en.connectorToolList.alwaysAvailable}"`);
    const readToggle = html.split('data-grant-toggle="github:githubListIssues"')[0].split("<button").pop() ?? "";
    expect(readToggle).toContain("disabled");
    expect(readToggle).toContain('aria-pressed="true"');
  });

  it("greys out Allow/Ask/Block for an ungranted write but keeps the uniform layout", () => {
    const ungranted = wrap(
      <ConnectorToolList
        connectorId="github"
        tools={githubTools.filter((t) => t.name === "githubCreateIssue")}
        onPolicyChange={() => {}}
        grants={grants([])}
      />,
    );
    // The policy control still renders (uniform boxes) but every segment is
    // disabled, with the outer-gate reason on the container title.
    expect(ungranted).toContain(en.connectorToolList.allow);
    expect(ungranted).toContain(`title="${en.connectorToolList.notGranted}"`);
    const segments = ungranted.split(`title="${en.connectorToolList.notGranted}"`)[1] ?? "";
    expect(segments).toContain("cursor-not-allowed");

    const granted = wrap(
      <ConnectorToolList
        connectorId="github"
        tools={githubTools.filter((t) => t.name === "githubCreateIssue")}
        onPolicyChange={() => {}}
        grants={grants(["githubCreateIssue"])}
      />,
    );
    expect(granted).not.toContain(`title="${en.connectorToolList.notGranted}"`);
    expect(granted).not.toContain("cursor-not-allowed");
  });

  it("renders the policy control read-only under policyDisabled", () => {
    const html = wrap(
      <ConnectorToolList
        connectorId="github"
        tools={githubTools}
        onPolicyChange={() => {}}
        grants={grants(["githubCreateIssue"])}
        policyDisabled
      />,
    );
    expect(html).toContain("cursor-not-allowed");
  });

  it("renders the legacy policy-only list when no grants prop is passed (L1 page unchanged)", () => {
    const html = wrap(
      <ConnectorToolList connectorId="github" tools={githubTools} onPolicyChange={() => {}} />,
    );
    expect(html).not.toContain("data-grant-toggle");
    expect(html).toContain('aria-pressed');
  });
});

describe("[COMP:app-web/connector-tool-governance] governance wrapper", () => {
  it("renders the grants hint and Granted toggles for an official connector with write tools", () => {
    const html = wrap(
      <ConnectorToolGovernance
        assistantId="a-1"
        connectorId="github"
        scope="personal"
        tools={githubTools}
        onPolicyChange={() => {}}
      />,
    );
    expect(html).toContain(en.connectorToolList.grantsHint);
    expect(html).toContain('data-grant-toggle="github:githubCreateIssue"');
  });

  it("keeps a live Allow/Ask/Block on team-native rows, with the workspace hint variant", () => {
    const html = wrap(
      <ConnectorToolGovernance
        assistantId="a-1"
        connectorId="github"
        scope="team-native"
        workspaceId="ws-1"
        instanceId="ci-1"
        tools={githubTools}
        onPolicyChange={() => {}}
      />,
    );
    expect(html).toContain(en.connectorToolList.grantsHintWorkspace);
    // The policy segments render (workspace-backed), defaulting to 'ask'.
    expect(html).toContain(en.connectorToolList.allow);
    expect(html).toContain('aria-pressed');
    // Capability column stays per-assistant.
    expect(html).toContain('data-grant-toggle="github:githubCreateIssue"');
  });

  it("falls back to the policy-only list for built-in primitives and custom MCPs", () => {
    const builtin = wrap(
      <ConnectorToolGovernance
        assistantId="a-1"
        connectorId="files"
        scope="builtin"
        tools={[{ name: "fileWrite", classification: "write", currentPolicy: "ask" }]}
        onPolicyChange={() => {}}
      />,
    );
    expect(builtin).not.toContain(en.connectorToolList.grantsHint);
    expect(builtin).not.toContain("data-grant-toggle");

    const custom = wrap(
      <ConnectorToolGovernance
        assistantId="a-1"
        connectorId="my-custom-mcp"
        scope="personal"
        tools={[{ name: "someWriteTool", classification: "write", currentPolicy: "ask" }]}
        onPolicyChange={() => {}}
      />,
    );
    expect(custom).not.toContain(en.connectorToolList.grantsHint);
    expect(custom).not.toContain("data-grant-toggle");
  });

  it("offers the Sales preset for gmail", () => {
    const html = wrap(
      <ConnectorToolGovernance
        assistantId="a-1"
        connectorId="gmail"
        scope="personal"
        tools={[{ name: "gmailSendMessage", classification: "write", currentPolicy: "ask" }]}
        onPolicyChange={() => {}}
      />,
    );
    expect(html).toContain(en.connectorToolList.salesPreset);
  });
});
