"use client";

/**
 * The "this page is empty" placeholder shown when a draft has zero
 * blocks. Tells the user to talk to the chat assistant — that's the
 * intended Notion-feel onramp into the page surface.
 *
 * The Notion "/" slash-command shortcut is a Phase 2 enhancement
 * (paired with inline-edit). For now the placeholder is informational
 * only.
 *
 * [COMP:app-web/page-renderer]
 */

import { useT } from "@/lib/i18n/client";

export function EmptyPageState({ state }: { state: "draft" | "saved" }) {
  const t = useT().docPage;
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/50 px-6 py-10 text-center">
      <p className="text-base font-medium text-foreground">
        {state === "draft" ? t.emptyDraftTitle : t.emptySelectionTitle}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        {state === "draft" ? t.emptyDraftDesc : t.emptySelectionDesc}
      </p>
    </div>
  );
}
