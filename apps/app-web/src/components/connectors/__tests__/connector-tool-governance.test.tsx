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

  describe("registry-driven tool grouping", () => {
    // renderToString escapes text nodes, so "&" in a label matches as "&amp;".
    const esc = (s: string) => s.replace(/&/g, "&amp;");
    const groupLabels = en.connectorToolList.toolGroups;

    it("renders one card per registry group for shopify, in registry order, skipping empty groups", () => {
      const tools: ConnectorToolListItem[] = [
        { name: "shopifyListProducts", classification: "read", currentPolicy: "allow" },
        { name: "shopifyGetInventoryLevels", classification: "read", currentPolicy: "allow" },
        { name: "shopifyRefundOrder", classification: "destructive", currentPolicy: "ask" },
      ];
      const html = wrap(
        <ConnectorToolList connectorId="shopify" tools={tools} onPolicyChange={() => {}} />,
      );
      const catalogIdx = html.indexOf(esc(groupLabels.catalog));
      const inventoryIdx = html.indexOf(esc(groupLabels.inventory));
      const ordersIdx = html.indexOf(esc(groupLabels.orders));
      expect(catalogIdx).toBeGreaterThan(-1);
      expect(inventoryIdx).toBeGreaterThan(catalogIdx);
      expect(ordersIdx).toBeGreaterThan(inventoryIdx);
      // Groups none of the fetched tools belong to render no card.
      expect(html).not.toContain(esc(groupLabels.finance));
      expect(html).not.toContain(esc(groupLabels.other));
    });

    it("routes tools the registry doesn't know to a trailing Other card", () => {
      const tools: ConnectorToolListItem[] = [
        { name: "shopifyListProducts", classification: "read", currentPolicy: "allow" },
        { name: "shopifyMysteryTool", classification: "unknown", currentPolicy: "ask" },
      ];
      const html = wrap(
        <ConnectorToolList connectorId="shopify" tools={tools} onPolicyChange={() => {}} />,
      );
      const otherIdx = html.indexOf(esc(groupLabels.other));
      expect(otherIdx).toBeGreaterThan(html.indexOf(esc(groupLabels.catalog)));
    });

    it("groups gdrive per service from the registry and keeps ungrouped connectors flat", () => {
      const gdriveTools: ConnectorToolListItem[] = [
        { name: "googleDocsGetContent", classification: "read", currentPolicy: "allow" },
        { name: "googleSheetsReadRange", classification: "read", currentPolicy: "allow" },
      ];
      const grouped = wrap(
        <ConnectorToolList connectorId="gdrive" tools={gdriveTools} onPolicyChange={() => {}} />,
      );
      expect(grouped).toContain(esc(groupLabels.docs));
      expect(grouped).toContain(esc(groupLabels.sheets));

      const flat = wrap(
        <ConnectorToolList connectorId="github" tools={githubTools} onPolicyChange={() => {}} />,
      );
      for (const label of Object.values(groupLabels)) {
        expect(flat).not.toContain(`>${esc(label)}</span>`);
      }
    });
  });

  it("renders one tool table for one independently governed mailbox card", () => {
    const imapTools: ConnectorToolListItem[] = [
      { name: "imapSearchMessages", description: "Search mailbox", classification: "read", currentPolicy: "allow" },
      { name: "imapSendMessage", description: "Send email", classification: "write", currentPolicy: "ask" },
    ];
    const html = wrap(
      <ConnectorToolGovernance
        assistantId="a-1"
        connectorId="imap"
        governanceId="imap:imap-primary"
        scope="team-grant"
        tools={imapTools}
        onPolicyChange={() => {}}
      />,
    );

    expect(html.match(/data-tool-row="imapSearchMessages"/g)).toHaveLength(1);
    expect(html.match(/data-grant-toggle="imap:imapSendMessage"/g)).toHaveLength(1);
    expect(html).not.toContain("data-mailbox-tool-group");
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
