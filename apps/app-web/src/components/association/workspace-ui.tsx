"use client";

/** Task-focused catalogue controls over existing Association reads. [COMP:app-web/association] */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Search, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { AssociationField, AssociationListState, AssociationToggle, useAssociationPage } from "./operator-controls";

export function AssociationEditor({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const t = useT().associationPage;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); heading.current?.scrollIntoView?.({ block: "start" }); }, []);
  async function close() {
    if (await confirmDialog({ title: t.ux.cancelEdit, description: t.ux.cancelHelp, confirmLabel: t.cancel, cancelLabel: t.ux.keepEditing })) onClose();
  }
  return <section className="mx-auto w-full max-w-3xl space-y-5" data-association-editor>
    <div className="flex items-center justify-between gap-3"><h2 ref={heading} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none focus-visible:shadow-none focus-visible:outline-none">{title}</h2>
      <Button type="button" variant="ghost" className="min-h-11 md:min-h-8" onClick={() => void close()}><ArrowLeft aria-hidden className="size-4" />{t.cancel}</Button></div>
    {children}
  </section>;
}


function associationCurrencyDigits(currency: string) {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2; }
  catch { return 2; }
}
export function associationMoney(amount: string | number, currency: string): string {
  try {
    const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
    const digits = associationCurrencyDigits(currency), minor = BigInt(amount), scale = BigInt(10) ** BigInt(digits);
    const absolute = minor < BigInt(0) ? -minor : minor;
    const whole = minor < BigInt(0) ? -(absolute / scale) : absolute / scale;
    const parts = formatter.formatToParts(minor < BigInt(0) && whole === BigInt(0) ? -0 : whole);
    return parts.map(part => part.type === "fraction" ? (absolute % scale).toString().padStart(digits, "0") : part.value).join("");
  } catch { return `${currency} ${amount}`; }
}
export function associationAmountToMinor(value: string, currency: string): number | null {
  const digits = associationCurrencyDigits(currency);
  if (!new RegExp(`^\\d+(?:\\.\\d{0,${digits}})?$`).test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(whole!) * BigInt(10) ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0");
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}
export function AssociationMoneyField({ label, value, currency, onChange, required = false, help }: { label: string; value: number | null; currency: string; onChange: (value: number | null) => void; required?: boolean; help?: string }) {
  const t = useT().associationPage.ux, digits = associationCurrencyDigits(currency);
  const [draft, setDraft] = useState(() => value === null ? "" : Number.isSafeInteger(value) ? `${Math.floor(value / 10 ** digits)}${digits ? `.${String(value % 10 ** digits).padStart(digits, "0")}` : ""}` : "");
  const last = useRef(currency);
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => { wrapper.current?.querySelector("input")?.setCustomValidity(draft && associationAmountToMinor(draft, currency) === null ? t.moneyInvalid : ""); }, [draft, currency, t.moneyInvalid]);
  useEffect(() => { if (last.current !== currency) { last.current = currency; onChange(draft === "" ? null : associationAmountToMinor(draft, currency)); } }, [currency, draft, onChange]);
  return <div ref={wrapper}><AssociationField label={label} value={draft} inputMode="decimal" required={required} placeholder={digits ? `0.${"0".repeat(digits)}` : "0"} end={currency || undefined} help={help}
    onChange={next => { setDraft(next); onChange(next === "" ? null : associationAmountToMinor(next, currency)); }}
    /></div>;
}

/** Select named records with pagination; keep selections even outside the current page. */
export function AssociationCatalogPicker({ workspaceId, resource, selected, onChange, eventId, usePlanKeys = false, single = false }: {
  workspaceId: string; resource: "events" | "plans" | "tickets"; selected: string[]; onChange: (ids: string[]) => void; eventId?: string; usePlanKeys?: boolean; single?: boolean;
}) {
  const t = useT().associationPage, [search, setSearch] = useState("");
  const rows = useAssociationPage(workspaceId, resource, eventId ? { eventId } : {}, resource !== "tickets" || !!eventId);
  const names = useRef<Record<string, string>>({});
  const options = rows.data?.items.map(row => ({ id: usePlanKeys && "planKey" in row ? row.planKey : row.id, name: "title" in row ? row.title : row.name })) ?? [];
  for (const row of options) names.current[row.id] = row.name;
  const awaitingEvent = resource === "tickets" && !eventId;
  return <div className="col-span-full min-w-0 space-y-3">
    <div className="flex items-center gap-2"><Search aria-hidden className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><AssociationField label={t.ux.searchPage} value={search} onChange={setSearch} /></div></div>
    {selected.length > 0 && <div className="flex flex-wrap items-center gap-2" aria-label={t.ux.selected}>{selected.map(id => <Button key={id} type="button" variant="secondary" className="max-sm:min-h-11 max-w-full whitespace-normal break-words text-left" onClick={() => onChange(selected.filter(value => value !== id))} aria-label={`${t.ux.remove}: ${names.current[id] ?? id}`}>
      {names.current[id] ?? `${t.ux.retainedSelection} · ${id.slice(0, 8)}`}<X aria-hidden className="size-3 shrink-0" /></Button>)}</div>}
    {awaitingEvent ? <p className="text-sm text-muted-foreground">{t.ux.chooseEvent}</p> : <AssociationListState {...rows}><div className="max-h-56 space-y-1 overflow-y-auto">
      {options.filter(row => row.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(row => <div key={row.id} className="rounded-lg px-2 hover:bg-accent/50"><AssociationToggle label={row.name} checked={selected.includes(row.id)} disabled={!!rows.error} onChange={checked => onChange(checked ? single ? [row.id] : [...selected, row.id] : selected.filter(id => id !== row.id))} /></div>)}
      {!options.some(row => row.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <p className="py-3 text-sm text-muted-foreground">{t.ux.noMatches}</p>}
    </div></AssociationListState>}<p className="text-xs text-muted-foreground">{t.ux.pageHelp}</p>
  </div>;
}
