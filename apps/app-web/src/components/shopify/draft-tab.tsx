"use client";

/**
 * Draft a product.
 *
 * Asks for what only the owner has: the name, the price, the photos. Copy,
 * variant naming and page structure are the assistant's job.
 *
 * The exception is deliberate and never widens: ingredients, nutrition and
 * dosage are FACTS, not copy. The assistant is told to ask for them and to
 * leave them out otherwise, because invented nutrition on a live storefront is
 * the worst thing this app could produce.
 *
 * [COMP:app-web/shopify-app]
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import { askAssistant, callTool, ShopifyCallError } from "@/lib/api/shopify";
import { storeFiles } from "@/lib/api/ingest";
import { Field, Note } from "./shopify-shared";

type Template = { suffix: string | null; filename: string; sections: string[] };
type TemplateList = { theme?: string; templates?: Template[] };
type Created = { id?: string; product_id?: string; product?: { id?: string } };

/** A theme section TYPE is a developer string; the owner is picking a layout. */
const SECTION_LABEL: Record<string, string> = {
  "main-product": "Product, price and buy button",
  "related-products": "Related products",
  "rich-text": "Text block",
  multicolumn: "Feature columns",
  "collapsible-content": "FAQ / accordion",
  "image-with-text": "Image beside text",
  slideshow: "Slideshow",
  video: "Video",
  newsletter: "Email signup",
  "product-recommendations": "Recommendations",
  apps: "App block",
};

const sectionLabel = (t: string): string =>
  SECTION_LABEL[t] ?? t.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());

export function DraftTab({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [steps, setSteps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await callTool<TemplateList>(workspaceId, "shopifyListProductTemplates", {});
        if (alive) setTemplates(res.templates ?? []);
      } catch (err) {
        // Theme access is a grant the merchant turns on for their own app, not
        // something to work around. Relay it and keep the rest usable.
        if (alive) setTemplateError(err instanceof ShopifyCallError ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const log = (line: string) => setSteps((s) => [...s, line]);

  async function createDraft() {
    if (!name.trim()) {
      setError(t.shopifyApp.needTitle);
      return;
    }
    setBusy(true);
    setError(null);
    setAnswer(null);
    setSteps([]);

    try {
      // The deterministic half runs HERE. Create, price, images: no judgement
      // in any of it, so none of it is worth a model turn or a chance to drift.
      const created = await callTool<Created>(workspaceId, "shopifyCreateProduct", {
        title: name.trim(),
      });
      const productId = created.id ?? created.product_id ?? created.product?.id;
      log(`Created "${name.trim()}" as a draft.`);

      if (price.trim()) {
        await callTool(workspaceId, "shopifySetProductPrice", { productId, price: price.trim() });
        log(`Price set to ${price.trim()}.`);
      } else {
        log("No price given - it needs one before it can be published.");
      }

      if (!files.length) {
        log("No photo attached. A product with no image looks unfinished on the storefront.");
      } else {
        // Two steps that cannot be collapsed: the tool takes a WORKSPACE FILE,
        // never raw bytes. Store first, attach by path.
        const stored = await storeFiles(workspaceId, files);
        for (const s of stored) {
          if (!s.ok || !(s.path ?? s.fileId)) {
            // Per-image reporting: one bad file must not lose the others, and a
            // silent skip would leave the owner believing every photo landed.
            log(`${s.fileName} could not be stored: ${s.error ?? "unknown error"}`);
            continue;
          }
          try {
            await callTool(workspaceId, "shopifyAddProductImage", {
              productId,
              file: s.path ?? s.fileId,
              alt: name.trim(),
            });
            log(`${s.fileName} added. Shopify processes images asynchronously, so it may take a few seconds to appear.`);
          } catch (err) {
            log(`${s.fileName} failed: ${err instanceof ShopifyCallError ? err.message : String(err)}`);
          }
        }
        setFiles([]);
      }

      log("Writing the description and setting up the page...");
      const task = `Finish this DRAFT product. It already exists - do not create it again, and do
not change its price or images.

Product id: ${productId}
Name: ${name.trim()}
${price.trim() ? `Price already set: ${price.trim()}` : "No price set yet."}
Photos already attached: ${files.length ? "yes" : "none"}

What the owner told me, verbatim. This may be empty:
${notes.trim() || "(nothing)"}

Page layout the owner picked: ${chosen ? `the "${chosen}" template` : "the theme default"}

Do this:
1. Write the product description and set it with shopifyUpdateProduct. Write real
   selling copy - benefits, who it is for, how it feels to use. That part is yours.
2. NEVER state ingredients, nutrition, dosage, or any health or origin claim that
   was not given to you above. Do not infer them from the name or the photo. If the
   description would be better with them, list exactly what you need and ask.
3. Variants: if pack sizes were mentioned, set them up with shopifySetProductOptions.
   A trial or sample size is a SEPARATE variant from a full-size pack, never the same
   one. Rename the default "Title / Default Title" option, which looks unfinished.
4. Page layout: ${
        chosen
          ? `point it at the existing "${chosen}" template with shopifySetProductTemplate. Do not create a new template.`
          : "leave it on the theme default."
      }
5. Leave it a DRAFT and unpublished. Do not publish.

Then tell me, briefly: what you wrote, what variants it now has, which template it is
on, and every fact you still need before this could go live.`;

      setAnswer(await askAssistant(workspaceId, task));
    } catch (err) {
      setError(err instanceof ShopifyCallError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t.shopifyApp.productName}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Immunity Boost"
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
          />
        </Field>
        <Field label={t.shopifyApp.price}>
          <input
            value={price}
            inputMode="decimal"
            onChange={(e) => setPrice(e.target.value)}
            placeholder="24.00"
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
          />
        </Field>
      </div>

      <Field label={t.shopifyApp.photos}>
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => setFiles([...(e.target.files ?? [])])}
          className="text-sm"
        />
      </Field>

      <div className="space-y-1">
        <label htmlFor="shopify-notes" className="text-xs font-medium text-muted-foreground">
          {`${t.shopifyApp.anythingElse} (${t.shopifyApp.optional})`}
        </label>
        <textarea
          id="shopify-notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t.shopifyApp.notesHint}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
        />
      </div>

      <div className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t.shopifyApp.pageLayout}
        </h2>
        <p className="text-[13px] text-muted-foreground">{t.shopifyApp.layoutHelp}</p>

        {templateError ? <Note>{templateError}</Note> : null}
        {!templates && !templateError ? (
          <p className="text-sm text-muted-foreground">{t.shopifyApp.loading}</p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(templates ?? []).map((tpl) => {
            const key = tpl.suffix ?? "";
            const label = tpl.suffix ? tpl.suffix.replace(/-/g, " ") : t.shopifyApp.themeDefault;
            return (
              <button
                key={tpl.filename}
                type="button"
                onClick={() => setChosen(key)}
                aria-pressed={key === chosen}
                className={`rounded-xl border p-3 text-left transition-colors ${
                  key === chosen
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card hover:border-primary/40"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] font-semibold capitalize">{label}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {tpl.sections.length} {t.shopifyApp.sections}
                  </span>
                </div>
                {/* The layout IS the choice: a page with an ingredients panel
                    and an FAQ versus one that is just a buy button. */}
                <div className="mt-2 flex flex-col gap-1">
                  {tpl.sections.map((s, i) => (
                    <div
                      key={`${s}-${i}`}
                      className={`rounded-md border bg-background px-2 py-1 ${
                        i === 0 ? "border-primary/40" : "border-border"
                      }`}
                    >
                      <div className="text-[11.5px] leading-tight">{sectionLabel(s)}</div>
                      <div className="font-mono text-[9.5px] text-muted-foreground">{s}</div>
                    </div>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <Button onClick={() => void createDraft()} disabled={busy}>
        {t.shopifyApp.createDraft}
      </Button>

      {error ? <Note tone="error">{error}</Note> : null}
      {busy ? <p className="text-sm text-muted-foreground">{t.shopifyApp.working}</p> : null}

      {steps.length ? (
        <ol className="space-y-1 text-[13px]">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-muted-foreground">{i + 1}.</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {answer ? (
        <div className="space-y-2">
          <pre className="whitespace-pre-wrap rounded-xl border border-border bg-card px-4 py-3 text-[13px]">
            {answer}
          </pre>
          <Note>{t.shopifyApp.stillDraft}</Note>
        </div>
      ) : null}
    </div>
  );
}
