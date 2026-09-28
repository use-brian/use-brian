"use client";
/** Descriptor-driven page view of a content document: headings, text, images and card grids as a visitor would scan them.
 * It approximates layout only; each website keeps its own design. [COMP:app-web/site-content] */
import type { ReactNode } from "react";
import { websiteSiteLabel, type MembershipLocale } from "@/lib/api/association";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { Field } from "./descriptors";
import { MediaThumb } from "./document-editor";

type Value = Record<string, unknown>;
const isObject = (value: unknown): value is Value => typeof value === "object" && value !== null && !Array.isArray(value);
const HEADINGS = new Set(["title", "heading", "name"]);
const SMALL = new Set(["eyebrow", "kicker", "short", "role", "term", "category"]);

function text(value: unknown, locale: MembershipLocale): string {
  if (typeof value === "string") return value;
  if (!isObject(value)) return "";
  return String(value[locale] || value.en || "");
}

export function PagePreview({ fields, value, locale, workspaceId, phone, siteNames }: {
  fields: Field[]; value: Value | null | undefined; locale: MembershipLocale; workspaceId: string; phone: boolean; siteNames: Record<string, string>;
}) {
  const c = useT().associationPage.content;
  const labels = c.fields as Record<string, string>;
  if (!value) return <p className="text-sm text-muted-foreground">{c.nothingPublished}</p>;

  const image = (raw: unknown, key: string) => {
    if (!isObject(raw)) return null;
    if (typeof raw.mediaId === "string") return <MediaThumb key={key} workspaceId={workspaceId} id={raw.mediaId} />;
    return typeof raw.src === "string" ? <div key={key} title={raw.src} className="flex h-16 w-24 items-center justify-center rounded-md bg-muted text-[11px] text-muted-foreground">{c.siteFile}</div> : null;
  };
  const block = (fieldsIn: Field[], item: Value, depth: number): ReactNode[] => fieldsIn.map(field => {
    const raw = item[field.key];
    if (raw === undefined || raw === null || raw === "") return null;
    switch (field.kind) {
      case "localized": case "text": {
        const shown = text(raw, locale);
        if (!shown || field.key === "id" || field.key === "key" || field.key === "slug" || field.key === "href" || field.key === "icon") return null;
        if (HEADINGS.has(field.key)) return depth === 0
          ? <h2 key={field.key} className="text-2xl font-semibold tracking-tight">{shown}</h2>
          : <h4 key={field.key} className="font-semibold">{shown}</h4>;
        if (SMALL.has(field.key)) return <p key={field.key} className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{shown}</p>;
        return <p key={field.key} className="text-sm leading-relaxed whitespace-pre-line">{shown}</p>;
      }
      case "localizedList":
        return <div key={field.key} className="space-y-2">{(raw as unknown[]).map((line, i) => <p key={i} className="text-sm leading-relaxed">{text(line, locale)}</p>)}</div>;
      case "image": return image(raw, field.key);
      case "sites": return <p key={field.key} className="text-xs text-muted-foreground">{labels.sites ?? field.key}: {(raw as string[]).map(site => websiteSiteLabel(site, siteNames)).join(", ")}</p>;
      case "object": return isObject(raw) ? <section key={field.key} className={cn("space-y-3", depth === 0 ? "border-t pt-5 first:border-0 first:pt-0" : "")}>
        {depth === 0 && !field.fields.some(child => HEADINGS.has(child.key) && raw[child.key]) ? <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{field.siteLabel ? websiteSiteLabel(field.key, siteNames) : labels[field.label] ?? field.label}</p> : null}
        {block(field.fields, raw, depth + 1)}</section> : null;
      case "list": {
        const items = (raw as Value[]).filter(isObject);
        if (!items.length) return null;
        return <section key={field.key} className={cn("space-y-3", depth === 0 ? "border-t pt-5" : "")}>
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{labels[field.label] ?? field.label}</p>
          <div className={cn("grid gap-3", phone ? "grid-cols-1" : depth === 0 ? "grid-cols-1" : "grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]")}>
            {items.map((entry, i) => <article key={i} className="space-y-2 rounded-xl border border-border p-4">
              {typeof entry.value === "string" ? <p className="text-3xl font-semibold tabular-nums">{entry.value}{typeof entry.suffix === "string" ? entry.suffix : ""}</p> : null}
              {block(field.item, entry, depth + 1)}
            </article>)}
          </div>
        </section>;
      }
      default: return null;
    }
  });
  return <div className={cn("mx-auto space-y-5 rounded-2xl border border-border bg-background p-5 break-words", phone ? "max-w-[390px]" : "w-full")} data-page-preview={phone ? "phone" : "desktop"}>
    {block(fields, value, 0)}
  </div>;
}
