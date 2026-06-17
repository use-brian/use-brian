"use client";

/**
 * Cold-start setup checklist — the home half of the lifecycle-aware Studio
 * prominence (docs/plans/doc-web-app-consolidation.md §4). The companion to
 * the sidebar's Studio "Set up" nudge: where the nudge lives in the persistent
 * chrome, this renders ON the doc `/p` home landing (above the chatter) and
 * walks a new workspace through the first three setup moves, each a deep link
 * into Studio.
 *
 * Cold start ONLY. The parent (`EmptyPageLanding`) mounts this only while the
 * workspace has zero connected connectors — the same `studioSetupIncomplete`
 * signal the sidebar nudge reads, fetched once in `DocSidebarDataProvider`
 * (no second connectors fetch). Once a connector connects, that signal flips
 * and the checklist auto-hides with the nudge. The probe is non-blocking: the
 * landing never waits on it, and a failed probe resolves to "assume set up" so
 * a transient API blip never shows the checklist.
 *
 * Calm + non-blocking + opt-out: a dismiss `X` persists per workspace in
 * `localStorage["doc:studio-checklist-dismissed:<workspaceId>"]` (the same
 * key family as the Studio nudge's `doc:studio-nudge-dismissed:<id>`), so a
 * user who'd rather explore on their own never sees it again on that workspace.
 *
 * Tone matches the landing: a quiet card on the document surface, brand accent
 * only on the leading step icons + the arrow on hover. Every string via
 * `useT()` (en/ja/zh parity).
 *
 * [COMP:app-web/setup-checklist]
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Plug, Bot, Sparkles, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/** Per-workspace localStorage key for the dismissed home setup checklist.
 *  Same family as the sidebar Studio nudge's `doc:studio-nudge-dismissed:`. */
function checklistDismissedKey(workspaceId: string): string {
  return `doc:studio-checklist-dismissed:${workspaceId}`;
}

export function SetupChecklist({ workspaceId }: { workspaceId: string }) {
  const t = useT().docPage.setupChecklist;

  // Opt-out: hide once dismissed for this workspace. Read on mount; default to
  // shown so a storage error never silently suppresses the checklist.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !workspaceId) return;
    try {
      setDismissed(
        window.localStorage.getItem(checklistDismissedKey(workspaceId)) === "1",
      );
    } catch {
      setDismissed(false);
    }
  }, [workspaceId]);

  function onDismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(checklistDismissedKey(workspaceId), "1");
    } catch {
      // Non-fatal — the checklist re-appears next session, no worse than before.
    }
  }

  if (dismissed) return null;

  const steps = [
    {
      key: "connectors",
      icon: Plug,
      title: t.connectTitle,
      desc: t.connectDesc,
      href: `/w/${workspaceId}/studio/connectors`,
    },
    {
      key: "assistants",
      icon: Bot,
      title: t.assistantTitle,
      desc: t.assistantDesc,
      href: `/w/${workspaceId}/studio/assistants`,
    },
    {
      key: "skills",
      icon: Sparkles,
      title: t.skillsTitle,
      desc: t.skillsDesc,
      href: `/w/${workspaceId}/studio/skills`,
    },
  ] as const;

  return (
    <section
      aria-label={t.ariaLabel}
      className="animate-pop-in relative rounded-2xl border border-border bg-card/60 p-4 shadow-sm sm:p-5"
    >
      <div className="flex items-start justify-between gap-3 px-1">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{t.title}</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {t.subtitle}
          </p>
        </div>
        <button
          type="button"
          aria-label={t.dismissAriaLabel}
          onClick={onDismiss}
          className="-mr-1 -mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <ul className="mt-3 flex flex-col gap-1.5">
        {steps.map(({ key, icon: Icon, title, desc, href }) => (
          <li key={key}>
            <Link
              href={href}
              className={cn(
                "press group flex items-center gap-3 rounded-xl border border-transparent px-2.5 py-2.5 text-left",
                "transition-colors hover:border-border hover:bg-muted/50",
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15">
                <Icon className="size-[18px]" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {title}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {desc}
                </span>
              </span>
              <ArrowUpRight
                className="size-4 shrink-0 text-transparent transition-colors group-hover:text-muted-foreground"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
