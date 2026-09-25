/** Field descriptors for website content collections. They mirror the core
 * schemas in `packages/core/src/association/site-content.ts`; the server remains
 * the validator. [COMP:app-web/site-content] */
import type { SiteContentCollection, SiteContentDocument } from "@/lib/api/association";

type FieldLabel = string; // key into associationPage.content.fields
export type Field =
  | { kind: "text"; key: string; label: FieldLabel; optional?: boolean; multiline?: boolean; type?: "email" | "date" | "url" }
  | { kind: "localized"; key: string; label: FieldLabel; optional?: boolean; multiline?: boolean; anyLanguage?: boolean }
  | { kind: "locales"; key: string; label: FieldLabel }
  | { kind: "number"; key: string; label: FieldLabel; min?: number; max?: number }
  | { kind: "boolean"; key: string; label: FieldLabel }
  | { kind: "select"; key: string; label: FieldLabel; values: readonly string[] }
  | { kind: "sites"; key: string; label: FieldLabel }
  | { kind: "image"; key: string; label: FieldLabel; optional?: boolean }
  | { kind: "media"; key: string; label: FieldLabel; optional?: boolean }
  | { kind: "object"; key: string; label: FieldLabel; fields: Field[]; optional?: boolean }
  | { kind: "list"; key: string; label: FieldLabel; item: Field[]; itemTitle: (item: Record<string, unknown>) => string; blank: () => Record<string, unknown> }
  | { kind: "localizedList"; key: string; label: FieldLabel };

const L = (en = "") => ({ en });
const en = (value: unknown) => typeof value === "object" && value && "en" in value ? String((value as { en: unknown }).en ?? "") : "";
const order = (): Field => ({ kind: "number", key: "order", label: "order", min: 0, max: 10000 });
const link: Field[] = [{ kind: "localized", key: "label", label: "label" }, { kind: "text", key: "href", label: "href" }];
const stat: Field[] = [{ kind: "text", key: "value", label: "value" }, { kind: "text", key: "suffix", label: "suffix", optional: true }, { kind: "localized", key: "label", label: "label" }];
const statsList: Field = { kind: "list", key: "stats", label: "stats", item: stat, itemTitle: item => `${item.value ?? ""}${item.suffix ?? ""} ${en(item.label)}`, blank: () => ({ value: "", suffix: "", label: L() }) };

const person: Field[] = [
  { kind: "text", key: "id", label: "id" }, { kind: "text", key: "name", label: "name" }, { kind: "text", key: "honorific", label: "honorific", optional: true },
  { kind: "localized", key: "localizedName", label: "localizedName", optional: true },
  { kind: "localized", key: "role", label: "role", optional: true }, { kind: "localized", key: "affiliation", label: "affiliation", optional: true },
  { kind: "localized", key: "specialties", label: "specialties", optional: true }, { kind: "text", key: "admittedOn", label: "admittedOn", optional: true, type: "date" },
  { kind: "image", key: "image", label: "image", optional: true }, { kind: "localized", key: "bio", label: "bio", optional: true, multiline: true },
];
const siteSettings: Field[] = [
  { kind: "object", key: "contact", label: "contact", fields: [
    { kind: "text", key: "email", label: "email", type: "email" }, { kind: "text", key: "phone", label: "phone", optional: true },
    { kind: "localized", key: "address", label: "address", multiline: true }, { kind: "localized", key: "hours", label: "hours", optional: true },
  ] },
  { kind: "localized", key: "legalLine", label: "legalLine" },
  { kind: "list", key: "social", label: "social", item: link, itemTitle: item => en(item.label), blank: () => ({ label: L(), href: "https://" }) },
  { kind: "number", key: "responseDays", label: "responseDays", min: 1, max: 30 },
  { kind: "object", key: "ymp", label: "ymp", optional: true, fields: [{ kind: "boolean", key: "open", label: "open" }, { kind: "localized", key: "cohortLabel", label: "cohortLabel" }] },
  { kind: "list", key: "directory", label: "directory", item: [
    { kind: "text", key: "id", label: "id" }, { kind: "text", key: "name", label: "name" }, { kind: "localized", key: "role", label: "role" },
    { kind: "text", key: "email", label: "email", optional: true, type: "email" }, { kind: "text", key: "phone", label: "phone", optional: true },
  ], itemTitle: item => String(item.name ?? ""), blank: () => ({ id: "", name: "", role: L() }) },
];
const blankSettings = () => ({ contact: { email: "", phone: "", address: L() }, legalLine: L(), social: [], responseDays: 3, directory: [] });

export const COLLECTION_FIELDS: Record<SiteContentCollection, Field[]> = {
  people: [{ kind: "list", key: "groups", label: "groups", itemTitle: item => en(item.title), blank: () => ({ key: "", sites: ["oasa"], title: L(), term: "", order: 0, members: [] }), item: [
    { kind: "text", key: "key", label: "key" }, { kind: "sites", key: "sites", label: "sites" }, { kind: "localized", key: "title", label: "title" },
    { kind: "localized", key: "intro", label: "intro", optional: true, multiline: true }, { kind: "text", key: "term", label: "term", optional: true }, order(),
    { kind: "list", key: "members", label: "members", item: person, itemTitle: item => `${item.honorific ? `${item.honorific} ` : ""}${item.name ?? ""}`, blank: () => ({ id: "", name: "", honorific: "" }) },
  ] }],
  partners: [{ kind: "list", key: "partners", label: "partners", itemTitle: item => String(item.name ?? ""), blank: () => ({ id: "", name: "", logo: { alt: L() }, sites: ["oasa"], active: true, order: 0 }), item: [
    { kind: "text", key: "id", label: "id" }, { kind: "text", key: "name", label: "name" }, { kind: "image", key: "logo", label: "logo" },
    { kind: "text", key: "href", label: "href", optional: true }, { kind: "sites", key: "sites", label: "sites" }, { kind: "boolean", key: "active", label: "active" }, order(),
  ] }],
  settings: [{ kind: "object", key: "sites", label: "sites", fields: [
    { kind: "object", key: "oasa", label: "oasa", optional: true, fields: siteSettings },
    { kind: "object", key: "sea", label: "sea", optional: true, fields: siteSettings },
  ] }],
  news: [{ kind: "list", key: "items", label: "items", itemTitle: item => `${item.date ?? ""} · ${en(item.title)}`, blank: () => ({ id: "", sites: ["oasa"], kind: "newsletter", date: "", locales: ["en", "zh-Hant", "zh-Hans"], title: L() }), item: [
    { kind: "text", key: "id", label: "id" }, { kind: "sites", key: "sites", label: "sites" }, { kind: "select", key: "kind", label: "kind", values: ["newsletter", "press", "article", "publication"] },
    { kind: "text", key: "date", label: "date", type: "date" }, { kind: "locales", key: "locales", label: "locales" }, { kind: "localized", key: "title", label: "title", anyLanguage: true }, { kind: "localized", key: "summary", label: "summary", optional: true, multiline: true, anyLanguage: true },
    { kind: "localized", key: "category", label: "category", optional: true },
    { kind: "text", key: "href", label: "href", optional: true }, { kind: "media", key: "fileId", label: "fileId", optional: true }, { kind: "image", key: "image", label: "image", optional: true },
  ] }],
  "home-oasa": [
    { kind: "object", key: "hero", label: "hero", fields: [
      { kind: "localized", key: "kicker", label: "kicker" }, { kind: "localized", key: "title", label: "title" }, { kind: "localized", key: "body", label: "body", multiline: true },
      { kind: "localized", key: "note", label: "note", optional: true }, { kind: "localized", key: "noteStrong", label: "noteStrong", optional: true },
    ] },
    statsList,
    { kind: "object", key: "about", label: "about", fields: [{ kind: "localized", key: "heading", label: "heading" }, { kind: "localized", key: "lead", label: "lead", multiline: true }] },
    { kind: "list", key: "principles", label: "principles", item: [{ kind: "localized", key: "name", label: "name" }, { kind: "localized", key: "text", label: "body", multiline: true }], itemTitle: item => en(item.name), blank: () => ({ name: L(), text: L() }) },
    { kind: "list", key: "audiences", label: "audiences", item: [
      { kind: "select", key: "key", label: "key", values: ["students", "schools", "corporates"] }, { kind: "localized", key: "name", label: "name" },
      { kind: "localized", key: "short", label: "short" }, { kind: "localized", key: "focus", label: "focus" }, { kind: "image", key: "image", label: "image", optional: true },
    ], itemTitle: item => en(item.name), blank: () => ({ key: "students", name: L(), short: L(), focus: L() }) },
    { kind: "list", key: "programmes", label: "programmes", item: [
      { kind: "text", key: "slug", label: "slug" }, { kind: "localized", key: "name", label: "name" }, { kind: "localized", key: "short", label: "short" },
      { kind: "localized", key: "description", label: "description", multiline: true }, { kind: "image", key: "image", label: "image", optional: true },
    ], itemTitle: item => en(item.name), blank: () => ({ slug: "", name: L(), short: L(), description: L() }) },
    { kind: "object", key: "endorsement", label: "endorsement", optional: true, fields: [{ kind: "localized", key: "quote", label: "quote", multiline: true }, { kind: "text", key: "by", label: "by" }, { kind: "localized", key: "role", label: "role" }] },
    { kind: "list", key: "testimonials", label: "testimonials", item: [{ kind: "localized", key: "quote", label: "quote", multiline: true }, { kind: "text", key: "name", label: "name" }, { kind: "localized", key: "detail", label: "detail", optional: true }], itemTitle: item => String(item.name ?? ""), blank: () => ({ quote: L(), name: "" }) },
    { kind: "object", key: "newsletter", label: "newsletter", fields: [{ kind: "localized", key: "heading", label: "heading" }, { kind: "localized", key: "body", label: "body", multiline: true }] },
    { kind: "object", key: "footer", label: "footer", fields: [{ kind: "localized", key: "heading", label: "heading" }] },
  ],
  "home-sea": [
    { kind: "object", key: "hero", label: "hero", fields: [
      { kind: "localized", key: "eyebrow", label: "eyebrow" }, { kind: "localized", key: "title", label: "title" }, { kind: "localized", key: "mission", label: "mission", multiline: true }, { kind: "image", key: "image", label: "image" },
    ] },
    { kind: "object", key: "foundation", label: "foundation", fields: [
      { kind: "localized", key: "eyebrow", label: "eyebrow" }, { kind: "localized", key: "title", label: "title" }, { kind: "localized", key: "body", label: "body", multiline: true },
      { kind: "image", key: "poster", label: "poster", optional: true }, { kind: "text", key: "posterHref", label: "href", optional: true },
    ] },
    statsList,
    { kind: "object", key: "chairman", label: "chairman", fields: [
      { kind: "text", key: "name", label: "name" }, { kind: "localized", key: "role", label: "role" }, { kind: "image", key: "image", label: "image" },
      { kind: "localized", key: "eyebrow", label: "eyebrow" }, { kind: "localized", key: "title", label: "title" },
      { kind: "localizedList", key: "paragraphs", label: "paragraphs" }, { kind: "localized", key: "quote", label: "quote", optional: true, multiline: true },
      { kind: "localizedList", key: "closing", label: "closing" },
    ] },
    { kind: "object", key: "programmes", label: "programmes", fields: [
      { kind: "localized", key: "eyebrow", label: "eyebrow" }, { kind: "localized", key: "title", label: "title" }, { kind: "localized", key: "subtitle", label: "subtitle", multiline: true },
      { kind: "list", key: "cards", label: "cards", item: [{ kind: "text", key: "icon", label: "icon" }, { kind: "localized", key: "title", label: "title" }, { kind: "localized", key: "body", label: "body", multiline: true }, { kind: "text", key: "href", label: "href" }],
        itemTitle: item => en(item.title), blank: () => ({ icon: "star", title: L(), body: L(), href: "/" }) },
    ] },
    { kind: "object", key: "membership", label: "membership", fields: [
      { kind: "localized", key: "eyebrow", label: "eyebrow" }, { kind: "localized", key: "title", label: "title" }, { kind: "localized", key: "body", label: "body", multiline: true },
      { kind: "list", key: "actions", label: "actions", item: link, itemTitle: item => en(item.label), blank: () => ({ label: L(), href: "/" }) },
    ] },
  ],
};

/** A valid starting document for an empty collection. */
export function blankDocument(collection: SiteContentCollection): SiteContentDocument {
  switch (collection) {
    case "people": return { schemaVersion: 1, groups: [] };
    case "partners": return { schemaVersion: 1, partners: [] };
    case "settings": return { schemaVersion: 1, sites: { oasa: blankSettings() } };
    case "news": return { schemaVersion: 1, items: [] };
    case "home-oasa": return { schemaVersion: 1, hero: { kicker: L(), title: L(), body: L() }, stats: [], about: { heading: L(), lead: L() }, principles: [], audiences: [], programmes: [], testimonials: [], newsletter: { heading: L(), body: L() }, footer: { heading: L() } };
    case "home-sea": return { schemaVersion: 1, hero: { eyebrow: L(), title: L(), mission: L(), image: { alt: L() } }, foundation: { eyebrow: L(), title: L(), body: L() }, stats: [],
      chairman: { name: "", role: L(), image: { alt: L() }, eyebrow: L(), title: L(), paragraphs: [], closing: [] },
      programmes: { eyebrow: L(), title: L(), subtitle: L(), cards: [] }, membership: { eyebrow: L(), title: L(), body: L(), actions: [] } };
  }
}

/** Starting value when an optional object is switched on. */
export function blankFor(field: Field): unknown {
  switch (field.kind) {
    case "localized": return L();
    case "image": return { alt: L() };
    case "object": return Object.fromEntries(field.fields.filter(child => !("optional" in child && child.optional)).map(child => [child.key, blankFor(child)]));
    case "list": case "localizedList": return [];
    case "number": return field.min ?? 0;
    case "boolean": return false;
    case "select": return field.values[0];
    case "sites": return ["oasa"];
    case "locales": return ["en", "zh-Hant", "zh-Hans"];
    default: return "";
  }
}
