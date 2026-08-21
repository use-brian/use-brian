"use client";

import { useEffect, useState } from "react";
import { Bookmark, BookmarkPlus, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { promptDialog } from "@/components/ui/prompt-dialog";
import {
  deleteCrmView,
  listCrmSavedViews,
  saveCrmView,
  type CrmSavedView,
} from "@/lib/api/crm";
import { useT } from "@/lib/i18n/client";

export function CrmSavedViews({
  workspaceId,
  section,
  currentSearch,
  onApply,
}: {
  workspaceId: string;
  section: string;
  currentSearch: string;
  onApply: (search: string) => void;
}) {
  const t = useT().crmPage.r2;
  const [views, setViews] = useState<CrmSavedView[]>([]);

  async function reload() {
    setViews(await listCrmSavedViews(workspaceId));
  }
  useEffect(() => {
    void reload().catch(() => setViews([]));
  }, [workspaceId]);

  async function saveCurrent() {
    const name = await promptDialog({
      title: t.saveView,
      placeholder: t.viewName,
      confirmLabel: t.save,
      cancelLabel: t.cancel,
    });
    if (!name) return;
    await saveCrmView(workspaceId, {
      name,
      section,
      queryState: { search: currentSearch },
    });
    await reload();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button size="sm" variant="ghost" aria-label={t.savedViews}>
            <Bookmark aria-hidden />
            <span className="max-lg:hidden">{t.savedViews}</span>
          </Button>
        )}
      />
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem onClick={() => void saveCurrent()}>
          <BookmarkPlus aria-hidden /> {t.saveCurrentView}
        </DropdownMenuItem>
        {views.map((view) => (
          <DropdownMenuItem
            key={view.id}
            onClick={() => {
              const search = typeof view.queryState.search === "string" ? view.queryState.search : "";
              onApply(search);
            }}
          >
            <Bookmark aria-hidden />
            <span className="min-w-0 flex-1 truncate">{view.name}</span>
            <button
              type="button"
              aria-label={t.deleteView}
              className="rounded p-1 text-muted-foreground hover:text-destructive"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void deleteCrmView(workspaceId, view.id).then(reload);
              }}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </DropdownMenuItem>
        ))}
        {views.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">{t.noSavedViews}</div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
