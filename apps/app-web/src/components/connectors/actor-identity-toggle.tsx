"use client";

/**
 * Per-connector opt-in for sending the signed-in user's identity
 * (`X-Sidanclaw-Actor-*` headers) to a custom MCP connector. Writes
 * `config.sendActorIdentity`. Default off — the value is PII (email / phone /
 * handle), so it only egresses to connectors the user explicitly enables.
 *
 * Trust posture: the header is trustworthy because the connector authenticates
 * sidanclaw's connection, so we warn when no auth is configured (the identity
 * claim is unverifiable on an open endpoint). See
 * docs/architecture/engine/tool-hooks.md.
 */

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { Switch } from "@/components/ui/switch";

export function ActorIdentityToggle({
  initial,
  hasAuth,
  onSave,
}: {
  initial: boolean;
  hasAuth: boolean;
  onSave: (enabled: boolean) => Promise<void>;
}) {
  const t = useT();
  const tc = t.settings.connectors;
  const [enabled, setEnabled] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function change(next: boolean) {
    setEnabled(next);
    setSaving(true);
    try {
      await onSave(next);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{tc.actorIdentityTitle}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">{tc.actorIdentityDesc}</div>
        </div>
        <Switch checked={enabled} onCheckedChange={change} disabled={saving} />
      </div>
      {enabled && !hasAuth && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          {tc.actorIdentityNoAuthWarning}
        </div>
      )}
    </div>
  );
}
