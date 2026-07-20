"use client";

/**
 * Per-tool capability-grant panel for an assistant + connector pair (app-web).
 *
 * Ported from `apps/web/src/components/connectors/connector-action-grants.tsx`
 * (app consolidation §9 #5). Sits inside the expanded connector row in
 * Studio -> Assistants -> Tools. Lists every write/destructive tool for this
 * connector with a checkbox; users toggle which write actions this assistant
 * may perform. Default: all unchecked (the secure default — empty grants = no
 * writes). One-click "Sales preset" pre-checks the typical sales-motion set.
 *
 * Saves via PATCH /api/assistant-connector-grants/:assistantId/:connectorId.
 *
 * The tool catalog is sourced directly from `@use-brian/shared`'s
 * `OFFICIAL_CONNECTOR_TOOLS` (the single source of truth, imported via the
 * `./builtin-connectors` subpath so the server-only `env.js` barrel never
 * reaches the client bundle). No local mirror — same registry as apps/web.
 *
 * [COMP:app-web/connector-action-grants]
 *
 * See `docs/architecture/integrations/connector-actions.md` ->
 * "Per-assistant capability grants".
 */

import { useEffect, useState, useCallback } from "react";
import { authFetch } from "@/lib/auth-fetch";
import {
  OFFICIAL_CONNECTOR_TOOLS,
  type BuiltinConnectorTool,
} from "@use-brian/shared/builtin-connectors";
import { useT } from "@/lib/i18n/client";

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

export function ConnectorActionGrants({
  assistantId,
  connectorId,
}: {
  assistantId: string;
  connectorId: string;
}) {
  const t = useT();
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Built-in only — custom MCP servers don't surface in OFFICIAL_CONNECTOR_TOOLS,
  // so the panel hides itself when the connector isn't in the registry.
  const writeTools: BuiltinConnectorTool[] = (OFFICIAL_CONNECTOR_TOOLS[connectorId] ?? []).filter(
    (tool) => tool.classification === "write" || tool.classification === "destructive",
  );

  const fetchGrant = useCallback(() => {
    authFetch(`${API_URL}/api/assistant-connector-grants/${assistantId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { grants?: Grant[] } | null) => {
        const grant = data?.grants?.find((g) => g.connectorId === connectorId);
        setAllowed(new Set(grant?.allowedActions ?? []));
      })
      .catch(() => setAllowed(new Set()))
      .finally(() => setLoading(false));
  }, [assistantId, connectorId]);

  useEffect(() => {
    fetchGrant();
  }, [fetchGrant]);

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

  if (writeTools.length === 0) return null;

  return (
    <div className="border-t border-border pt-3 mt-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
          {t.assistant.actionGrants.title}
        </p>
        {SALES_PRESET_ACTIONS[connectorId] && (
          <button
            type="button"
            onClick={applySalesPreset}
            disabled={saving}
            className="text-[11px] text-primary hover:underline font-medium disabled:opacity-50"
          >
            {t.assistant.actionGrants.salesPreset}
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        {t.assistant.actionGrants.description}
      </p>
      {loading ? (
        <p className="text-[11px] text-muted-foreground py-1">{t.assistant.actionGrants.loading}</p>
      ) : (
        <ul className="space-y-1.5">
          {writeTools.map((tool) => {
            const checked = allowed.has(tool.name);
            return (
              <li key={tool.name} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id={`grant-${connectorId}-${tool.name}`}
                  checked={checked}
                  disabled={saving}
                  onChange={() => toggleAction(tool.name)}
                  className="h-3.5 w-3.5 rounded border-border cursor-pointer disabled:opacity-50"
                />
                <label
                  htmlFor={`grant-${connectorId}-${tool.name}`}
                  className="text-[12px] flex-1 cursor-pointer"
                >
                  <span className="font-medium text-foreground">{tool.name}</span>
                  <span className="text-muted-foreground ml-2">- {tool.description}</span>
                  {tool.classification === "destructive" && (
                    <span className="ml-2 text-[10px] uppercase tracking-wider font-medium bg-destructive/15 text-destructive px-1.5 py-0.5 rounded">
                      {t.assistant.actionGrants.destructive}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
