"use client";

/** Office route breadcrumbs layered into the shared operator chrome. [COMP:app-web/office-navigation] */
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { useT } from "@/lib/i18n/client";

export type OfficeBreadcrumb = { label: string; href?: string };

export function OfficeTopbar({
  workspaceId,
  breadcrumbs = [],
  right,
}: {
  workspaceId: string;
  breadcrumbs?: OfficeBreadcrumb[];
  right?: React.ReactNode;
}) {
  const t = useT().office;
  const officeHref = `/w/${workspaceId}/office`;
  return (
    <OperatorTopbar
      app="office"
      center={
        <nav aria-label={t.breadcrumbAria} className="flex min-w-0 items-center gap-1 text-sm">
          <Link href={officeHref} className="shrink-0 text-muted-foreground hover:text-foreground hover:underline">
            {t.homeTitle}
          </Link>
          {breadcrumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
              {crumb.href ? (
                <Link href={crumb.href} className="min-w-0 truncate text-muted-foreground hover:text-foreground hover:underline">
                  {crumb.label}
                </Link>
              ) : (
                <span className="min-w-0 truncate font-medium" aria-current="page">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      }
      right={right}
    />
  );
}
