"use client";

/** Persistent workspace rail and App store. Personal pins never grant access.
 * Spec: docs/architecture/features/workspace-navigation.md.
 * [COMP:app-web/workspace-app-rail] */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, ArrowDown, ArrowUp, ArrowUpRight, Brain, CircleUserRound, FolderKanban, Home, ListOrdered, MoreHorizontal, Pin, PinOff, Puzzle, SlidersHorizontal, Store, X } from "lucide-react";
import { useT, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { WorkspaceSurface } from "@/lib/doc-page-url";
import type { CustomHomeApp } from "@/lib/api/home-apps";
import { homeAppBasePath, homeAppPath, isHomeAppPath, type HomeAppEntry } from "@/lib/operator-apps";
import { workspaceAppCatalogue, useMiniAppPins, useMiniAppMenuOrder, type WorkspaceApp } from "@/lib/workspace-apps";
import { useIntentPrefetch } from "@/lib/surface-prefetch";
import { surfaceShortcutLabel } from "@/lib/surface-shortcuts";
import { requestSidebarClose } from "@/lib/sidebar-close";
import { openWorkspaceSettings } from "@/lib/workspace-settings-events";
import { Tooltip } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LiveActiveBadge } from "@/components/live/live-active-badge";
import { APP_ICON } from "./operator-app-bar";

type Props = {
  workspaceId: string;
  activeSurface: WorkspaceSurface | null;
  activeApp: HomeAppEntry | null;
  homeApps: readonly HomeAppEntry[];
  customApps: readonly CustomHomeApp[];
  liveCount: number;
  studioNudge: boolean;
  onDismissStudioNudge: () => void;
  mobile?: boolean;
};

type CatalogueProps = Pick<Props, "workspaceId" | "homeApps" | "customApps">;

/** One catalogue vocabulary for the rail and contextual app-heading menu. */
function useAppCatalogue({ workspaceId, homeApps, customApps }: CatalogueProps) {
  const copy = useT(), t = copy.workspaceNav;
  const pathname = usePathname();
  const prefetch = useIntentPrefetch();
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const availableApps = useMemo(() => workspaceAppCatalogue(homeApps, customApps), [homeApps, customApps]);
  const { order: catalogue, move, reset, canReorder, customized } = useMiniAppMenuOrder(workspaceId, availableApps);
  const { pins, togglePin, canPin } = useMiniAppPins(workspaceId, catalogue);
  const appLabel = (app: WorkspaceApp) => app.custom?.name ?? copy.operatorBar[app.id as keyof typeof copy.operatorBar];
  const appIcon = (app: WorkspaceApp) => app.custom ? Puzzle : APP_ICON[app.id as keyof typeof APP_ICON];
  const appHref = (app: WorkspaceApp) => {
    if (app.id === "chat") return `/w/${workspaceId}/chat`;
    if (ready && pathname && isHomeAppPath(workspaceId, app.id, pathname)) return pathname;
    return ready ? homeAppPath(workspaceId, app.id) : homeAppBasePath(workspaceId, app.id);
  };
  return { copy, t, pathname, prefetch, catalogue, pins, togglePin, canPin, move, reset, canReorder, customized, appLabel, appIcon, appHref };
}

export function WorkspaceAppRail({ workspaceId, activeSurface, activeApp, homeApps, customApps, liveCount, studioNudge, onDismissStudioNudge, mobile = false }: Props) {
  const { copy, t, prefetch, catalogue, pins, appLabel, appIcon, appHref } = useAppCatalogue({ workspaceId, homeApps, customApps });
  const itemClass = (active: boolean) => cn(
    "relative flex min-h-0 shrink-0 items-center rounded-xl text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground max-md:min-h-11",
    mobile ? "w-full gap-3 px-3 text-sm" : "size-9 justify-center",
    active && "bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:-left-2 before:top-2.5 before:h-4 before:w-0.5 before:rounded-full before:bg-sidebar-foreground",
  );
  const label = (text: string) => mobile ? <span className="min-w-0 break-words">{text}</span> : null;
  const wrap = (text: string, child: React.ReactElement, shortcut?: number) => mobile ? child : (
    <Tooltip label={text} side="right" shortcut={shortcut ? surfaceShortcutLabel(shortcut) : undefined}>{child}</Tooltip>
  );
  function appActive(app: WorkspaceApp) {
    return activeApp === app.id;
  }
  function navigate() { requestSidebarClose(); }
  const destinations = [
    { name: copy.docPage.iconHome, aria: t.homeAria, icon: Home, href: `/w/${workspaceId}/chat`, active: activeSurface === "chat", shortcut: 1 },
    { name: copy.contextScope.projectsTitle, icon: FolderKanban, href: `/w/${workspaceId}/projects`, active: activeSurface === "projects" },
    { name: copy.docPage.iconBrain, icon: Brain, href: `/w/${workspaceId}/brain`, active: activeSurface === "brain", shortcut: 2 },
    { name: copy.liveApp.title, icon: Activity, href: `/w/${workspaceId}/live`, active: activeSurface === "live", live: true },
  ];

  return (
    <nav data-workspace-app-rail data-doc-chrome aria-label={copy.contextScope.workspaceNavigation} className={cn(
      mobile ? "flex flex-col gap-0.5 px-2 pb-2 md:hidden" : "hidden h-full w-14 shrink-0 flex-col items-center gap-1 px-2 pt-[13px] md:flex",
    )}>
      {!mobile && <div data-workspace-menu-slot aria-hidden className="h-16 w-full shrink-0" />}
      <div className={mobile ? "contents" : "flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto [scrollbar-width:none]"}>
      {destinations.map(({ name, aria, icon: Icon, href, active, shortcut, live }) => (
        <div key={href} className={mobile ? undefined : "shrink-0"}>
          {wrap(aria ?? name, <Link href={href} {...prefetch(href)} onClick={navigate} aria-label={live && liveCount > 0 ? format(copy.liveApp.activeWorkBadgeAria, { count: liveCount }) : aria ?? name} aria-current={active ? "page" : undefined} className={itemClass(active)}>
            <Icon className="size-[19px] shrink-0" aria-hidden />{label(name)}
            {live && <LiveActiveBadge count={liveCount} label={format(copy.liveApp.activeWorkBadgeAria, { count: liveCount })} />}
          </Link>, shortcut)}
        </div>
      ))}
      <WorkspaceAppCatalogue workspaceId={workspaceId} homeApps={homeApps} customApps={customApps} mobile={mobile}>
        {wrap(t.more, <PopoverTrigger aria-label={t.more} className={cn(itemClass(false), "aria-expanded:bg-sidebar-accent")}><MoreHorizontal className="size-[19px] shrink-0" aria-hidden />{label(t.more)}</PopoverTrigger>)}
      </WorkspaceAppCatalogue>
      <div data-workspace-added-apps-divider className={mobile ? "my-2 border-t border-sidebar-border" : "my-2 w-7 border-t border-sidebar-border"} />
      <div data-workspace-added-apps className={mobile ? "flex flex-col gap-0.5" : "flex w-full flex-col items-center gap-1"}>
      {catalogue.filter(app => pins.includes(app.id)).map((app) => {
        const Icon = appIcon(app);
        const href = appHref(app);
        return <div key={app.id} className={mobile ? undefined : "shrink-0"}>{wrap(appLabel(app), <Link href={href} {...prefetch(href)} onClick={navigate} aria-label={appLabel(app)} aria-current={appActive(app) ? "page" : undefined} className={itemClass(appActive(app))}><Icon className="size-[19px] shrink-0" aria-hidden />{label(appLabel(app))}</Link>)}</div>;
      })}
      </div>
      </div>
      <div className={mobile ? "my-1 border-t border-sidebar-border" : "my-1 w-8 border-t border-sidebar-border"} />
      {wrap(copy.docPage.iconStudio, <Link href={`/w/${workspaceId}/studio/connectors`} {...prefetch(`/w/${workspaceId}/studio/connectors`)} aria-label={copy.docPage.iconStudio} aria-current={activeSurface === "studio" ? "page" : undefined} onClick={() => { onDismissStudioNudge(); navigate(); }} className={itemClass(activeSurface === "studio")}><SlidersHorizontal className="size-[19px] shrink-0" aria-hidden />{label(copy.docPage.iconStudio)}{studioNudge && <span aria-label={copy.docPage.studioSetupNudgeAria} className="absolute right-1 top-1 size-2 rounded-full bg-primary" />}</Link>, 3)}
      {wrap(t.account, <button type="button" aria-label={t.account} className={itemClass(false)} onClick={() => { openWorkspaceSettings("profile"); navigate(); }}><CircleUserRound className="size-[19px] shrink-0" aria-hidden />{label(t.account)}</button>)}
      {!mobile && <div data-workspace-rail-footer-slot aria-hidden className="h-[calc(4.5rem+env(safe-area-inset-bottom))] shrink-0" />}
    </nav>
  );
}

/** Shared, grant-aware App store, opened by the rail ellipsis.
 * [COMP:app-web/workspace-app-catalogue] */
export function WorkspaceAppCatalogue({ workspaceId, homeApps, customApps, mobile = false, children }: CatalogueProps & { mobile?: boolean; children: React.ReactNode }) {
  const { t, pathname, prefetch, catalogue, pins, togglePin, canPin, move, reset, canReorder, customized, appLabel, appIcon, appHref } = useAppCatalogue({ workspaceId, homeApps, customApps });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setOpen(false); setEditing(false); }, [pathname, workspaceId]);
  const exploreHref = `/w/${workspaceId}/studio/mini-apps`;
  return (
      <Popover open={open} onOpenChange={value => { setOpen(value); if (!value) setEditing(false); }}>
        {children}
        <PopoverContent side={mobile ? "bottom" : "right"} align="start" sideOffset={12} aria-label={t.appStore} className="max-h-[min(38rem,80dvh,var(--available-height))] w-[min(20rem,calc(100vw-1rem))] gap-0 overflow-hidden rounded-2xl bg-sidebar p-2 text-sidebar-foreground">
          <div className="flex shrink-0 items-center gap-2 px-2 pt-1">
            <Store className="size-4 shrink-0" aria-hidden /><span className="flex-1 font-medium">{t.appStore}</span>
            <button type="button" aria-label={t.close} onClick={() => { setOpen(false); setEditing(false); }} className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-sidebar-accent max-md:size-11"><X className="size-4" aria-hidden /></button>
          </div>
          <p aria-live="polite" className="shrink-0 px-2 pb-2 text-xs text-sidebar-foreground/60">{editing ? t.reorderHint : pins.length === 2 ? t.pinLimit : t.caption}</p>
          <div className="min-h-0 overflow-y-auto" data-workspace-app-menu-list>
          {catalogue.map((app, index) => {
            const name = appLabel(app), Icon = appIcon(app), href = appHref(app);
            const pinned = pins.includes(app.id);
            const description = app.custom?.description ?? t.descriptions[app.id as keyof typeof t.descriptions];
            const pinLabel = format(pinned ? t.unpin : t.pin, { name });
            return <div key={app.id} className="flex items-center gap-1" data-menu-app={app.id}>
              {editing ? <>
                <Icon className="ml-2 size-[18px] shrink-0" aria-hidden /><span className="min-w-0 flex-1 truncate px-2 text-sm">{name}</span>
                <button type="button" aria-label={format(t.moveUp, { name })} disabled={!canReorder || index === 0} onClick={() => move(app.id, -1)} className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-sidebar-accent disabled:opacity-30 max-md:size-11"><ArrowUp className="size-4" aria-hidden /></button>
                <button type="button" aria-label={format(t.moveDown, { name })} disabled={!canReorder || index === catalogue.length - 1} onClick={() => move(app.id, 1)} className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-sidebar-accent disabled:opacity-30 max-md:size-11"><ArrowDown className="size-4" aria-hidden /></button>
              </> : <>
              <Link href={href} {...prefetch(href)} onClick={() => { setOpen(false); requestSidebarClose(); }} aria-label={format(t.open, { name })} className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 hover:bg-sidebar-accent">
                <Icon className="size-[18px] shrink-0" aria-hidden /><span className="min-w-0"><span className="block break-words text-sm">{name}</span>{description && <span className="block break-words text-xs text-sidebar-foreground/60">{description}</span>}</span>
              </Link>
              {app.id !== "chat" && <Tooltip label={!pinned && !canPin ? t.pinLimit : pinLabel} side="left"><button type="button" aria-label={pinLabel} aria-pressed={pinned} disabled={!pinned && !canPin} onClick={() => togglePin(app.id)} className="flex size-9 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/55 hover:bg-sidebar-accent disabled:opacity-35 aria-pressed:text-primary max-md:size-11">{pinned ? <PinOff className="size-4" aria-hidden /> : <Pin className="size-4" aria-hidden />}</button></Tooltip>}
              </>}
            </div>;
          })}
          </div>
          <div className="mt-2 shrink-0 border-t border-sidebar-border pt-1">
            {editing ? <div className="flex items-center gap-1">
              <button type="button" disabled={!customized || !canReorder} onClick={reset} className="min-h-8 flex-1 rounded-md px-2 text-left text-xs hover:bg-sidebar-accent disabled:opacity-40 max-md:min-h-11">{t.useWorkspaceOrder}</button>
              <button type="button" onClick={() => setEditing(false)} className="min-h-8 rounded-md px-3 text-sm font-medium hover:bg-sidebar-accent max-md:min-h-11">{t.done}</button>
            </div> : <button type="button" disabled={!canReorder || catalogue.length < 2} onClick={() => setEditing(true)} className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-sm hover:bg-sidebar-accent disabled:opacity-40 max-md:min-h-11"><ListOrdered className="size-4" aria-hidden />{t.reorderMenu}</button>}
            <Link href={exploreHref} {...prefetch(exploreHref)} onClick={() => { setOpen(false); requestSidebarClose(); }} className="flex min-h-8 items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-sidebar-accent max-md:min-h-11">{t.exploreMore}<ArrowUpRight className="ml-auto size-4" aria-hidden /></Link>
          </div>
        </PopoverContent>
      </Popover>
  );
}
