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

import { useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import { askAssistant, callTool, ShopifyCallError } from "@/lib/api/shopify";
import { storeFiles } from "@/lib/api/ingest";
import { Field, Note } from "./shopify-shared";
import { LayoutPicker } from "./layout-picker";

type Created = { id?: string; product_id?: string; product?: { id?: string } };

export function DraftTab({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<string>("");
  const [wanted, setWanted] = useState<string[]>([]);
  const [steps, setSteps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);

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
${wanted.length ? `Sections the owner asked this page to have: ${wanted.join(", ")}` : ""}

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
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
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

      {/* The native control renders as "Choose files / No file chosen", which
          reads as broken chrome next to the rest of the surface. Keep the input
          for behaviour and accessibility, hide it visually, and drive it from a
          real button. */}
      <div className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{t.shopifyApp.photos}</span>
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => setFiles([...(e.target.files ?? [])])}
            className="sr-only"
            id="shopify-photos"
          />
          <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <ImagePlus className="size-4" aria-hidden />
            {t.shopifyApp.choosePhotos}
          </Button>
          {files.length ? (
            <span className="text-[13px] text-muted-foreground">
              {files.length} {t.shopifyApp.photoCount}
            </span>
          ) : null}
        </div>
        {files.length ? (
          <ul className="mt-1 flex flex-wrap gap-2">
            {files.map((f) => (
              <li
                key={f.name}
                className="rounded-md border border-border bg-card px-2 py-1 text-[11.5px] text-muted-foreground"
              >
                {f.name}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

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

      <LayoutPicker
        workspaceId={workspaceId}
        productName={name}
        chosen={chosen}
        onChoose={setChosen}
        wanted={wanted}
        onWanted={setWanted}
      />

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
          <pre className="whitespace-pre-wrap rounded-xl border border-border bg-card px-3 py-2 text-[13px]">
            {answer}
          </pre>
          <Note>{t.shopifyApp.stillDraft}</Note>
        </div>
      ) : null}
    </div>
  );
}
