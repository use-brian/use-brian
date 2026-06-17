"use client";

/**
 * Three-tier access pill (app-web).
 *
 * Ported verbatim from `apps/web/src/components/sensitivity-badge.tsx`
 * as part of the Studio → Assistants surface migration
 * (docs/plans/doc-web-app-consolidation.md §9 #5). Color-coded to
 * match the spec:
 *   public       → green (safe for external output)
 *   internal     → amber (team-scoped)
 *   confidential → red (restricted to cleared assistants)
 *
 * See docs/architecture/platform/sensitivity.md.
 * [COMP:app-web/sensitivity-badge]
 */

import { useT } from "@/lib/i18n/client";

export type Sensitivity = "public" | "internal" | "confidential";

export function SensitivityBadge({
  tier,
  size = "sm",
}: {
  tier: Sensitivity;
  size?: "sm" | "xs";
}) {
  const t = useT();
  const label = t.manage.sensitivity[tier];
  const titleAttr = `${t.manage.sensitivity.titlePrefix}: ${label}`;
  // Text + SVG colors marked `!important` so the SelectItem focus style
  // (`focus:**:text-accent-foreground`) can't clobber them when the badge is
  // used inside a dropdown option. The `**:` descendant selector hits nested
  // <svg> directly via its own `color` property, so we also force the child
  // svg's color back to the tier hue.
  const styles: Record<Sensitivity, string> = {
    public: "border-emerald-500/40 bg-emerald-500/10 !text-emerald-500 [&_svg]:!text-emerald-500",
    internal: "border-amber-500/40 bg-amber-500/10 !text-amber-500 [&_svg]:!text-amber-500",
    confidential: "border-rose-500/40 bg-rose-500/10 !text-rose-500 [&_svg]:!text-rose-500",
  };
  const padding = size === "xs" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-medium ${padding} ${styles[tier]}`}
      title={titleAttr}
    >
      {tier === "confidential" && <LockIcon />}
      {label}
    </span>
  );
}

function LockIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M5 7V5a3 3 0 1 1 6 0v2h.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1H5zm1 0h4V5a2 2 0 1 0-4 0v2z" />
    </svg>
  );
}
