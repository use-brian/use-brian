"use client";

/**
 * Canonical "up to parent" back control (app-web).
 *
 * Ported from `apps/web/src/components/ui/back-button.tsx` as part of the
 * app consolidation (docs/plans/doc-web-app-consolidation.md §5a
 * "Foundation" / Phase 0 — shared UI primitives). An `ArrowLeft` icon +
 * label rendered as a flush-left ghost button (the negative margin lines
 * the label up with the heading below it; the arrow nudges left on hover).
 * Replaces bare "< text" links that read as AI-generated. Pass `href` for
 * navigation or `onClick` for imperative routing.
 *
 * `w-fit` is load-bearing: inside the `flex flex-col` page headers a plain
 * `inline-flex` child would still stretch to full width and the hover
 * surface would span the whole row.
 *
 * [COMP:app-web/back-button]
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { cn } from "@/lib/utils";

type BackButtonProps = {
  /** Visible label, e.g. "All workflows". Supply via the i18n dictionary. */
  label: string;
  /** Navigate to this route. Mutually exclusive with `onClick`. */
  href?: string;
  /** Imperative handler (e.g. router.back / router.push). Used when `href` is absent. */
  onClick?: () => void;
  className?: string;
};

export function BackButton({ label, href, onClick, className }: BackButtonProps) {
  const classes = cn(
    "group -ml-2 inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    className,
  );

  const inner = (
    <>
      <ArrowLeft className="size-4 shrink-0 transition-transform group-hover:-translate-x-0.5" />
      {label}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={classes}>
        {inner}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={classes}>
      {inner}
    </button>
  );
}
