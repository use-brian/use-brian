"use client";

/**
 * Per-connector opt-in for letting a custom MCP connector fetch this user's
 * media (their most recent channel-media recording). Writes
 * `config.sendMediaToken`. Default off.
 *
 * When on, sidanclaw emits a short-lived, user-scoped capability token
 * (`X-Sidanclaw-Media-Token`) to this connector on each turn; the connector
 * echoes it back to the internal media-fetch endpoint, which derives the user
 * from the signed token. No shared secret is handed to the connector, and the
 * token only ever unlocks this user's own media. See
 * docs/architecture/media/internal-media-fetch.md.
 */

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { Switch } from "@/components/ui/switch";

export function MediaTokenToggle({
  initial,
  onSave,
}: {
  initial: boolean;
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
          <div className="text-sm font-medium">{tc.mediaTokenTitle}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">{tc.mediaTokenDesc}</div>
        </div>
        <Switch checked={enabled} onCheckedChange={change} disabled={saving} />
      </div>
    </div>
  );
}
