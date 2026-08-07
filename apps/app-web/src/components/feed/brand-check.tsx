"use client";

/**
 * A non-blocking brand warning under the caption (feed-revamp-depth D38).
 *
 * It WARNS and never blocks. The operator is the author, not the suspect, and
 * a check that can stop a save will eventually stop a correct one -- brands
 * have exceptions, and the person writing the post knows them. So this renders
 * a quiet row and gets out of the way.
 *
 * Matching is literal, case-folded, exact-phrase containment (see
 * `brandCopyFlags`), deliberately not fuzzy: a false positive here has no
 * upside, because there is no gate for it to protect.
 *
 * Renders nothing when there is no brand, no flags, or no text -- so a
 * workspace without an approved brand sees exactly what it saw before.
 *
 * [COMP:app-web/feed-brand-check]
 */

import { AlertTriangle } from "lucide-react";
import { useMemo } from "react";
import { useT } from "@/lib/i18n/client";
import { brandCopyFlags } from "@/lib/feed-brand";
import type { BrandRecord } from "@use-brian/shared/brand";

export function BrandCheck({
  brand,
  text,
}: {
  brand: BrandRecord | null;
  text: string;
}) {
  const tb = useT().feedPage.brand;
  const flags = useMemo(() => brandCopyFlags(brand, text), [brand, text]);
  if (flags.length === 0) return null;

  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2 text-[12.5px]">
      <AlertTriangle
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{tb.checkTitle}</span>{" "}
        <span className="text-muted-foreground">
          {flags.map((flag, i) => (
            <span key={`${flag.kind}:${flag.phrase}`}>
              {i > 0 ? ", " : ""}
              <span className="text-foreground">{flag.phrase}</span>
              <span className="text-muted-foreground">
                {" "}
                ({tb[`kind_${flag.kind}` as const]})
              </span>
            </span>
          ))}
        </span>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {tb.checkHint}
        </p>
      </div>
    </div>
  );
}
