"use client";

/**
 * KB editor stub — `/w/[workspaceId]/knowledge-base/new` (app-web).
 *
 * Shipped alongside the KB-gaps slice (consolidation §5a) so the "Draft entry"
 * action has a landing page instead of a 404. KB entries are git-sourced
 * today, so this is intentionally a placeholder that confirms the drafted
 * pattern and points back; the pre-fill params (`from-gap`, `pattern`) are
 * already threaded so the eventual editor is a drop-in.
 *
 * Uses only existing i18n keys (`kbGaps.title`, `kbGaps.prefillNote`,
 * `common.back`) — no new copy. [COMP:app-web/kb-gaps]
 */

import { useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useWorkspaces } from "@/contexts/workspace-context";

export default function KbNewStubPage() {
  const t = useT();
  const params = useSearchParams();
  const { activeId } = useWorkspaces();
  const pattern = params.get("pattern") ?? "";

  return (
    <div className="h-full w-full flex items-center justify-center p-8">
      <div className="max-w-md w-full border border-border rounded-md bg-card p-6 flex flex-col gap-4 text-center">
        <h1 className="text-lg font-semibold">{t.kbGaps.title}</h1>
        {pattern ? (
          <p className="text-sm text-muted-foreground">
            {format(t.kbGaps.prefillNote, { pattern })}
          </p>
        ) : null}
        <a
          href={activeId ? `/w/${activeId}/knowledge-base/gaps` : "#"}
          className="self-center text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted"
        >
          {t.common.back}
        </a>
      </div>
    </div>
  );
}
