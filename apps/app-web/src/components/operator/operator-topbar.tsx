"use client";

/** App heading and composable controls hosted by the shared workspace frame.
 * Spec: docs/architecture/features/workspace-navigation.md → "Shared top bar".
 * [COMP:app-web/operator-topbar] */
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Puzzle, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { useSidebarData } from "@/components/doc/doc-sidebar-data";
import { WorkspaceTopbar } from "@/components/chrome/workspace-topbar";
import { APP_ICON } from "@/components/doc/operator-app-bar";
import type { OperatorAppKey } from "@/lib/operator-apps";
import { requestSidebarClose } from "@/lib/sidebar-close";

export function OperatorTopbar({
  app, identity, identityControl, identityHref, customApp, appChipClassName, center,
  centerVisibility = "always", right,
}: {
  app?: OperatorAppKey;
  identity?: { label: string; icon: LucideIcon };
  /** Surface-owned contextual heading control, such as the Chat audience menu. */
  identityControl?: React.ReactNode;
  /** Preserve a surface's app-root breadcrumb in its sidebar heading. */
  identityHref?: string;
  customApp?: { name: string; icon: string | null };
  /** Layout tuning must preserve the phone identity gate. */
  appChipClassName?: string;
  center?: React.ReactNode;
  centerVisibility?: "always" | "when-sidebar-unavailable";
  right?: React.ReactNode;
}) {
  const t = useT();
  const router = useRouter();
  const { sidebarCollapsed } = useSidebarData();
  const Icon = identity?.icon ?? (customApp ? Puzzle : app ? APP_ICON[app] : Puzzle);
  const label = identity?.label ?? (customApp ? customApp.name : app ? t.operatorBar[app] : "");
  const appIdentity = identityControl ?? (
      <div data-workspace-app-identity className={cn(
        "hidden min-w-0 max-w-52 shrink items-center gap-2 px-1 text-sm font-medium text-foreground sm:flex",
        appChipClassName,
      )}>
        <span data-workspace-app-icon className="grid size-4 shrink-0 place-items-center"><Icon className="size-4 text-muted-foreground" aria-hidden /></span>
        <span className="min-w-0 truncate" title={label}>{label}</span>
      </div>
  );
  return (
    <WorkspaceTopbar identity={identityHref ? <Link href={identityHref} onClick={requestSidebarClose} className="flex min-w-0 items-center max-md:min-h-11">{appIdentity}</Link> : appIdentity} sidebarCollapsed={sidebarCollapsed} history={{ onBack: () => router.back(), onForward: () => router.forward() }}>

      <div data-center-visibility={centerVisibility}
        data-center-desktop-hidden={centerVisibility === "when-sidebar-unavailable" && !sidebarCollapsed ? "true" : "false"}
        className={cn("flex min-w-0 flex-1 items-center gap-2 overflow-x-auto", centerVisibility === "when-sidebar-unavailable" && !sidebarCollapsed && "md:hidden")}>
        {center ?? <span data-mobile-app-title className="truncate text-sm font-medium md:hidden">{label}</span>}
      </div>
      {right && <div className="ml-auto flex shrink-0 items-center gap-1">{right}</div>}
    </WorkspaceTopbar>
  );
}
