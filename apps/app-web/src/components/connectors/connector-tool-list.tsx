"use client";

/**
 * Shared tool-list renderer for the Connectors UI (app-web).
 *
 * Ported from `apps/web/src/components/connectors/connector-tool-list.tsx`
 * (app consolidation §9 #5). Used by Studio -> Assistants -> Tools to render
 * the per-assistant L2 tool policy. Strings flow through `t.connectorToolList`.
 *
 * Props model:
 *   - `currentPolicy`  — the policy button to highlight.
 *   - `minStrictness`  — (L2 only) app-level floor. Buttons looser than this
 *                        are disabled; when 'block', the whole control is
 *                        replaced by a "Blocked by app" label.
 *
 * Gdrive tools (17 across Drive/Docs/Sheets/Slides) are auto-grouped into
 * per-service cards so the list isn't a wall.
 *
 * [COMP:app-web/connector-tool-list]
 */

import { GDRIVE_GROUPS, gdriveToolGroup, type GdriveGroupId } from "./gdrive-groups";
import { useT } from "@/lib/i18n/client";

export type ToolPolicy = "allow" | "ask" | "block";
type ToolClassification = "read" | "write" | "destructive" | "unknown";

export type ConnectorToolListItem = {
  name: string;
  description?: string;
  classification: ToolClassification;
  /** Policy to highlight (for L2: effectivePolicy; for L1: policy). */
  currentPolicy: ToolPolicy;
  /** Optional app-level floor. Unset = all three buttons clickable. */
  minStrictness?: ToolPolicy;
};

const STRICTNESS: Record<ToolPolicy, number> = { allow: 0, ask: 1, block: 2 };

export function ConnectorToolList({
  connectorId,
  tools,
  loading,
  onPolicyChange,
}: {
  connectorId: string;
  tools: ConnectorToolListItem[];
  loading?: boolean;
  onPolicyChange: (toolName: string, policy: ToolPolicy) => void;
}) {
  const t = useT();
  if (loading) {
    return (
      <div className="rounded-lg border border-border px-4 py-5 text-center text-xs text-muted-foreground">
        {t.connectorToolList.discovering}
      </div>
    );
  }

  if (!tools.length) {
    return (
      <div className="rounded-lg border border-border px-4 py-5 text-center text-xs text-muted-foreground">
        {t.connectorToolList.noTools}
      </div>
    );
  }

  if (connectorId === "gdrive") {
    const grouped: Record<GdriveGroupId, ConnectorToolListItem[]> = {
      drive: [], docs: [], sheets: [], slides: [], other: [],
    };
    for (const tool of tools) grouped[gdriveToolGroup(tool.name)].push(tool);

    return (
      <div className="space-y-2">
        {GDRIVE_GROUPS.map(({ id, label }) => {
          const groupTools = grouped[id];
          if (groupTools.length === 0) return null;
          return (
            <div key={id} className="rounded-lg border border-border overflow-hidden">
              <div className="flex items-center justify-between gap-2 bg-muted/40 px-4 py-1.5 border-b border-border">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
                <span className="text-[10px] text-muted-foreground/60">{groupTools.length}</span>
              </div>
              <div className="divide-y divide-border">
                {groupTools.map((tool) => (
                  <ToolRow key={tool.name} tool={tool} onPolicyChange={onPolicyChange} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="divide-y divide-border">
        {tools.map((tool) => (
          <ToolRow key={tool.name} tool={tool} onPolicyChange={onPolicyChange} />
        ))}
      </div>
    </div>
  );
}

function ToolRow({
  tool,
  onPolicyChange,
}: {
  tool: ConnectorToolListItem;
  onPolicyChange: (toolName: string, policy: ToolPolicy) => void;
}) {
  const t = useT();
  const floor = tool.minStrictness;
  const floorBlocked = floor === "block";
  const classLabel = tool.classification === "read" ? t.connectorToolList.classRead
    : tool.classification === "write" ? t.connectorToolList.classWrite
    : tool.classification === "destructive" ? t.connectorToolList.classDestructive
    : t.connectorToolList.classUnknown;

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium truncate">{tool.name}</span>
          <span className={`text-[9px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded ${
            tool.classification === "read" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" :
            tool.classification === "write" ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" :
            tool.classification === "destructive" ? "bg-destructive/10 text-destructive" :
            "bg-muted text-muted-foreground"
          }`}>
            {classLabel}
          </span>
        </div>
        {tool.description && (
          <div className="text-[11px] text-muted-foreground truncate mt-0.5">{tool.description}</div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {floorBlocked ? (
          <span className="text-[10px] text-destructive font-medium">{t.connectorToolList.blockedByApp}</span>
        ) : (
          /* Segmented control on theme tokens (the brain-topbar List|Graph
             recipe): the active segment lifts onto `bg-background` with a
             semantic-tinted label, so it stays legible in dark mode and under
             custom palettes — never a raw color fill. */
          <div className="flex items-center bg-muted rounded-md p-0.5">
            {(["allow", "ask", "block"] as const).map((p) => {
              const disabled = floor !== undefined && STRICTNESS[p] < STRICTNESS[floor];
              const active = tool.currentPolicy === p;
              const label = p === "allow" ? t.connectorToolList.allow : p === "ask" ? t.connectorToolList.ask : t.connectorToolList.block;
              return (
                <button
                  key={p}
                  disabled={disabled}
                  aria-pressed={active}
                  onClick={() => onPolicyChange(tool.name, p)}
                  className={`text-[11px] font-medium px-2 py-0.5 rounded transition-colors ${
                    active
                      ? `bg-background shadow-sm ${
                          p === "allow" ? "text-emerald-600 dark:text-emerald-400"
                            : p === "ask" ? "text-amber-600 dark:text-amber-400"
                            : "text-destructive"
                        }`
                      : disabled
                        ? "text-muted-foreground/40 cursor-not-allowed"
                        : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
