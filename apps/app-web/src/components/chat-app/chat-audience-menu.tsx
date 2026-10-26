"use client";

/** Surface-owned audience chooser for the contextual title and toolbar fallback.
 * Spec: docs/architecture/features/workspace-navigation.md → "Chat heading audience menu".
 * [COMP:app-web/chat-audience-menu] */
import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { requestSidebarClose } from "@/lib/sidebar-close";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function ChatAudienceMenu({ view, onSelect, heading = false }: {
  view: "personal" | "workspace";
  onSelect: (view: "personal" | "workspace") => void;
  heading?: boolean;
}) {
  const copy = useT(), t = copy.chatApp;
  const [open, setOpen] = useState(false);
  const audience = view === "personal" ? t.viewPersonal : t.viewWorkspace;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger
      data-chat-audience-toggle
      data-workspace-heading-control={heading ? "" : undefined}
      data-workspace-app-identity={heading ? "" : undefined}
      aria-label={`${t.viewSwitchAria}: ${audience}`}
      className={cn("relative isolate flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-lg px-2 text-left font-medium", heading ? "text-lg font-semibold hover:bg-sidebar-accent aria-expanded:bg-sidebar-accent" : "text-sm md:min-h-8 before:pointer-events-none before:absolute before:inset-x-0 before:inset-y-1 before:-z-10 before:rounded-lg hover:before:bg-sidebar-accent aria-expanded:before:bg-sidebar-accent")}
    >
      <span className="truncate">{view === "workspace" ? t.viewWork : copy.operatorBar.chat}</span>
      <ChevronDown data-heading-chevron className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
    </PopoverTrigger>
    <PopoverContent align="start" sideOffset={12} aria-label={t.viewSwitchAria} className="w-[min(20rem,calc(100vw-1rem))] gap-1 rounded-2xl bg-sidebar p-2 text-sidebar-foreground">
      {(["personal", "workspace"] as const).map(mode => <button
        key={mode}
        type="button"
        aria-pressed={view === mode}
        onClick={() => { onSelect(mode); setOpen(false); requestSidebarClose(); }}
        className="flex min-h-16 w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-sidebar-accent"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{mode === "personal" ? t.viewPersonal : t.viewWorkspace}</span>
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{mode === "personal" ? t.personalScopeDescription : t.workspaceScopeDescription}</span>
        </span>
        {view === mode && <Check className="size-5 shrink-0" aria-hidden />}
      </button>)}
    </PopoverContent>
  </Popover>;
}
