"use client";

/**
 * Manual-trigger panel (app-web) — the simplest of the four kinds.
 *
 * Ported from `apps/web/src/components/workflow/manual-trigger-panel.tsx`
 * (app consolidation §5a). Configurable fields are intentionally minimal
 * (manual is "no auto-trigger, period"). The panel surfaces the REST
 * endpoint so a developer or external script can fire the workflow
 * directly without scraping the URL out of code.
 *
 * Spec: docs/architecture/features/workflow.md → Manual trigger UI.
 * [COMP:app-web/workflow]
 */

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { manualRunUrlForId } from "@/lib/api/workflow";

type Props = {
  workflowId: string;
  disabled?: boolean;
};

export function ManualTriggerPanel({ workflowId, disabled }: Props) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const url = manualRunUrlForId(workflowId);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard may be restricted
    }
  };

  return (
    <div className="ml-6 pl-3 border-l border-border flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">
        {t.workflowPage.builder.manualEndpointLabel}
      </label>
      <div className="flex items-center gap-2">
        <code className="flex-1 px-3 py-1.5 bg-background border border-border rounded-md text-xs font-mono break-all">
          POST {url}
        </code>
        <button
          type="button"
          onClick={copy}
          disabled={disabled}
          className="text-xs px-2 py-1.5 rounded border border-border hover:bg-muted whitespace-nowrap disabled:opacity-50"
        >
          {copied
            ? t.workflowPage.builder.manualCopiedToast
            : t.workflowPage.builder.manualCopyEndpoint}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t.workflowPage.builder.manualEndpointHint}
      </p>
    </div>
  );
}
