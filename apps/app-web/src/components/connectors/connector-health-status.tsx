"use client";

import type { Connector } from "@/lib/api/connectors";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/** One health signal for the rail and every connector detail panel. */
export function ConnectorHealthStatus({
  connector,
  builtin = false,
  compact = false,
}: {
  connector: Pick<Connector, "connected" | "healthStatus">;
  builtin?: boolean;
  compact?: boolean;
}) {
  const tc = useT().settings.connectors;
  const needsReconnect = !builtin && connector.connected && connector.healthStatus === "auth_failed";
  const degraded = !builtin && connector.connected && connector.healthStatus === "degraded";
  const attention = needsReconnect || degraded;
  const label = builtin ? tc.builtinPill
    : needsReconnect ? tc.reconnectNeeded
      : degraded ? tc.healthDegradedPill
        : connector.connected ? tc.connected : tc.disconnected;

  return (
    <span
      role="status"
      aria-label={label}
      title={compact ? label : undefined}
      className={cn(
        "shrink-0",
        compact ? "h-1.5 w-1.5 rounded-full" : "rounded-full px-2 py-0.5 text-xs font-medium",
        attention
          ? compact ? "bg-amber-500" : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
          : builtin || connector.connected
            ? compact ? "bg-primary" : "bg-primary/10 text-primary"
            : compact ? "bg-muted-foreground" : "bg-muted text-muted-foreground",
      )}
    >
      {compact ? <span className="sr-only">{label}</span> : label}
    </span>
  );
}
