"use client";

/**
 * Merged per-connector governance table for an assistant (app-web).
 *
 * Replaces the former two-panel layout (ConnectorToolList policy editor +
 * ConnectorActionGrants checkbox section) with ONE table per connector: each
 * row carries a "Granted" toggle box (per-assistant write grants from
 * `assistant_connector_grants`, binding every caller of the assistant) ahead
 * of the Allow/Ask/Block confirmation control. Sits inside the expanded
 * connector row in Studio -> Assistants -> Tools.
 *
 * Grant state is fetched from GET /api/assistant-connector-grants/:assistantId
 * and persisted via PATCH /api/assistant-connector-grants/:assistantId/:connectorId.
 * The write-tool catalog comes from `@use-brian/shared`'s
 * `OFFICIAL_CONNECTOR_TOOLS` (the single source of truth; the same registry
 * `gateToolsOnActionGrants` derives the runtime gate from) — custom MCP
 * connectors are not in the registry, so they render policy-only, matching
 * the runtime (no grant gate on custom MCP tools). Built-in primitives pass
 * `scope='builtin'` and also render policy-only: their writes are governed
 * by per-tool policy, not the grant table.
 *
 * A team-native connector's Allow/Ask/Block edits the SHARED workspace
 * policy (`workspace_tool_policy`) through the clearance-gated routes on
 * `/api/workspaces/:workspaceId/connectors/:instanceId/...` — the same rows
 * the runtime resolves, so the control is live, not a dead per-user toggle.
 * A viewer without connector clearance sees the control read-only. The
 * capability column stays fully per-assistant regardless of connector scope.
 *
 * [COMP:app-web/connector-tool-governance]
 *
 * See `docs/architecture/integrations/connector-actions.md` ->
 * "Per-assistant capability grants".
 */

import { useEffect, useState, useCallback } from "react";
import { authFetch } from "@/lib/auth-fetch";
import {
  OFFICIAL_CONNECTOR_TOOLS,
} from "@use-brian/shared/builtin-connectors";
import { useT } from "@/lib/i18n/client";
import {
  ConnectorToolList,
  type ConnectorToolListItem,
  type ToolPolicy,
} from "./connector-tool-list";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

type Grant = {
  id: string;
  assistantId: string;
  connectorId: string;
  readAllowed: boolean;
  allowedActions: string[];
};

const SALES_PRESET_ACTIONS: Record<string, string[]> = {
  gmail: ["gmailSendMessage"],
  gcal: ["googleCalendarCreateEvent", "googleCalendarUpdateEvent"],
};

/** Workspace tool policy default when no row exists (mirrors the runtime). */
const WORKSPACE_POLICY_DEFAULT: ToolPolicy = "ask";

export function ConnectorToolGovernance({
  assistantId,
  connectorId,
  scope,
  tools,
  loading,
  onPolicyChange,
  workspaceId,
  instanceId,
}: {
  assistantId: string;
  connectorId: string;
  /** Connector scope from GET /api/assistants/:id/connectors. */
  scope?: string;
  tools: ConnectorToolListItem[];
  loading?: boolean;
  /** Per-user (L2) policy save — used for every scope except team-native. */
  onPolicyChange: (toolName: string, policy: ToolPolicy) => void;
  /** Required for team-native rows: the workspace + connector_instance the
   *  shared policy routes are keyed by. */
  workspaceId?: string | null;
  instanceId?: string;
}) {
  const t = useT();
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [grantsLoading, setGrantsLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const teamNative = scope === "team-native" && Boolean(workspaceId) && Boolean(instanceId);
  const [wsPolicies, setWsPolicies] = useState<Record<string, ToolPolicy>>({});
  const [wsPolicyReadOnly, setWsPolicyReadOnly] = useState(false);

  // Grants apply to official external connectors only — custom MCPs are not
  // in the registry (no runtime gate), built-in primitives are governed by
  // per-tool policy alone.
  const grantableTools = (OFFICIAL_CONNECTOR_TOOLS[connectorId] ?? []).filter(
    (tool) => tool.classification === "write" || tool.classification === "destructive",
  );
  const grantsApply = scope !== "builtin" && grantableTools.length > 0;

  const fetchGrant = useCallback(() => {
    if (!grantsApply) { setGrantsLoading(false); return; }
    authFetch(`${API_URL}/api/assistant-connector-grants/${assistantId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { grants?: Grant[] } | null) => {
        const grant = data?.grants?.find((g) => g.connectorId === connectorId);
        setAllowed(new Set(grant?.allowedActions ?? []));
      })
      .catch(() => setAllowed(new Set()))
      .finally(() => setGrantsLoading(false));
  }, [assistantId, connectorId, grantsApply]);

  useEffect(() => {
    fetchGrant();
  }, [fetchGrant]);

  // Team-native: the shared workspace policy is the live source; the parent's
  // per-user L2 values would be dead here (the runtime ignores them).
  const fetchWsPolicies = useCallback(() => {
    if (!teamNative) return;
    authFetch(
      `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId!)}/connectors/${instanceId}/tool-policies`,
    )
      .then(async (r) => {
        if (!r.ok) {
          // 403 = viewer lacks connector clearance — show read-only.
          setWsPolicyReadOnly(true);
          return;
        }
        const data = (await r.json()) as { policies?: Array<{ toolName: string; policy: ToolPolicy }> };
        const map: Record<string, ToolPolicy> = {};
        for (const p of data.policies ?? []) map[p.toolName] = p.policy;
        setWsPolicies(map);
        setWsPolicyReadOnly(false);
      })
      .catch(() => setWsPolicyReadOnly(true));
  }, [teamNative, workspaceId, instanceId]);

  useEffect(() => {
    fetchWsPolicies();
  }, [fetchWsPolicies]);

  async function handleWsPolicyChange(toolName: string, policy: ToolPolicy) {
    const prev = wsPolicies;
    setWsPolicies({ ...prev, [toolName]: policy });
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId!)}/connectors/${instanceId}/tools/${encodeURIComponent(toolName)}/policy`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ policy }),
        },
      );
      if (!res.ok) {
        setWsPolicies(prev);
        if (res.status === 403) setWsPolicyReadOnly(true);
      }
    } catch {
      setWsPolicies(prev);
    }
  }

  async function persist(next: Set<string>) {
    setSaving(true);
    try {
      const res = await authFetch(
        `${API_URL}/api/assistant-connector-grants/${assistantId}/${connectorId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            readAllowed: true,
            allowedActions: Array.from(next),
          }),
        },
      );
      if (!res.ok) {
        // Revert on failure
        fetchGrant();
      }
    } finally {
      setSaving(false);
    }
  }

  async function toggleAction(toolName: string) {
    const next = new Set(allowed);
    if (next.has(toolName)) {
      next.delete(toolName);
    } else {
      next.add(toolName);
    }
    setAllowed(next);
    await persist(next);
  }

  async function applySalesPreset() {
    const preset = SALES_PRESET_ACTIONS[connectorId];
    if (!preset) return;
    const next = new Set(allowed);
    for (const action of preset) {
      next.add(action);
    }
    setAllowed(next);
    await persist(next);
  }

  // Team-native rows swap in the shared workspace values: no per-user floor
  // semantics apply (workspace policy IS the whole resolution).
  const effectiveTools = teamNative
    ? tools.map((tool) => ({
        ...tool,
        currentPolicy: wsPolicies[tool.name] ?? WORKSPACE_POLICY_DEFAULT,
        minStrictness: undefined,
      }))
    : tools;

  if (!grantsApply) {
    return (
      <ConnectorToolList
        connectorId={connectorId}
        tools={effectiveTools}
        loading={loading}
        onPolicyChange={teamNative ? handleWsPolicyChange : onPolicyChange}
        policyDisabled={teamNative && wsPolicyReadOnly}
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] text-muted-foreground leading-relaxed flex-1">
          {teamNative ? t.connectorToolList.grantsHintWorkspace : t.connectorToolList.grantsHint}
        </p>
        {SALES_PRESET_ACTIONS[connectorId] && (
          <button
            type="button"
            onClick={applySalesPreset}
            disabled={saving || grantsLoading}
            className="text-[11px] text-primary hover:underline font-medium disabled:opacity-50 shrink-0"
          >
            {t.connectorToolList.salesPreset}
          </button>
        )}
      </div>
      <ConnectorToolList
        connectorId={connectorId}
        tools={effectiveTools}
        loading={loading}
        onPolicyChange={teamNative ? handleWsPolicyChange : onPolicyChange}
        grants={{
          allowed,
          saving: saving || grantsLoading,
          onToggle: toggleAction,
        }}
        policyDisabled={teamNative && wsPolicyReadOnly}
      />
    </div>
  );
}
