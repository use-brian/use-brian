/**
 * WhatsApp group ingest UI for the Studio - Events page.
 *
 * `WhatsappGroupManager` is the body of WhatsApp's detail panel in the Events
 * master-detail surface: the seen-group enable/disable list. The Events page
 * itself fetches WhatsApp's pairing status (`getWhatsappIngest`) to place the
 * WhatsApp pseudo-row in its rail and to render the "reconnect in Channels"
 * note when the linked device was logged out (pairing stays on the Channels
 * card, where the channel is added).
 *
 * The group list moved here from the WhatsApp channel card as part of the
 * Channels/Events split: Channels owns the chat/broadcast surface (connect +
 * bot/replies), Events owns ingestion. See docs/architecture/channels/whatsapp.md
 * -> "Studio UI".
 *
 * [COMP:app-web/studio-whatsapp-ingest]
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import {
  getWhatsappIngest,
  enableWhatsappGroup,
  disableWhatsappGroup,
  type WhatsappGroup,
  type WhatsappGroupRouting,
} from "@/lib/api/whatsapp-ingest";

/**
 * The group enable/disable list. A personal number can be in hundreds of
 * groups; the API returns enabled-and-recently-active first, so the initial
 * render is capped and a search finds any other by name. Routing is digest-only
 * (realtime is soft-disabled to cap token cost).
 */
export function WhatsappGroupManager({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const wa = t.studioPage.ingestRules.whatsapp;
  const [groups, setGroups] = useState<WhatsappGroup[] | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    getWhatsappIngest(workspaceId)
      .then((s) => setGroups(s.groups))
      .catch(() => setGroups([]));
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  const CAP = 12;
  const all = groups ?? [];
  const q = query.trim().toLowerCase();
  const matches = q
    ? all.filter((g) => (g.title ?? "").toLowerCase().includes(q))
    : all;
  const shown = q ? matches : matches.slice(0, CAP);
  const more = matches.length - shown.length;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {wa.groupsTitle}
      </div>
      {all.length > CAP && (
        <div className="relative">
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={wa.groupSearchPlaceholder}
            className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      )}
      {groups === null ? (
        <p className="text-xs text-muted-foreground">{wa.working}</p>
      ) : all.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {wa.groupsEmpty}
        </p>
      ) : shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">{wa.groupsNoMatch}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {shown.map((g) => (
              <WhatsappGroupRow
                key={g.chatJid}
                group={g}
                workspaceId={workspaceId}
                onChange={load}
              />
            ))}
          </ul>
          {more > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {format(wa.groupsMoreHint, { n: more })}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function WhatsappGroupRow({
  group,
  workspaceId,
  onChange,
}: {
  group: WhatsappGroup;
  workspaceId: string;
  onChange: () => void;
}) {
  const t = useT();
  const wa = t.studioPage.ingestRules.whatsapp;
  const [busy, setBusy] = useState(false);

  async function setEnabled(enabled: boolean, routing: WhatsappGroupRouting) {
    setBusy(true);
    try {
      if (enabled) await enableWhatsappGroup(workspaceId, group.chatJid, routing);
      else await disableWhatsappGroup(workspaceId, group.chatJid);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className={
        "flex items-center gap-2.5 rounded-md border px-3 py-2 transition-colors " +
        (group.enabled
          ? "border-emerald-500/40 bg-emerald-500/10"
          : "border-border bg-card")
      }
    >
      <span
        aria-hidden
        className={
          "size-2 shrink-0 rounded-full " +
          (group.enabled ? "bg-emerald-500" : "bg-muted-foreground/30")
        }
      />
      <span
        className={
          "min-w-0 flex-1 truncate text-xs " +
          (group.enabled ? "font-semibold" : "font-medium text-muted-foreground")
        }
      >
        {group.title ?? wa.untitledGroup}
      </span>
      {/* Routing is digest-only: realtime (per-message extraction) is disabled
          to cap token cost, so there's no picker - enabled groups always run on
          the weekday digest. See docs/architecture/channels/whatsapp.md ->
          "Routing (digest-only)". */}
      {group.enabled && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {wa.routingScheduled}
        </span>
      )}
      <button
        type="button"
        onClick={() => void setEnabled(!group.enabled, "scheduled")}
        disabled={busy}
        className={
          "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 " +
          (group.enabled
            ? "border border-border text-muted-foreground hover:text-destructive"
            : "bg-primary text-primary-foreground hover:bg-primary/90")
        }
      >
        {busy ? wa.working : group.enabled ? wa.disableAction : wa.enableAction}
      </button>
    </li>
  );
}
