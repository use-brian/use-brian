"use client";

/**
 * "Nothing has all of these" is a dead end unless the merchant can act on it.
 *
 * This is the one place in the Shopify surface that writes into the live
 * theme. It is reachable because `apps-shopify.ts` names
 * `shopifyCreateProductTemplate` in `NATIVE_EXTRA_TOOLS`, and the argument for
 * that lives in that file's header: the containment is server-enforced and the
 * write is inert until a product is pointed at it. The dialog below is the
 * merchant-facing half, and it states the whole blueprint rather than asking
 * for a blank yes.
 *
 * [COMP:app-web/shopify-app]
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { callTool, ShopifyCallError } from "@/lib/api/shopify";
import { Note } from "./shopify-shared";
import { suffixFromName, type LayoutShape, type Template } from "./layout-match";
import { assembleTemplate, planGraft } from "./build-layout";

export function BuildLayoutButton({
  workspaceId,
  productName,
  templates,
  wanted,
  nearest,
  sectionLabel,
  onCreated,
}: {
  workspaceId: string;
  productName: string;
  templates: Template[];
  wanted: string[];
  nearest?: { shape: LayoutShape; missing: string[] };
  sectionLabel: (type: string) => string;
  onCreated: (suffix: string, created: Template) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function build() {
    setError(null);
    setNote(null);

    const base = nearest?.shape.representative;
    if (!base) {
      setError(t.shopifyApp.buildLayoutNoBase);
      return;
    }
    const suffix = suffixFromName(
      productName,
      templates.map((x) => x.suffix ?? "").filter(Boolean),
    );
    if (!suffix) {
      setError(t.shopifyApp.buildLayoutNeedsName);
      return;
    }
    const plan = planGraft(templates, base, wanted);
    if (!plan) {
      // A wanted type that appears in no template may not exist in the theme
      // at all, and a template naming a section the theme lacks renders blank.
      setError(t.shopifyApp.buildLayoutNoBase);
      return;
    }

    const filename = `templates/product.${suffix}.json`;
    const ok = await confirmDialog({
      title: t.shopifyApp.buildLayoutTitle,
      description: format(t.shopifyApp.buildLayoutBody, { filename }),
      confirmLabel: t.shopifyApp.buildLayoutConfirm,
      variant: "destructive",
      content: (
        <div className="space-y-2 text-[12.5px]">
          <div>
            <p className="font-medium">{t.shopifyApp.buildLayoutSectionList}</p>
            <ol className="mt-1 space-y-0.5">
              {plan.sections.map((s, i) => {
                const graft = plan.grafts.find((g) => g.type === s);
                return (
                  <li key={`${s}-${i}`} className="flex gap-2">
                    <span className="text-muted-foreground">{i + 1}.</span>
                    <span>
                      {sectionLabel(s)}
                      {graft ? (
                        <span className="text-muted-foreground">
                          {" "}
                          {format(t.shopifyApp.buildLayoutCopiedFrom, {
                            suffix: graft.donor.suffix ?? "",
                          })}
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
          {plan.grafts.length > 0 ? (
            <p className="text-muted-foreground">{t.shopifyApp.buildLayoutCopyNote}</p>
          ) : null}
        </div>
      ),
    });
    if (!ok) return;

    setBusy(true);
    try {
      // Read every donor once, base included, then assemble locally. The
      // bodies are raw file content: Shopify's auto-generated banner and all.
      const needed = new Set([plan.base.suffix ?? "", ...plan.grafts.map((g) => g.donor.suffix ?? "")]);
      const bodies = new Map<string, string>();
      for (const key of needed) {
        const read = await callTool<{ template?: string }>(
          workspaceId,
          "shopifyReadProductTemplate",
          key ? { suffix: key } : {},
        );
        bodies.set(key, read.template ?? "");
      }

      await callTool(workspaceId, "shopifyCreateProductTemplate", {
        suffix,
        template: assembleTemplate(plan, bodies),
      });

      onCreated(suffix, { suffix, filename, sections: plan.sections });
      setNote(format(t.shopifyApp.buildLayoutDone, { filename }));
    } catch (err) {
      // Shopify's own wording is the useful one here. A store whose app lacks
      // `write_themes` gets "Required access: write_themes access scope",
      // which names the fix; rephrasing it would lose that.
      setError(err instanceof ShopifyCallError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5 rounded-xl border border-dashed border-border p-3">
      <p className="text-[12.5px] text-muted-foreground">{t.shopifyApp.buildLayoutHint}</p>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void build()}>
        {busy ? t.shopifyApp.buildLayoutWorking : t.shopifyApp.buildLayout}
      </Button>
      {error ? <Note tone="error">{error}</Note> : null}
      {note ? <Note tone="muted">{note}</Note> : null}
    </div>
  );
}
