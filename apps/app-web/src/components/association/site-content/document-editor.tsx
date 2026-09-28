"use client";
/** Descriptor-driven editor and read-only outline for website content documents. [COMP:app-web/site-content] */
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { websiteMediaPreviewUrl, websiteSiteLabel, type MembershipLocale, type WebsiteMedia } from "@/lib/api/association";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { AssociationField as Input, AssociationToggle as Toggle, AssociationChoice as Choice } from "../operator-controls";
import { blankFor, type Field } from "./descriptors";

type Value = Record<string, unknown>;
/** `sites` are the websites that read this page (from the server); `siteNames` their staff-facing names. */
export type EditorContext = { locale: MembershipLocale; media: WebsiteMedia[]; workspaceId: string; disabled?: boolean; sites: readonly string[]; siteNames: Record<string, string> };

function useLabels() {
  const c = useT().associationPage.content;
  const fields = c.fields as Record<string, string>;
  return { c, label: (key: string) => fields[key] ?? key };
}

const isObject = (value: unknown): value is Value => typeof value === "object" && value !== null && !Array.isArray(value);
const localizedText = (value: unknown, locale: MembershipLocale): string => isObject(value) && typeof value[locale] === "string" ? String(value[locale]) : "";

function withKey(object: Value, key: string, next: unknown): Value {
  const copy = { ...object };
  if (next === undefined) delete copy[key]; else copy[key] = next;
  return copy;
}

function LocalizedInput({ label, value, onChange, context, optional, multiline, anyLanguage }: { label: string; value: unknown; onChange: (next: unknown) => void; context: EditorContext; optional?: boolean; multiline?: boolean; anyLanguage?: boolean }) {
  const { c } = useLabels();
  const english = localizedText(value, "en");
  const current = localizedText(value, context.locale);
  const fallback = context.locale !== "en" && !current;
  function change(text: string) {
    const base: Value = isObject(value) ? { ...value } : { en: "" };
    if (context.locale !== "en" && !text) delete base[context.locale]; else base[context.locale] = text;
    const empty = !String(base.en ?? "") && !base["zh-Hant"] && !base["zh-Hans"];
    onChange(optional && empty ? undefined : base);
  }
  return <Input label={label} value={current} onChange={change} multiline={multiline} disabled={context.disabled}
    placeholder={context.locale !== "en" ? english : undefined}
    help={fallback && english ? c.englishShown : context.locale === "en" && !optional && !anyLanguage && !english ? c.englishRequired : undefined}/>;
}

export function MediaThumb({ workspaceId, id, mime }: { workspaceId: string; id: string; mime?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (mime && !mime.startsWith("image/")) return;
    let live = true;
    websiteMediaPreviewUrl(workspaceId, id).then(value => { if (live) setUrl(value); }).catch(() => undefined);
    return () => { live = false; };
  }, [workspaceId, id, mime]);
  // eslint-disable-next-line @next/next/no-img-element -- signed storage URL preview
  return url ? <img src={url} alt="" className="h-16 w-24 rounded-md bg-muted object-cover"/> : <div className="h-16 w-24 rounded-md bg-muted"/>;
}

export function MediaChoice({ label, value, onChange, context, images }: { label: string; value: string | undefined; onChange: (id: string | undefined) => void; context: EditorContext; images: boolean }) {
  const { c } = useLabels();
  const options = context.media.filter(item => images ? item.mime.startsWith("image/") : true);
  const chosen = options.find(item => item.id === value);
  return <div className="flex flex-wrap items-end gap-3">
    {value ? <MediaThumb workspaceId={context.workspaceId} id={value} mime={chosen?.mime}/> : null}
    <div className="min-w-48 flex-1"><Choice label={label} value={value ?? ""} disabled={context.disabled}
      values={["", ...options.map(item => item.id), ...(value && !chosen ? [value] : [])]}
      labels={{ "": c.noFile, ...Object.fromEntries(options.map(item => [item.id, item.name])), ...(value && !chosen ? { [value]: c.missingFile } : {}) }}
      onChange={next => onChange(next || undefined)}/></div>
  </div>;
}

function ImageInput({ label, value, onChange, context, optional }: { label: string; value: unknown; onChange: (next: unknown) => void; context: EditorContext; optional?: boolean }) {
  const { c, label: text } = useLabels();
  if (!isObject(value)) return optional
    ? <Button type="button" variant="outline" className="min-h-11 w-fit" disabled={context.disabled} onClick={() => onChange({ alt: { en: "" } })}>{c.addImage}: {label}</Button>
    : null;
  const choose = (id: string | undefined) => {
    const next: Value = { ...value };
    delete next.src; delete next.mediaId;
    if (id) next.mediaId = id; else if (typeof value.src === "string") next.src = value.src;
    onChange(next);
  };
  return <fieldset className="space-y-3 rounded-lg border border-dashed p-3">
    <legend className="px-1 text-sm font-medium">{label}</legend>
    {typeof value.src === "string" && !value.mediaId ? <p className="text-xs text-muted-foreground">{c.siteFile}: <code>{value.src}</code></p> : null}
    <MediaChoice label={c.library} value={typeof value.mediaId === "string" ? value.mediaId : undefined} onChange={choose} context={context} images/>
    <LocalizedInput label={text("alt")} value={value.alt} context={context} onChange={alt => onChange({ ...value, alt: alt ?? { en: "" } })}/>
    {optional && <Button type="button" variant="ghost" className="min-h-11 w-fit text-destructive" disabled={context.disabled} onClick={() => onChange(undefined)}>{c.removeImage}</Button>}
  </fieldset>;
}

function ListInput({ field, value, onChange, context }: { field: Extract<Field, { kind: "list" }>; value: unknown; onChange: (next: unknown) => void; context: EditorContext }) {
  const { c, label } = useLabels();
  const items = Array.isArray(value) ? (value as Value[]) : [];
  const move = (index: number, delta: number) => {
    const next = [...items]; const [item] = next.splice(index, 1); next.splice(index + delta, 0, item); onChange(next);
  };
  return <section className="space-y-2">
    <h4 className="text-sm font-semibold">{label(field.label)} <span className="font-normal text-muted-foreground">({items.length})</span></h4>
    <ul className="space-y-2">{items.map((item, index) => <li key={index}>
      <details className="rounded-lg border">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm"><span className="min-w-0 flex-1 truncate">{field.itemTitle(item) || `#${index + 1}`}</span></summary>
        <div className="space-y-3 border-t p-3">
          <FieldsEditor fields={field.item} value={item} context={context} onChange={next => onChange(items.map((old, i) => i === index ? next : old))}/>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" disabled={context.disabled || index === 0} aria-label={c.moveUp} onClick={() => move(index, -1)}><ArrowUp aria-hidden className="size-4"/></Button>
            <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" disabled={context.disabled || index === items.length - 1} aria-label={c.moveDown} onClick={() => move(index, 1)}><ArrowDown aria-hidden className="size-4"/></Button>
            <Button type="button" size="sm" variant="ghost" className="min-h-11 text-destructive md:min-h-8" disabled={context.disabled} onClick={() => onChange(items.filter((_, i) => i !== index))}><Trash2 aria-hidden className="size-4"/>{c.remove}</Button>
          </div>
        </div>
      </details>
    </li>)}</ul>
    <Button type="button" variant="outline" className="min-h-11 w-fit" disabled={context.disabled} onClick={() => { const next = field.blank(); onChange([...items, Array.isArray(next.sites) && next.sites.length === 0 ? { ...next, sites: context.sites.slice(0, 1) } : next]); }}>{c.add}: {label(field.label)}</Button>
  </section>;
}

function FieldInput({ field, value, onChange, context }: { field: Field; value: unknown; onChange: (next: unknown) => void; context: EditorContext }) {
  const { c, label } = useLabels();
  const name = field.kind === "object" && field.siteLabel ? websiteSiteLabel(field.key, context.siteNames) : label(field.label);
  switch (field.kind) {
    case "text":
      return <Input label={name} type={field.type === "email" ? "email" : field.type === "date" ? "date" : "text"} value={typeof value === "string" ? value : ""} multiline={field.multiline} disabled={context.disabled}
        onChange={text => onChange(field.optional && !text ? undefined : text)}/>;
    case "localized":
      return <LocalizedInput label={name} value={value} onChange={onChange} context={context} optional={field.optional} multiline={field.multiline} anyLanguage={field.anyLanguage}/>;
    case "locales": {
      const listed = Array.isArray(value) ? (value as string[]) : ["en", "zh-Hant", "zh-Hans"];
      const names: Record<string, string> = { en: "English", "zh-Hant": "繁體中文", "zh-Hans": "简体中文" };
      return <fieldset className="flex flex-wrap items-center gap-4"><legend className="text-sm">{name}</legend>
        {(["en", "zh-Hant", "zh-Hans"] as const).map(locale => <Toggle key={locale} label={names[locale]} checked={listed.includes(locale)} disabled={context.disabled || (listed.length === 1 && listed.includes(locale))}
          onChange={on => onChange(on ? [...new Set([...listed, locale])] : listed.filter(item => item !== locale))}/>)}
      </fieldset>;
    }
    case "number":
      return <Input label={name} type="number" min={field.min} max={field.max} value={typeof value === "number" ? String(value) : ""} disabled={context.disabled}
        onChange={text => onChange(text === "" ? field.min ?? 0 : Number(text))}/>;
    case "boolean":
      return <Toggle label={name} checked={value === true} disabled={context.disabled} onChange={onChange}/>;
    case "select":
      return <Choice label={name} value={typeof value === "string" ? value : field.values[0]} values={field.values} disabled={context.disabled} onChange={onChange}/>;
    case "sites": {
      const sites = Array.isArray(value) ? (value as string[]) : [];
      return <fieldset className="flex flex-wrap items-center gap-4"><legend className="text-sm">{name}</legend>
        {context.sites.map(site => <Toggle key={site} label={websiteSiteLabel(site, context.siteNames)} checked={sites.includes(site)} disabled={context.disabled}
          onChange={on => onChange(on ? [...new Set([...sites, site])] : sites.filter(s => s !== site))}/>)}
      </fieldset>;
    }
    case "image":
      return <ImageInput label={name} value={value} onChange={onChange} context={context} optional={field.optional}/>;
    case "media":
      return <MediaChoice label={name} value={typeof value === "string" ? value : undefined} onChange={onChange} context={context} images={false}/>;
    case "localizedList": {
      const items = Array.isArray(value) ? value : [];
      return <section className="space-y-2"><h4 className="text-sm font-semibold">{name}</h4>
        {items.map((item, index) => <div key={index} className="flex items-start gap-2"><div className="min-w-0 flex-1">
          <LocalizedInput label={`${name} ${index + 1}`} value={item} multiline context={context} onChange={next => onChange(items.map((old, i) => i === index ? next ?? { en: "" } : old))}/></div>
          <Button type="button" size="sm" variant="ghost" className="mt-6 min-h-11 text-destructive md:min-h-8" aria-label={c.remove} disabled={context.disabled} onClick={() => onChange(items.filter((_, i) => i !== index))}><Trash2 aria-hidden className="size-4"/></Button>
        </div>)}
        <Button type="button" variant="outline" className="min-h-11 w-fit" disabled={context.disabled} onClick={() => onChange([...items, { en: "" }])}>{c.add}: {name}</Button>
      </section>;
    }
    case "list":
      return <ListInput field={field} value={value} onChange={onChange} context={context}/>;
    case "object": {
      if (!isObject(value)) return field.optional
        ? <Toggle label={`${c.include}: ${name}`} checked={false} disabled={context.disabled} onChange={on => { if (on) onChange(blankFor(field)); }}/>
        : null;
      return <fieldset className="space-y-3 rounded-xl border p-4"><legend className="px-1 font-semibold">{name}</legend>
        {field.optional && <Toggle label={`${c.include}: ${name}`} checked disabled={context.disabled} onChange={on => { if (!on) onChange(undefined); }}/>}
        <FieldsEditor fields={field.fields} value={value} onChange={onChange} context={context}/>
      </fieldset>;
    }
  }
}

export function FieldsEditor({ fields, value, onChange, context }: { fields: Field[]; value: Value; onChange: (next: Value) => void; context: EditorContext }) {
  return <div className="space-y-4">{fields.map(field =>
    <FieldInput key={field.key} field={field} value={value[field.key]} context={context} onChange={next => onChange(withKey(value, field.key, next))}/>)}</div>;
}

/** Read-only outline used by the before/after preview. */
export function DocumentOutline({ fields, value, locale, siteNames = {} }: { fields: Field[]; value: Value | null | undefined; locale: MembershipLocale; siteNames?: Record<string, string> }) {
  const { c, label } = useLabels();
  if (!value) return <p className="text-sm text-muted-foreground">{c.nothingPublished}</p>;
  const show = (field: Field, raw: unknown): React.ReactNode => {
    if (raw === undefined || raw === null || raw === "") return null;
    const name = field.kind === "object" && field.siteLabel ? websiteSiteLabel(field.key, siteNames) : label(field.label);
    switch (field.kind) {
      case "localized": {
        const text = localizedText(raw, locale) || localizedText(raw, "en");
        return <p><span className="text-muted-foreground">{name}:</span> {text}{locale !== "en" && !localizedText(raw, locale) ? <span className="text-xs text-muted-foreground"> ({c.englishShown})</span> : null}</p>;
      }
      case "image": return isObject(raw) ? <p><span className="text-muted-foreground">{name}:</span> {raw.mediaId ? c.library : String(raw.src ?? "")}</p> : null;
      case "sites": return <p><span className="text-muted-foreground">{name}:</span> {(raw as string[]).map(site => websiteSiteLabel(site, siteNames)).join(" · ")}</p>;
      case "locales": return <p><span className="text-muted-foreground">{name}:</span> {(raw as string[]).join(" · ")}</p>;
      case "boolean": return <p><span className="text-muted-foreground">{name}:</span> {raw ? "✓" : "—"}</p>;
      case "localizedList": return <div><p className="text-muted-foreground">{name}:</p>{(raw as unknown[]).map((item, i) => <p key={i} className="pl-3">{localizedText(item, locale) || localizedText(item, "en")}</p>)}</div>;
      case "list": return <div><p className="font-medium">{name} ({(raw as unknown[]).length})</p><ol className="list-inside list-decimal space-y-1 pl-3">{(raw as Value[]).map((item, i) => <li key={i}>{field.itemTitle(item)}</li>)}</ol></div>;
      case "object": return isObject(raw) ? <div className="space-y-1 border-l pl-3"><p className="font-medium">{name}</p>{field.fields.map(child => <div key={child.key}>{show(child, raw[child.key])}</div>)}</div> : null;
      default: return <p><span className="text-muted-foreground">{name}:</span> {String(raw)}</p>;
    }
  };
  return <div className="space-y-2 text-sm break-words">{fields.map(field => <div key={field.key}>{show(field, value[field.key])}</div>)}</div>;
}
