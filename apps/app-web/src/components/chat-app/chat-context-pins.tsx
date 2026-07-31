"use client";

/**
 * Pinned room context — the chip row (multiplayer chat P1b, T16/D10).
 *
 * ONE slim collapsible row under the room header: kind-iconed chips for the
 * room's working frame (pages, tasks, contacts, companies, deals, URLs,
 * background instructions), overflow collapsing to a count, a chip popover
 * with detail + Unpin, and one `+ Add` picker (brain-primitive search / URL /
 * instruction). Neatness is the spec — no side panel, no second surface.
 *
 * Data flows through `lib/api/session-pins.ts`; the parent bumps
 * `refreshKey` off the room stream's `pins_changed` signal so every viewer's
 * row updates live (signals, never data). Labels resolve server-side under
 * the SESSION's clearance; a `null` label renders the unavailable chip state
 * rather than hiding the pin. File pins are API-supported but the picker
 * defers them (no client file-list SDK yet); attachments on posts are
 * deferred with them.
 *
 * Spec: docs/architecture/features/chat-app.md → "Pinned room context".
 * [COMP:app-web/chat-context-pins]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeDollarSign,
  Building2,
  FileText,
  Link as LinkIcon,
  Paperclip,
  Pin,
  Plus,
  SquareCheck,
  StickyNote,
  User,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  addSessionPin,
  listSessionPins,
  removeSessionPin,
  type SessionPinKind,
  type SessionPinRow,
} from "@/lib/api/session-pins";
import { listViews } from "@/lib/api/views";
import { fetchWorkspaceTasks } from "@/lib/api/tasks";
import { fetchWorkspaceCrm } from "@/lib/api/crm";

const KIND_ICON: Record<SessionPinKind, typeof Pin> = {
  page: FileText,
  task: SquareCheck,
  contact: User,
  company: Building2,
  deal: BadgeDollarSign,
  file: Paperclip,
  url: LinkIcon,
  instruction: StickyNote,
};

/** Chips shown before the overflow count takes over. */
const MAX_VISIBLE = 8;

type PickerKind = "page" | "task" | "contact" | "company" | "deal" | "url" | "instruction";
const PICKER_KINDS: PickerKind[] = ["page", "task", "contact", "company", "deal", "url", "instruction"];

type Candidate = { id: string; label: string };

export function ChatContextPins({
  sessionId,
  workspaceId,
  refreshKey,
}: {
  sessionId: string;
  workspaceId: string;
  refreshKey: number;
}) {
  const t = useT().chatApp.pins;
  const [pins, setPins] = useState<SessionPinRow[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [openPinId, setOpenPinId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pickKind, setPickKind] = useState<PickerKind>("page");
  const [search, setSearch] = useState("");
  const [urlValue, setUrlValue] = useState("");
  const [instructionValue, setInstructionValue] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPins(await listSessionPins(sessionId));
    } catch {
      // Keep the last known row — a transient failure must not empty it.
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  // Candidate lists load lazily per picked kind (client-side filter — the
  // flat-read SDKs the operator surfaces already use).
  useEffect(() => {
    if (!addOpen || pickKind === "url" || pickKind === "instruction") return;
    let cancelled = false;
    setCandidates(null);
    void (async () => {
      try {
        let rows: Candidate[] = [];
        if (pickKind === "page") {
          const views = await listViews({ workspaceId });
          rows = views.map((v) => ({ id: v.id, label: v.name }));
        } else if (pickKind === "task") {
          const tasks = await fetchWorkspaceTasks(workspaceId);
          rows = tasks.map((task) => ({ id: task.id, label: task.title }));
        } else {
          const crm = await fetchWorkspaceCrm(workspaceId);
          const source =
            pickKind === "contact"
              ? crm.contacts
              : pickKind === "company"
                ? crm.companies
                : crm.deals;
          rows = source.map((r) => ({ id: r.id, label: r.name }));
        }
        if (!cancelled) setCandidates(rows);
      } catch {
        if (!cancelled) setCandidates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addOpen, pickKind, workspaceId]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = candidates ?? [];
    return (needle ? list.filter((c) => c.label.toLowerCase().includes(needle)) : list).slice(0, 8);
  }, [candidates, search]);

  const addPin = useCallback(
    async (
      pin:
        | { kind: Exclude<SessionPinKind, "url" | "instruction">; refId: string }
        | { kind: "url"; url: string }
        | { kind: "instruction"; text: string },
    ) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await addSessionPin(sessionId, pin);
        setAddOpen(false);
        setSearch("");
        setUrlValue("");
        setInstructionValue("");
        await refresh();
      } catch {
        setError(t.addFailed);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, sessionId, t],
  );

  const unpin = useCallback(
    async (pinId: string) => {
      setOpenPinId(null);
      try {
        await removeSessionPin(sessionId, pinId);
        await refresh();
      } catch {
        setError(t.removeFailed);
      }
    },
    [refresh, sessionId, t],
  );

  const kindLabel = (kind: SessionPinKind): string =>
    kind === "page"
      ? t.kindPage
      : kind === "task"
        ? t.kindTask
        : kind === "contact"
          ? t.kindContact
          : kind === "company"
            ? t.kindCompany
            : kind === "deal"
              ? t.kindDeal
              : kind === "url"
                ? t.kindUrl
                : kind === "instruction"
                  ? t.kindInstruction
                  : kind;

  const chipLabel = (pin: SessionPinRow): string =>
    pin.label ?? (pin.kind === "url" ? (pin.url ?? "") : t.unavailable);

  const visible = expanded ? pins : pins.slice(0, MAX_VISIBLE);
  const overflow = pins.length - visible.length;

  return (
    <div
      aria-label={t.rowAria}
      className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/20 px-4 py-1"
    >
      <Pin className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
      {visible.map((pin) => {
        const Icon = KIND_ICON[pin.kind] ?? Pin;
        return (
          <Popover
            key={pin.id}
            open={openPinId === pin.id}
            onOpenChange={(open) => setOpenPinId(open ? pin.id : null)}
          >
            <PopoverTrigger
              className={cn(
                "flex max-w-[180px] min-w-0 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5",
                "text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:shadow-none",
                pin.label === null && pin.kind !== "url" && "opacity-60 italic",
              )}
            >
              <Icon className="size-3 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{chipLabel(pin)}</span>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 space-y-1.5 p-2.5 text-xs">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {kindLabel(pin.kind)}
              </div>
              <div className="break-words text-foreground">
                {pin.kind === "instruction" ? pin.text : chipLabel(pin)}
              </div>
              {pin.kind === "url" && pin.url && (
                <a
                  href={pin.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate text-primary underline-offset-2 hover:underline"
                >
                  {pin.url}
                </a>
              )}
              {pin.addedByName && (
                <div className="text-muted-foreground">
                  {format(t.addedBy, { name: pin.addedByName })}
                </div>
              )}
              <button
                type="button"
                onClick={() => void unpin(pin.id)}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10"
              >
                <X className="size-3" aria-hidden />
                {t.remove}
              </button>
            </PopoverContent>
          </Popover>
        );
      })}
      {overflow > 0 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="rounded-full px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {format(t.overflow, { count: overflow })}
        </button>
      )}
      <Popover open={addOpen} onOpenChange={setAddOpen}>
        <PopoverTrigger
          aria-label={t.pickerTitle}
          className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:shadow-none"
        >
          <Plus className="size-3" aria-hidden />
          {t.add}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 space-y-2 p-2.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t.pickerTitle}
          </div>
          <div className="flex flex-wrap gap-1">
            {PICKER_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setPickKind(kind)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                  pickKind === kind
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {kindLabel(kind)}
              </button>
            ))}
          </div>
          {pickKind === "url" ? (
            <div className="space-y-1.5">
              <input
                type="url"
                value={urlValue}
                onChange={(e) => setUrlValue(e.target.value)}
                placeholder={t.urlPlaceholder}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring/40"
              />
              <button
                type="button"
                disabled={busy || !urlValue.trim()}
                onClick={() => void addPin({ kind: "url", url: urlValue.trim() })}
                className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
              >
                {t.pinAction}
              </button>
            </div>
          ) : pickKind === "instruction" ? (
            <div className="space-y-1.5">
              <textarea
                value={instructionValue}
                onChange={(e) => setInstructionValue(e.target.value)}
                placeholder={t.instructionPlaceholder}
                rows={3}
                maxLength={2000}
                className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring/40"
              />
              <button
                type="button"
                disabled={busy || !instructionValue.trim()}
                onClick={() =>
                  void addPin({ kind: "instruction", text: instructionValue.trim() })
                }
                className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
              >
                {t.pinAction}
              </button>
            </div>
          ) : (
            <div className="space-y-1">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t.searchPlaceholder}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring/40"
              />
              <div className="max-h-44 overflow-y-auto">
                {filtered.length === 0 && candidates !== null && (
                  <p className="px-1 py-1.5 text-[11px] text-muted-foreground">{t.noResults}</p>
                )}
                {filtered.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void addPin({ kind: pickKind, refId: c.id })}
                    className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {error && <p className="text-[11px] text-destructive">{error}</p>}
        </PopoverContent>
      </Popover>
    </div>
  );
}
