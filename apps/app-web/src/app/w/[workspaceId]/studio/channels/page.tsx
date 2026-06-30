"use client";

/**
 * Studio → Channels section (app-web).
 *
 * Ported from `apps/web/src/app/(app)/studio/channels/page.tsx` for the app
 * consolidation (docs/plans/doc-web-app-consolidation.md §9 #5, CHUNK 4).
 * Rendered inside the Studio full-page layout, NOT the doc three-column
 * page shell.
 *
 * The workspace-channels operator surface (Phase D of
 * docs/architecture/channels/adapter-pattern.md). Channels are owned by the
 * workspace — this page lists them, edits each one's clearance and enabled
 * capabilities, and wires per-surface assistant routing. Channels are
 * *created* by connecting a bot from the inline "+ Add channel" form; there is
 * no separate "new channel" page.
 *
 * app-web deltas vs apps/web:
 *   - `activeId` comes from the app-web `useWorkspaces()` adapter (route-
 *     derived id + fetched workspace list); the Studio layout mounts
 *     `useWorkspaceFetch` so the plan-gated `RoutingModelPicker` resolves
 *     `workspaces`.
 *   - Channels SDK is the local mirror (`@/lib/api/channels`); `buildManifest`
 *     comes from the ported `@/components/slack-setup-inline`.
 *
 * Backed by the `/api/workspaces/:workspaceId/channels` routes via
 * `@/lib/api/channels`.
 *
 * [COMP:app-web/studio-channels]
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useWorkspaces } from "@/contexts/workspace-context";
import { authFetch } from "@/lib/auth-fetch";
import { buildManifest } from "@/components/slack-setup-inline";
import { QRCodeSVG } from "qrcode.react";
import {
  connectWhatsappIngest,
  getWhatsappIngest,
  getWhatsappBot,
  enableWhatsappBot,
  disableWhatsappBot,
  addWhatsappBotTrigger,
  deleteWhatsappBotTrigger,
  setWhatsappBotAccess,
  setWhatsappBotBehavior,
  getWhatsappOfficial,
  unbindWhatsappOfficialGroup,
  type WhatsappGroup,
  type WhatsappBotConfig,
  type WhatsappBotSendScope,
  type WhatsappBotAccessMode,
  type WhatsappOfficialBinding,
} from "@/lib/api/whatsapp-ingest";
import { isHostedEdition } from "@/lib/edition";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  API_URL,
  listChannels,
  updateChannel,
  updateChannelConfig,
  deleteChannel,
  connectSlackChannel,
  connectTelegramChannel,
  connectDiscordChannel,
  listChannelAssistants,
  attachChannelAssistant,
  detachChannelAssistant,
  updateChannelAssistant,
  type Channel,
  type ChannelAssistant,
  type ChannelCapability,
  type ChannelClearance,
  type ChannelConfigPatch,
  type ChannelIntegrationConfig,
  type ChannelModelAlias,
  type RequireMentionOverride,
  type UserAccessMode,
} from "@/lib/api/channels";
import { listAssistants, type StudioAssistantSummary } from "@/lib/api/studio";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SearchableSelect,
  type SearchableSelectItem,
} from "@/components/ui/searchable-select";
import { DISPLAY_API_URL } from "@/lib/display-api-url";

// Slack manifest's `request_url` must be a syntactically valid URL — Slack
// posts a verification challenge to it. Our slack route returns the challenge
// for any URL regardless of channel id (the route's url_verification handler
// runs before integration lookup), so this placeholder satisfies Slack until
// the real URL is shown after Connect and the user updates Event Subscriptions.
// Uses the absolute display origin: in dev the fetch base is blanked
// (next.config rewrite) and a relative URL would be invalid in the manifest.
const PLACEHOLDER_SLACK_WEBHOOK_URL = `${DISPLAY_API_URL}/webhook/slack/REPLACE-AFTER-CONNECT`;

// Glyphs for the channel types surfaced in the UI. WhatsApp was dropped from
// the product UI; legacy rows still in the backend fall back to a generic
// glyph (see the chip lookup below) rather than rendering blank. Discord has
// no clean unicode glyph, so it renders the brand mark (`DiscordGlyph`) instead
// of a text character — see the chip below.
const PLATFORM_GLYPH: Partial<Record<Channel["channelType"], string>> = {
  telegram: "✈",
  slack: "#",
};

// Official Discord mark, monochrome — `fill-current` inherits the chip's
// `text-muted-foreground` so it sits alongside the `#` / `✈` text glyphs
// without injecting brand colour. Sized to match the `text-base` glyphs.
function DiscordGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-[1.05rem] w-[1.05rem] fill-current"
    >
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

// Server-invite URL for a freshly connected Discord bot. A bot must be in a
// server before any user can message it, so the connect success state offers
// this. `client_id` is the bot's Application id (== bot user id). Permissions
// integer = View Channels (1<<10) + Send Messages (1<<11) + Read Message
// History (1<<16) + Add Reactions (1<<6) = 68672.
function discordInviteUrl(botId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(botId)}&scope=bot&permissions=68672`;
}

const CLEARANCES: ChannelClearance[] = ["public", "internal", "confidential"];
const CAPABILITIES: ChannelCapability[] = ["chat", "broadcast", "ingest"];

/**
 * Ordering helper mirroring the SQL `sensitivity_rank()` IMMUTABLE function
 * (migration 065). A member can only see/update channels whose clearance
 * ranks ≤ their own clearance — the dropdown is filtered to that subset.
 */
function clearanceRank(c: ChannelClearance): number {
  return c === "public" ? 1 : c === "internal" ? 2 : 3;
}

/**
 * Pull the caller's `workspace_members.clearance` for `workspaceId` off the
 * existing `GET /workspaces/:id` endpoint. The endpoint returns `members[]`
 * with one row per workspace member; we match on `me.id` to find ours.
 * Returns null on any failure so the UI keeps its safe 'internal' default.
 */
async function fetchWorkspaceClearance(
  workspaceId: string,
): Promise<ChannelClearance | null> {
  try {
    const res = await authFetch(
      `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      me?: { id?: string };
      members?: { userId: string; clearance?: ChannelClearance }[];
    };
    const meId = data.me?.id;
    if (!meId || !Array.isArray(data.members)) return null;
    const mine = data.members.find((m) => m.userId === meId);
    return mine?.clearance ?? null;
  } catch {
    return null;
  }
}

export default function StudioChannelsPage() {
  const t = useT();
  const { activeId } = useWorkspaces();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [routing, setRouting] = useState<Record<string, ChannelAssistant[]>>({});
  const [assistants, setAssistants] = useState<StudioAssistantSummary[]>([]);
  // The caller's clearance on this workspace, surfaced by GET /workspaces/:id
  // (added with workspace-channels migration 153). Defaults to 'internal' —
  // the schema-level default — while loading. Used to filter the clearance
  // dropdown to options at or below the user's own tier, mirroring the RLS
  // WITH CHECK on `channels`.
  const [myClearance, setMyClearance] = useState<ChannelClearance>("internal");
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (!activeId) {
      setChannels(null);
      return;
    }
    let cancelled = false;
    setChannels(null);
    setError(null);
    void (async () => {
      try {
        const [chans, asts, ws] = await Promise.all([
          listChannels(activeId),
          listAssistants(activeId),
          fetchWorkspaceClearance(activeId),
        ]);
        if (cancelled) return;
        setAssistants(asts);
        setChannels(chans);
        if (ws) setMyClearance(ws);
        const entries = await Promise.all(
          chans.map(
            async (c) =>
              [c.id, await listChannelAssistants(activeId, c.id)] as const,
          ),
        );
        if (!cancelled) setRouting(Object.fromEntries(entries));
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const onChannelUpdated = useCallback((updated: Channel) => {
    setChannels((prev) =>
      prev ? prev.map((c) => (c.id === updated.id ? updated : c)) : prev,
    );
  }, []);

  const refreshRouting = useCallback(
    async (channelId: string) => {
      if (!activeId) return;
      const rows = await listChannelAssistants(activeId, channelId);
      setRouting((prev) => ({ ...prev, [channelId]: rows }));
    },
    [activeId],
  );

  const onChannelCreated = useCallback(
    async (created: Channel) => {
      setChannels((prev) => {
        if (!prev) return [created];
        // Re-install hits the same channel id — replace in place; new
        // channels prepend so the user sees their fresh install first.
        const at = prev.findIndex((c) => c.id === created.id);
        if (at >= 0) {
          const next = [...prev];
          next[at] = created;
          return next;
        }
        return [created, ...prev];
      });
      // The backend may have seeded a default `channel_assistants` row when
      // `defaultAssistantId` was provided — pull routing so the new card
      // shows it.
      await refreshRouting(created.id);
    },
    [refreshRouting],
  );

  const onChannelDeleted = useCallback((channelId: string) => {
    setChannels((prev) => (prev ? prev.filter((c) => c.id !== channelId) : prev));
    setRouting((prev) => {
      if (!(channelId in prev)) return prev;
      const next = { ...prev };
      delete next[channelId];
      return next;
    });
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {/* Intro row — the topbar breadcrumb names the section; this row is the
          description + the one primary action
          (docs/architecture/features/studio.md → "Page headers"). */}
      <header className="flex items-start justify-between gap-4">
        <p className="text-[13px] text-muted-foreground max-w-prose">
          {t.studioPage.channels.intro}
        </p>
        {activeId && (
          <button
            type="button"
            onClick={() => setAddOpen((v) => !v)}
            className="shrink-0 text-sm font-medium rounded-md bg-primary text-primary-foreground px-3 py-1.5"
          >
            {addOpen ? t.studioPage.channels.add.close : t.studioPage.channels.add.cta}
          </button>
        )}
      </header>

      {addOpen && activeId && (
        <AddChannelForm
          workspaceId={activeId}
          assistants={assistants}
          onCreated={onChannelCreated}
          onClose={() => setAddOpen(false)}
        />
      )}

      {/* Official shared bot: hosted-only. Gated behind isHostedEdition() so the
          open OSS core never renders it (its backend lives in closed
          api-platform). See docs/architecture/channels/whatsapp.md. */}
      {isHostedEdition() && activeId && (
        <WhatsappOfficialCard workspaceId={activeId} />
      )}

      {!activeId ? (
        <div className="text-sm text-muted-foreground border border-border rounded-md p-4">
          {t.studioPage.channels.noActiveWorkspace}
        </div>
      ) : error ? (
        <div className="text-sm text-muted-foreground border border-border rounded-md p-4">
          {t.studioPage.channels.loadError}
        </div>
      ) : channels === null ? (
        <div className="text-sm text-muted-foreground">
          {t.studioPage.channels.loading}
        </div>
      ) : channels.length === 0 ? (
        <div className="border border-border rounded-md bg-card/50 p-6 flex flex-col gap-1">
          <div className="font-medium text-sm">
            {t.studioPage.channels.emptyTitle}
          </div>
          <p className="text-sm text-muted-foreground">
            {t.studioPage.channels.emptyBody}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {channels.map((c) => (
            <ChannelCard
              key={c.id}
              workspaceId={activeId}
              channel={c}
              routing={routing[c.id] ?? []}
              assistants={assistants}
              myClearance={myClearance}
              onUpdated={onChannelUpdated}
              onRoutingChanged={() => refreshRouting(c.id)}
              onDeleted={onChannelDeleted}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ChannelCard({
  workspaceId,
  channel,
  routing,
  assistants,
  myClearance,
  onUpdated,
  onRoutingChanged,
  onDeleted,
}: {
  workspaceId: string;
  channel: Channel;
  routing: ChannelAssistant[];
  assistants: StudioAssistantSummary[];
  myClearance: ChannelClearance;
  onUpdated: (c: Channel) => void;
  onRoutingChanged: () => void;
  onDeleted: (channelId: string) => void;
}) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  // `boolean | "clearanceTooHigh"` — distinguish the (403 RLS WITH CHECK)
  // case so the inline message can explain *why* a save was rejected. The
  // server returns `error: 'clearance_exceeds_member_tier'` for this; any
  // other failure falls back to the generic saveError copy.
  const [saveError, setSaveError] = useState<boolean | "clearanceTooHigh">(false);
  const [attachAssistantId, setAttachAssistantId] = useState("");
  const [attachSurface, setAttachSurface] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);

  async function onConfirmDisconnect(): Promise<void> {
    setDeleting(true);
    setDeleteError(false);
    try {
      await deleteChannel(workspaceId, channel.id);
      onDeleted(channel.id);
      // On success the card unmounts via onDeleted — leave `deleting` true
      // so the button stays disabled during the brief unmount window.
    } catch {
      setDeleteError(true);
      setDeleting(false);
    }
  }

  const assistantName = (id: string): string =>
    assistants.find((a) => a.id === id)?.name ??
    t.studioPage.channels.unknownAssistant;

  // Base UI's <SelectValue> renders the raw value (here a UUID) unless the Root
  // gets an items map; this id→name map makes the attach trigger show the name.
  const assistantItems = useMemo(
    () => Object.fromEntries(assistants.map((a) => [a.id, a.name])),
    [assistants],
  );

  async function patch(
    p: Partial<Pick<Channel, "clearance" | "enabledCapabilities">>,
  ): Promise<void> {
    setSaving(true);
    setSaveError(false);
    try {
      onUpdated(await updateChannel(workspaceId, channel.id, p));
    } catch (e) {
      // The route now translates RLS clearance rejections into a 403 with
      // `error: 'clearance_exceeds_member_tier'`; pick that up so we can
      // explain *why* it failed instead of the generic "couldn't save".
      const msg = (e as Error).message;
      setSaveError(
        msg.includes("clearance_exceeds_member_tier") ? "clearanceTooHigh" : true,
      );
    } finally {
      setSaving(false);
    }
  }

  async function onAttach(): Promise<void> {
    if (!attachAssistantId) return;
    setAttaching(true);
    setAttachError(null);
    try {
      await attachChannelAssistant(
        workspaceId,
        channel.id,
        attachAssistantId,
        attachSurface.trim() || null,
      );
      setAttachAssistantId("");
      setAttachSurface("");
      onRoutingChanged();
    } catch (e) {
      setAttachError((e as Error).message);
    } finally {
      setAttaching(false);
    }
  }

  async function onDetach(channelAssistantId: string): Promise<void> {
    try {
      await detachChannelAssistant(workspaceId, channel.id, channelAssistantId);
      onRoutingChanged();
    } catch {
      // Non-fatal — the routing list simply won't refresh.
    }
  }

  const ingestOn = channel.enabledCapabilities.includes("ingest");
  const statusActive = channel.status === "active";

  return (
    <li className="border border-border rounded-md bg-card p-5 flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <div
          aria-hidden
          className="h-9 w-9 rounded-md bg-muted text-muted-foreground flex items-center justify-center text-base font-medium shrink-0"
        >
          {channel.channelType === "discord" ? (
            <DiscordGlyph />
          ) : (
            (PLATFORM_GLYPH[channel.channelType] ?? "•")
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">{channel.displayName}</div>
          <div className="text-xs text-muted-foreground">
            {(t.studioPage.channels.platforms as Partial<Record<Channel["channelType"], string>>)[
              channel.channelType
            ] ?? channel.channelType}
          </div>
        </div>
        <span
          className={
            "text-xs font-medium shrink-0 " +
            (statusActive ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")
          }
        >
          {t.studioPage.channels.status[channel.status]}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {t.studioPage.channels.clearanceLabel}
          </span>
          <Select
            value={channel.clearance}
            disabled={saving}
            onValueChange={(v) => {
              if (v) void patch({ clearance: v as ChannelClearance });
            }}
          >
            <SelectTrigger size="sm" className="text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLEARANCES.filter(
                (c) =>
                  // Disable tiers above the caller's own clearance. RLS would
                  // reject the PATCH anyway (channels_workspace_member's
                  // WITH CHECK); filtering avoids the failed round-trip.
                  // Always include the channel's current value so a member
                  // viewing a higher-tier channel (granted via clearance
                  // upgrade) doesn't see an empty dropdown.
                  clearanceRank(c) <= clearanceRank(myClearance) ||
                  c === channel.clearance,
              ).map((c) => (
                <SelectItem key={c} value={c}>
                  {t.studioPage.channels.clearance[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {t.studioPage.channels.capabilitiesLabel}
          </span>
          <div className="flex gap-1.5">
            {CAPABILITIES.filter((cap) =>
              channel.enabledCapabilities.includes(cap),
            ).map((cap) => (
              <span
                key={cap}
                className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground"
              >
                {t.studioPage.channels.capability[cap]}
              </span>
            ))}
          </div>
        </div>

        {saving && (
          <span className="text-xs text-muted-foreground">
            {t.studioPage.channels.saving}
          </span>
        )}
        {saveError === "clearanceTooHigh" ? (
          <span className="text-xs text-destructive">
            {t.studioPage.channels.clearanceTooHighError}
          </span>
        ) : saveError ? (
          <span className="text-xs text-destructive">
            {t.studioPage.channels.saveError}
          </span>
        ) : null}
      </div>

      {channel.channelType === "slack" && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={ingestOn}
            disabled={saving}
            onChange={(e) =>
              void patch({
                enabledCapabilities: e.target.checked
                  ? [...channel.enabledCapabilities, "ingest"]
                  : channel.enabledCapabilities.filter((c) => c !== "ingest"),
              })
            }
          />
          <span>{t.studioPage.channels.ingestToggle}</span>
        </label>
      )}

      {(channel.channelType === "slack" ||
        channel.channelType === "telegram" ||
        channel.channelType === "discord") &&
        channel.integrationId && (
          <ChannelConfigSection
            workspaceId={workspaceId}
            channel={channel}
            onUpdated={onUpdated}
          />
        )}

      {/* WhatsApp config — connection state (surfaces a phone-side logout) +
          per-group ingest list + the replies (bot) section, like the other
          channels' config sections. */}
      {channel.channelType === "whatsapp" && (
        <WhatsappCardSection workspaceId={workspaceId} />
      )}

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {t.studioPage.channels.routingTitle}
        </div>

        {routing.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t.studioPage.channels.routingEmpty}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {routing.map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-sm">
                <span className="font-medium">{assistantName(r.assistantId)}</span>
                <span className="text-xs text-muted-foreground">
                  {r.externalSurfaceId
                    ? `${t.studioPage.channels.surfacePrefix}: ${r.externalSurfaceId}`
                    : t.studioPage.channels.defaultSurface}
                </span>
                <RoutingModelPicker
                  workspaceId={workspaceId}
                  channelId={channel.id}
                  routing={r}
                  onUpdated={onRoutingChanged}
                />
                <button
                  type="button"
                  onClick={() => void onDetach(r.id)}
                  className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                >
                  {t.studioPage.channels.detach}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2 mt-1">
          <Select
            value={attachAssistantId || undefined}
            onValueChange={(v) => setAttachAssistantId(v ?? "")}
            items={assistantItems}
          >
            <SelectTrigger size="sm" className="text-sm">
              <SelectValue
                placeholder={t.studioPage.channels.attachAssistantPlaceholder}
              />
            </SelectTrigger>
            <SelectContent>
              {assistants.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Surface routing is for multi-conversation channels (Slack channels,
              Telegram chats/topics). A WhatsApp number has one conversation
              stream, so it just gets the default assistant. */}
          {channel.channelType !== "whatsapp" && (
            <SurfaceInput
              channel={channel}
              value={attachSurface}
              onChange={setAttachSurface}
            />
          )}
          <button
            type="button"
            onClick={() => void onAttach()}
            disabled={!attachAssistantId || attaching}
            className="text-sm font-medium rounded-md bg-primary text-primary-foreground px-3 py-1 disabled:opacity-50"
          >
            {attaching
              ? t.studioPage.channels.attaching
              : t.studioPage.channels.attachSubmit}
          </button>
        </div>
        {attachError && (
          <p className="text-xs text-destructive">{attachError}</p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        {confirmDelete ? (
          <>
            <p className="text-xs text-muted-foreground">
              {t.studioPage.channels.disconnect.warning}
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="text-xs font-medium rounded-md border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50"
              >
                {t.studioPage.channels.disconnect.cancel}
              </button>
              <button
                type="button"
                onClick={() => void onConfirmDisconnect()}
                disabled={deleting}
                className="text-xs font-medium rounded-md bg-destructive text-destructive-foreground px-2.5 py-1 hover:bg-destructive/90 disabled:opacity-50"
              >
                {deleting
                  ? t.studioPage.channels.disconnect.confirming
                  : t.studioPage.channels.disconnect.confirm}
              </button>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="text-xs font-medium text-destructive hover:underline"
            >
              {t.studioPage.channels.disconnect.cta}
            </button>
          </div>
        )}
        {deleteError && (
          <p className="text-xs text-destructive text-right">
            {t.studioPage.channels.disconnect.error}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * Per-routing model picker. Patches `channel_assistants.model_alias` so each
 * routed surface can run on its own LLM tier (migration 197). Pro is gated
 * behind the Pro plan, Max behind Pro+Max — same gate as the Assistant →
 * Settings → Channel Models row in `assistant-detail.tsx`. The backend
 * re-validates the plan, so this is a UX guard not a security boundary.
 *
 * Gates on the *workspace* plan (billing is per-workspace, migration 143) —
 * the legacy `users.plan` cookie field is stale post-migration and would
 * lock out members of a paid workspace whose own user row is still 'free'.
 */
function RoutingModelPicker({
  workspaceId,
  channelId,
  routing,
  onUpdated,
}: {
  workspaceId: string;
  channelId: string;
  routing: ChannelAssistant;
  onUpdated: () => void;
}) {
  const t = useT();
  const { workspaces } = useWorkspaces();
  const plan = workspaces.find((w) => w.id === workspaceId)?.plan ?? "free";
  const proDisabled = plan === "free";
  const maxDisabled = plan === "free" || plan === "pro";
  const [saving, setSaving] = useState(false);
  const [value, setValue] = useState<ChannelModelAlias>(routing.modelAlias);

  // Re-sync when the parent refreshes the routing list (e.g. an attach
  // changed the source-of-truth row).
  useEffect(() => {
    setValue(routing.modelAlias);
  }, [routing.modelAlias]);

  async function save(next: ChannelModelAlias): Promise<void> {
    if (next === value) return;
    const prev = value;
    setValue(next);
    setSaving(true);
    try {
      await updateChannelAssistant(workspaceId, channelId, routing.id, {
        modelAlias: next,
      });
      onUpdated();
    } catch {
      setValue(prev);
    } finally {
      setSaving(false);
    }
  }

  const tr = t.studioPage.channels;
  return (
    <Select
      value={value}
      disabled={saving}
      onValueChange={(v) => {
        if (v === "standard" || v === "pro" || v === "max") void save(v);
      }}
    >
      <SelectTrigger size="sm" className="ml-auto text-xs h-7 w-auto min-w-24 gap-1.5">
        <SelectValue />
      </SelectTrigger>
      <SelectContent side="bottom" align="end">
        <SelectItem value="standard">{tr.routingModelStandard}</SelectItem>
        <SelectItem value="pro" disabled={proDisabled}>
          <span className="flex items-center gap-1.5">
            {tr.routingModelPro}
            {proDisabled && (
              <span className="rounded-sm bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                {tr.routingModelLocked}
              </span>
            )}
          </span>
        </SelectItem>
        <SelectItem value="max" disabled={maxDisabled}>
          <span className="flex items-center gap-1.5">
            {tr.routingModelMax}
            {maxDisabled && (
              <span className="rounded-sm bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                {tr.routingModelLocked}
              </span>
            )}
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

/**
 * Surface picker for assistant routing. When the channel is Telegram and the
 * bot has seen chats/topics (populated webhook-side into `config.seenChats`),
 * render a searchable dropdown of addressable surfaces. Otherwise fall back
 * to a raw text input so Slack setup (and Telegram bots that
 * haven't seen any chats yet) still works.
 *
 * Forum chats are only addressable at topic granularity — every message in a
 * forum carries a `message_thread_id`, so the bare chat id never matches in
 * `channel_assistants.external_surface_id`. Non-forum chats use the bare id.
 */
function SurfaceInput({
  channel,
  value,
  onChange,
}: {
  channel: Channel;
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useT();
  const tr = t.studioPage.channels;

  const surfaceItems = useMemo<SearchableSelectItem[] | null>(() => {
    if (channel.channelType !== "telegram") return null;
    const seen = channel.config?.seenChats ?? [];
    if (seen.length === 0) return null;
    const items: SearchableSelectItem[] = [
      { value: "", label: tr.defaultSurface },
    ];
    for (const chat of seen) {
      const chatTitle =
        chat.chatTitle ??
        format(tr.config.overridesChatFallback, { id: chat.chatId });
      if (chat.isForum) {
        for (const topic of chat.topics) {
          const topicName =
            topic.name ??
            format(tr.config.overridesTopicFallback, { id: topic.topicId });
          const surfaceId = `${chat.chatId}:topic:${topic.topicId}`;
          items.push({
            value: surfaceId,
            label: `${chatTitle} › ${topicName}`,
            hint: surfaceId,
          });
        }
      } else {
        items.push({
          value: chat.chatId,
          label: chatTitle,
          hint: chat.chatId,
        });
      }
    }
    return items;
  }, [channel.channelType, channel.config?.seenChats, tr]);

  if (surfaceItems !== null) {
    return (
      <div className="min-w-0 flex-1">
        <SearchableSelect
          value={value}
          onValueChange={onChange}
          items={surfaceItems}
          placeholder={tr.defaultSurface}
          searchPlaceholder={tr.attachSurfaceSearchPlaceholder}
        />
      </div>
    );
  }

  return (
    <input
      className="text-sm rounded-md border border-border bg-background px-2 py-1 min-w-0 flex-1"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={tr.attachSurfacePlaceholder}
    />
  );
}

/**
 * Per-integration behavior config for a Slack / Telegram channel — the
 * `channel_integrations.config` JSONB. Edits PATCH
 * `/workspaces/:id/channels/:id/config`; the server merges each patch into the
 * stored config. See docs/architecture/channels/adapter-pattern.md.
 */
function ChannelConfigSection({
  workspaceId,
  channel,
  onUpdated,
}: {
  workspaceId: string;
  channel: Channel;
  onUpdated: (c: Channel) => void;
}) {
  const t = useT();
  const cfg = t.studioPage.channels.config;
  const isSlack = channel.channelType === "slack";
  const isTelegram = channel.channelType === "telegram";
  // Discord's config surface today is access-control only: `requireMention` is
  // enforced connector-side (not from this config) and there is no ack-reaction
  // on the Discord inbound path, so both are hidden for Discord channels.
  const isDiscord = channel.channelType === "discord";
  const [config, setConfig] = useState<ChannelIntegrationConfig>(
    channel.config ?? {},
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  // Re-sync when the parent swaps in a refreshed channel object (e.g. a
  // sibling field — clearance, routing — was saved and replaced it).
  useEffect(() => {
    setConfig(channel.config ?? {});
  }, [channel.config]);

  async function save(patch: ChannelConfigPatch): Promise<void> {
    setConfig((c) => ({ ...c, ...patch }));
    setSaving(true);
    setSaveError(false);
    try {
      onUpdated(await updateChannelConfig(workspaceId, channel.id, patch));
    } catch {
      setConfig(channel.config ?? {});
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  const accessMode: UserAccessMode = config.userAccessMode ?? "allow_all";
  const accessIds =
    accessMode === "blocklist"
      ? (config.blockedUserIds ?? [])
      : (config.allowedUserIds ?? []);

  function commitAccessIds(ids: string[]): void {
    void save(
      accessMode === "blocklist"
        ? { blockedUserIds: ids }
        : { allowedUserIds: ids },
    );
  }
  function addAccessId(value: string): void {
    const v = value.trim();
    if (!v || accessIds.includes(v)) return;
    commitAccessIds([...accessIds, v]);
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        {cfg.title}
      </div>

      {isSlack && (
        <ConfigToggle
          label={cfg.replyInThread}
          hint={cfg.replyInThreadHint}
          checked={config.replyInThread ?? false}
          disabled={saving}
          onChange={(v) => void save({ replyInThread: v })}
        />
      )}

      {!isDiscord && (
        <ConfigToggle
          label={cfg.requireMention}
          hint={isSlack ? cfg.requireMentionHintSlack : cfg.requireMentionHintTelegram}
          checked={config.requireMention ?? true}
          disabled={saving}
          onChange={(v) => void save({ requireMention: v })}
        />
      )}

      {/* Acknowledgment reaction — not wired on the Discord inbound path. */}
      {!isDiscord && (
      <div className="flex flex-col gap-1">
        <span className="text-sm">{cfg.ackLabel}</span>
        <p className="text-xs text-muted-foreground">
          {isSlack ? cfg.ackHintSlack : cfg.ackHintTelegram}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={config.ackReaction ?? ""}
            disabled={saving}
            placeholder={isSlack ? "eyes" : "👀"}
            onChange={(e) =>
              setConfig((c) => ({ ...c, ackReaction: e.target.value }))
            }
            onBlur={() => void save({ ackReaction: config.ackReaction ?? "" })}
            className="w-32 text-sm rounded-md border border-border bg-background px-2 py-1 font-mono"
          />
          {(isSlack
            ? ["eyes", "brain", "thumbsup"]
            : ["👀", "🧠", "👍"]
          ).map((emoji) => (
            <button
              key={emoji}
              type="button"
              disabled={saving}
              onClick={() => void save({ ackReaction: emoji })}
              className="text-xs rounded-md border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
            >
              {isSlack ? `:${emoji}:` : emoji}
            </button>
          ))}
          {config.ackReaction ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => void save({ ackReaction: "" })}
              className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {cfg.ackClear}
            </button>
          ) : null}
        </div>
      </div>
      )}

      {/* Access control — allow all / allowlist / blocklist */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{cfg.accessLabel}</span>
          <Select
            value={accessMode}
            disabled={saving}
            onValueChange={(v) => {
              if (v) void save({ userAccessMode: v as UserAccessMode });
            }}
          >
            <SelectTrigger size="sm" className="text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="allow_all">{cfg.accessAllowAll}</SelectItem>
              <SelectItem value="allowlist">{cfg.accessAllowlist}</SelectItem>
              <SelectItem value="blocklist">{cfg.accessBlocklist}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs italic text-muted-foreground">
          {accessMode === "allowlist"
            ? cfg.accessAllowlistDesc
            : accessMode === "blocklist"
              ? cfg.accessBlocklistDesc
              : isSlack
                ? cfg.accessAllDescSlack
                : isDiscord
                  ? cfg.accessAllDescDiscord
                  : cfg.accessAllDescTelegram}
        </p>
        {accessMode !== "allow_all" && (
          <div className="flex flex-col gap-1.5">
            {accessIds.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {accessIds.map((uid, i) => (
                  <span
                    key={`${uid}-${i}`}
                    className="inline-flex items-center gap-1 text-xs font-mono px-2 py-1 rounded-md bg-muted border border-border"
                  >
                    {uid}
                    <button
                      type="button"
                      disabled={saving}
                      aria-label={cfg.ackClear}
                      onClick={() =>
                        commitAccessIds(accessIds.filter((_, j) => j !== i))
                      }
                      className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = e.currentTarget.elements.namedItem(
                  "accessUserId",
                ) as HTMLInputElement;
                addAccessId(input.value);
                input.value = "";
              }}
              className="flex items-center gap-2"
            >
              <input
                name="accessUserId"
                type="text"
                disabled={saving}
                placeholder={
                  isSlack
                    ? cfg.userIdPlaceholderSlack
                    : isDiscord
                      ? cfg.userIdPlaceholderDiscord
                      : cfg.userIdPlaceholderTelegram
                }
                className="w-44 text-sm rounded-md border border-border bg-background px-2 py-1 font-mono"
              />
              <button
                type="submit"
                disabled={saving}
                className="text-xs font-medium rounded-md border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50"
              >
                {accessMode === "blocklist" ? cfg.blockUser : cfg.addUser}
              </button>
            </form>
            <p className="text-xs text-muted-foreground">
              {isSlack
                ? cfg.userIdHintSlack
                : isDiscord
                  ? cfg.userIdHintDiscord
                  : cfg.userIdHintTelegram}
            </p>
          </div>
        )}
      </div>

      {isTelegram && (
        <TelegramMentionOverrides
          config={config}
          saving={saving}
          onChange={(next) => void save({ requireMentionOverrides: next })}
        />
      )}

      {saving && (
        <span className="text-xs text-muted-foreground">
          {t.studioPage.channels.saving}
        </span>
      )}
      {saveError && (
        <span className="text-xs text-destructive">
          {t.studioPage.channels.saveError}
        </span>
      )}
    </div>
  );
}

/** A labelled checkbox with a hint line — used for the boolean config flags. */
function ConfigToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{label}</span>
      </label>
      <p className="text-xs text-muted-foreground pl-6">{hint}</p>
    </div>
  );
}

/**
 * Telegram-only per-chat / per-topic flips of the `requireMention` default.
 * The chat / topic inventory (`seenChats`) is webhook-populated and read-only
 * — the bot has to have seen a group before it can be listed here.
 */
function TelegramMentionOverrides({
  config,
  saving,
  onChange,
}: {
  config: ChannelIntegrationConfig;
  saving: boolean;
  onChange: (next: RequireMentionOverride[]) => void;
}) {
  const t = useT();
  const cfg = t.studioPage.channels.config;
  const requireMention = config.requireMention ?? true;
  const overrides = config.requireMentionOverrides ?? [];
  const seenChats = config.seenChats ?? [];

  const overrideKey = (chatId: string, topicId: number | null) =>
    `${chatId}:${topicId ?? "all"}`;
  const overrideSet = new Set(
    overrides.map((o) => overrideKey(o.chatId, o.topicId ?? null)),
  );
  const effectLabel = requireMention
    ? cfg.overridesEffectDontRequire
    : cfg.overridesEffectRequire;

  function toggle(chatId: string, topicId: number | null): void {
    const k = overrideKey(chatId, topicId);
    onChange(
      overrideSet.has(k)
        ? overrides.filter((o) => overrideKey(o.chatId, o.topicId ?? null) !== k)
        : [...overrides, { chatId, topicId }],
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm">{cfg.overridesLabel}</span>
      <p className="text-xs text-muted-foreground">
        {cfg.overridesDescPrefix}{" "}
        <span className="font-medium text-foreground">{effectLabel}</span>.{" "}
        {cfg.overridesDescTopicNote}
      </p>
      {seenChats.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">
          {cfg.overridesNoGroups}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {[...seenChats]
            .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
            .map((chat) => {
              const wholeChat = overrideSet.has(overrideKey(chat.chatId, null));
              return (
                <li
                  key={chat.chatId}
                  className="rounded-md border border-border bg-background p-2 flex flex-col gap-1"
                >
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={wholeChat}
                      disabled={saving}
                      onChange={() => toggle(chat.chatId, null)}
                    />
                    <span className="font-medium">
                      {chat.chatTitle ??
                        format(cfg.overridesChatFallback, { id: chat.chatId })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {chat.isForum ? `${cfg.overridesForumLabel} · ` : ""}
                      {chat.chatId}
                    </span>
                  </label>
                  {chat.isForum && chat.topics.length > 0 && (
                    <ul className="pl-6 flex flex-col gap-0.5">
                      {[...chat.topics]
                        .sort((a, b) => a.topicId - b.topicId)
                        .map((topic) => (
                          <li key={topic.topicId}>
                            <label className="flex items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={overrideSet.has(
                                  overrideKey(chat.chatId, topic.topicId),
                                )}
                                disabled={wholeChat || saving}
                                onChange={() =>
                                  toggle(chat.chatId, topic.topicId)
                                }
                              />
                              <span>
                                {topic.name ??
                                  format(cfg.overridesTopicFallback, {
                                    id: topic.topicId,
                                  })}
                              </span>
                              {topic.name === null && (
                                <span className="italic text-muted-foreground">
                                  {cfg.overridesTopicNoNameNote}
                                </span>
                              )}
                            </label>
                          </li>
                        ))}
                    </ul>
                  )}
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}

/**
 * Workspace-driven channel connect — the "+ Add channel" inline expander on
 * studio/channels. Validates credentials via the workspace-scoped connect
 * endpoints (`POST /api/workspaces/:id/channels/{slack,telegram}`),
 * optionally seeds default routing to an assistant in this workspace, and
 * shows the Slack webhook URL the user must register manually (Telegram
 * auto-registers).
 */
function AddChannelForm({
  workspaceId,
  assistants,
  onCreated,
  onClose,
}: {
  workspaceId: string;
  assistants: StudioAssistantSummary[];
  onCreated: (channel: Channel) => void | Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const add = t.studioPage.channels.add;
  const [platform, setPlatform] = useState<
    "slack" | "telegram" | "discord" | "whatsapp"
  >("slack");

  // WhatsApp pairs via QR (no token submit). After the connect stream reports
  // `connected`, the integration row lands shortly after — poll the channel
  // list until the WhatsApp channel appears, then surface it like the others.
  const handleWhatsappConnected = useCallback(async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const chans = await listChannels(workspaceId);
        const wa = chans.find((c) => c.channelType === "whatsapp");
        if (wa) {
          await onCreated(wa);
          return;
        }
      } catch {
        // transient — keep polling
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }, [workspaceId, onCreated]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<
    | null
    | { kind: "slack"; webhookUrl: string }
    | { kind: "telegram"; botUsername: string }
    | { kind: "discord"; botUsername: string; inviteUrl: string; connectorError: string | null }
  >(null);
  const [copied, setCopied] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [defaultAssistantId, setDefaultAssistantId] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [tgBotToken, setTgBotToken] = useState("");
  const [dcBotToken, setDcBotToken] = useState("");

  // Slack app manifest customization (collapsed by default).
  const [manifestOpen, setManifestOpen] = useState(false);
  const [appName, setAppName] = useState("My AI Assistant");
  const [appDescription, setAppDescription] = useState(
    "AI assistant powered by sidanclaw",
  );
  const [bgColor, setBgColor] = useState("#1e293b");
  const [manifestCopied, setManifestCopied] = useState(false);
  const manifest = useMemo(
    () =>
      buildManifest(PLACEHOLDER_SLACK_WEBHOOK_URL, {
        appName,
        appDescription,
        bgColor,
      }),
    [appName, appDescription, bgColor],
  );

  // Base UI's <SelectValue> renders the raw value (the "__none__" sentinel or an
  // assistant UUID) unless the Root gets an items map; this id→name map (plus
  // the None label) makes the trigger show readable text.
  const defaultAssistantItems = useMemo(
    () => ({
      __none__: add.defaultAssistantNone,
      ...Object.fromEntries(assistants.map((a) => [a.id, a.name])),
    }),
    [assistants, add.defaultAssistantNone],
  );

  function copyManifest(): void {
    void navigator.clipboard.writeText(manifest).then(() => {
      setManifestCopied(true);
      setTimeout(() => setManifestCopied(false), 2000);
    });
  }

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      if (platform === "slack") {
        const result = await connectSlackChannel(workspaceId, {
          botToken: slackBotToken,
          signingSecret,
          defaultAssistantId: defaultAssistantId || null,
        });
        await onCreated(result.channel);
        setSuccess({
          kind: "slack",
          // Prefer the full URL; fall back to the path when the server
          // doesn't know its own host (dev / misconfigured prod).
          webhookUrl: result.webhookUrl ?? result.webhookPath,
        });
        setSlackBotToken("");
        setSigningSecret("");
      } else if (platform === "telegram") {
        const result = await connectTelegramChannel(workspaceId, {
          botToken: tgBotToken,
          defaultAssistantId: defaultAssistantId || null,
        });
        await onCreated(result.channel);
        setSuccess({ kind: "telegram", botUsername: result.botUsername });
        setTgBotToken("");
      } else {
        const result = await connectDiscordChannel(workspaceId, {
          botToken: dcBotToken,
          defaultAssistantId: defaultAssistantId || null,
        });
        await onCreated(result.channel);
        setSuccess({
          kind: "discord",
          botUsername: result.botUsername,
          inviteUrl: discordInviteUrl(result.botId),
          connectorError: result.connectorError,
        });
        setDcBotToken("");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    !submitting &&
    !success &&
    (platform === "slack"
      ? slackBotToken.startsWith("xoxb-") && signingSecret.length >= 16
      : platform === "telegram"
        ? tgBotToken.length > 0
        : dcBotToken.length > 0);

  function pickPlatform(p: "slack" | "telegram" | "discord" | "whatsapp"): void {
    setPlatform(p);
    setSuccess(null);
    setError(null);
  }

  function copyInvite(): void {
    if (success?.kind !== "discord") return;
    void navigator.clipboard.writeText(success.inviteUrl).then(() => {
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 2000);
    });
  }

  function copyWebhook(): void {
    if (success?.kind !== "slack") return;
    void navigator.clipboard.writeText(success.webhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const TAB_BASE = "px-3 py-1.5 text-sm border-b-2 transition-colors -mb-px";
  const FIELD_INPUT =
    "text-sm rounded-md border border-border bg-background px-2 py-1.5 font-mono disabled:opacity-50";

  return (
    <div className="border border-border rounded-md bg-card p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{add.title}</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {add.close}
        </button>
      </div>

      <div className="flex gap-1 border-b border-border">
        {(["slack", "telegram", "discord", "whatsapp"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => pickPlatform(p)}
            className={
              TAB_BASE +
              " " +
              (platform === p
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground")
            }
          >
            {add.platform[p]}
          </button>
        ))}
      </div>

      {platform === "whatsapp" ? (
        <WhatsappConnectTab
          workspaceId={workspaceId}
          onConnected={handleWhatsappConnected}
        />
      ) : platform === "slack" ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{add.slackHint}</p>

          <button
            type="button"
            onClick={() => setManifestOpen((v) => !v)}
            className="text-xs text-primary hover:underline self-start"
          >
            {manifestOpen ? add.manifest.hide : add.manifest.show}
          </button>

          {manifestOpen && (
            <div className="border border-border rounded-md bg-muted/30 p-3 flex flex-col gap-2">
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-0.5 flex-1 min-w-[200px]">
                  <span className="text-xs font-medium">{add.manifest.appNameLabel}</span>
                  <input
                    type="text"
                    value={appName}
                    onChange={(e) => setAppName(e.target.value)}
                    maxLength={35}
                    disabled={submitting || !!success}
                    className="text-sm rounded-md border border-border bg-background px-2 py-1"
                  />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">{add.manifest.colorLabel}</span>
                  <input
                    type="color"
                    value={bgColor}
                    onChange={(e) => setBgColor(e.target.value)}
                    disabled={submitting || !!success}
                    className="h-8 w-12 rounded border border-border cursor-pointer"
                  />
                </label>
              </div>
              <label className="flex flex-col gap-0.5">
                <span className="text-xs font-medium">{add.manifest.descriptionLabel}</span>
                <input
                  type="text"
                  value={appDescription}
                  onChange={(e) => setAppDescription(e.target.value)}
                  maxLength={140}
                  disabled={submitting || !!success}
                  className="text-sm rounded-md border border-border bg-background px-2 py-1"
                />
              </label>
              <p className="text-xs text-muted-foreground">{add.manifest.urlNote}</p>
              <div className="relative">
                <pre className="text-xs font-mono px-3 py-2 rounded bg-background border border-border overflow-x-auto max-h-56 overflow-y-auto">
                  {manifest}
                </pre>
                <button
                  type="button"
                  onClick={copyManifest}
                  className="absolute top-1.5 right-1.5 text-xs rounded-md border border-border bg-background px-2 py-1 hover:bg-muted"
                >
                  {manifestCopied ? add.copied : add.manifest.copyManifest}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">{add.manifest.afterCreate}</p>
            </div>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{add.botTokenLabel}</span>
            <input
              type="password"
              value={slackBotToken}
              onChange={(e) => setSlackBotToken(e.target.value)}
              placeholder="xoxb-..."
              disabled={submitting || !!success}
              className={FIELD_INPUT}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{add.signingSecretLabel}</span>
            <input
              type="password"
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              placeholder="••••••••••••••••"
              disabled={submitting || !!success}
              className={FIELD_INPUT}
            />
          </label>
        </div>
      ) : platform === "telegram" ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{add.telegramHint}</p>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{add.botTokenLabel}</span>
            <input
              type="password"
              value={tgBotToken}
              onChange={(e) => setTgBotToken(e.target.value)}
              placeholder="123456:ABC-..."
              disabled={submitting || !!success}
              className={FIELD_INPUT}
            />
          </label>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{add.discordHint}</p>
          <a
            href="https://discord.com/developers/applications"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary hover:underline self-start"
          >
            {add.discordPortalLink}
          </a>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{add.botTokenLabel}</span>
            <input
              type="password"
              value={dcBotToken}
              onChange={(e) => setDcBotToken(e.target.value)}
              placeholder="MTIzNDU2..."
              disabled={submitting || !!success}
              className={FIELD_INPUT}
            />
          </label>
        </div>
      )}

      {platform !== "whatsapp" && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">{add.defaultAssistantLabel}</span>
          <Select
            value={defaultAssistantId || "__none__"}
            onValueChange={(v) =>
              setDefaultAssistantId(v && v !== "__none__" ? v : "")
            }
            items={defaultAssistantItems}
            disabled={submitting || !!success}
          >
            <SelectTrigger size="sm" className="text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{add.defaultAssistantNone}</SelectItem>
              {assistants.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {add.defaultAssistantHint}
          </span>
        </label>
      )}

      {platform !== "whatsapp" && !success && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="text-sm font-medium rounded-md bg-primary text-primary-foreground px-3 py-1.5 disabled:opacity-50"
          >
            {submitting ? add.connecting : add.connect}
          </button>
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
      )}

      {success?.kind === "slack" && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 flex flex-col gap-2">
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
            {add.connectedSlack}
          </p>
          <p className="text-xs text-muted-foreground">{add.slackWebhookHint}</p>
          <code className="text-xs bg-muted px-2 py-1.5 rounded font-mono break-all">
            {success.webhookUrl}
          </code>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={copyWebhook}
              className="text-xs font-medium rounded-md border border-border px-2 py-1 hover:bg-muted"
            >
              {copied ? add.copied : add.copyWebhook}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-xs font-medium rounded-md border border-border px-2 py-1 hover:bg-muted"
            >
              {add.done}
            </button>
          </div>
        </div>
      )}
      {success?.kind === "telegram" && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
            {format(add.connectedTelegram, { username: success.botUsername })}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-medium rounded-md border border-border px-2 py-1 hover:bg-muted"
          >
            {add.done}
          </button>
        </div>
      )}
      {success?.kind === "discord" && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 flex flex-col gap-2">
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
            {format(add.connectedDiscord, { username: success.botUsername })}
          </p>
          {success.connectorError && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {add.discordConnectorWarning}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{add.discordInviteHint}</p>
          <code className="text-xs bg-muted px-2 py-1.5 rounded font-mono break-all">
            {success.inviteUrl}
          </code>
          <div className="flex items-center gap-2">
            <a
              href={success.inviteUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium rounded-md bg-primary text-primary-foreground px-2 py-1"
            >
              {add.discordInviteOpen}
            </a>
            <button
              type="button"
              onClick={copyInvite}
              className="text-xs font-medium rounded-md border border-border px-2 py-1 hover:bg-muted"
            >
              {inviteCopied ? add.copied : add.copyInvite}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-xs font-medium rounded-md border border-border px-2 py-1 hover:bg-muted"
            >
              {add.done}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** WhatsApp QR pairing phases — inline in the Add-a-channel form. */
type WaConnectPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "qr"; value: string }
  | { kind: "expired" }
  | { kind: "error"; message: string }
  | { kind: "connected"; number: string };

/**
 * WhatsApp connect tab — the 4th "Add a channel" tab. Unlike the token-based
 * Slack/Telegram/Discord tabs, WhatsApp pairs a real number via a live QR
 * stream (POST-returning-SSE), so the QR renders inline here. On `connected`
 * the parent polls the channel list so the new WhatsApp channel surfaces like
 * the others. Reuses the `studioPage.ingestRules.whatsapp.*` copy.
 */
function WhatsappConnectTab({
  workspaceId,
  onConnected,
}: {
  workspaceId: string;
  onConnected: () => void;
}) {
  const t = useT();
  const wa = t.studioPage.ingestRules.whatsapp;
  const [phase, setPhase] = useState<WaConnectPhase>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: "loading" });
    connectWhatsappIngest(
      workspaceId,
      {
        onQr: (value) => setPhase({ kind: "qr", value }),
        onConnected: (number) => {
          controller.abort();
          setPhase({ kind: "connected", number });
          onConnected();
        },
        onTimeout: () => setPhase({ kind: "expired" }),
        onError: (message) => setPhase({ kind: "error", message }),
      },
      controller.signal,
    ).catch((e: unknown) => {
      if (!controller.signal.aborted)
        setPhase({ kind: "error", message: (e as Error).message });
    });
  }, [workspaceId, onConnected]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{wa.subtitle}</p>

      {phase.kind === "qr" ? (
        <div className="flex flex-col items-center gap-2 self-center py-2">
          <div className="rounded-lg bg-white p-3">
            <QRCodeSVG value={phase.value} size={208} />
          </div>
          <p className="max-w-xs text-center text-xs text-muted-foreground">
            {wa.dialogHint}
          </p>
        </div>
      ) : phase.kind === "loading" ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {wa.dialogLoading}
        </p>
      ) : phase.kind === "connected" ? (
        <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
          {wa.connectedAs.replace("{number}", phase.number)}
        </p>
      ) : phase.kind === "expired" || phase.kind === "error" ? (
        <div className="flex items-center gap-3">
          <span className="text-xs text-destructive">
            {phase.kind === "expired" ? wa.dialogExpired : wa.dialogError}
          </span>
          <button
            type="button"
            onClick={start}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            {wa.dialogRetry}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={start}
          className="self-start rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          {wa.connectAction}
        </button>
      )}
    </div>
  );
}

/**
 * WhatsApp replies (bot) config — rendered on the WhatsApp channel card under
 * the group list. Toggles the `chat` capability, sets the send scope (DM-only
 * by default; groups gated), and manages the reply triggers (mention / keyword
 * / DM / always). Backed by the bot endpoints in whatsapp-ingest-admin.ts.
 * Personal-number caveat: replying into groups sends from the user's own
 * number, so groups are opt-in and surfaced with a warning.
 */
/**
 * WhatsApp bot access control — who the bot may answer (Telegram-parity).
 * Everyone / specific numbers (allowlist) / people in my groups. The allowlist
 * numbers are phone digits, re-normalized server-side. Saves through the
 * `/whatsapp/bot/access` endpoint via the parent's `run` wrapper.
 */
function WhatsappAccessControl({
  config,
  busy,
  onSave,
}: {
  config: WhatsappBotConfig;
  busy: boolean;
  onSave: (mode: WhatsappBotAccessMode, numbers: string[]) => void;
}) {
  const t = useT();
  const acc = t.studioPage.ingestRules.whatsapp.bot.access;
  const mode = config.accessMode;
  // The chip list shows whichever number-mode is active.
  const numberMode = mode === "blocklist";
  const numbers = numberMode ? config.blockedNumbers : config.allowedNumbers;
  const showNumbers = mode === "allowlist" || mode === "blocklist";

  function addNumber(value: string): void {
    const digits = value.replace(/\D/g, "");
    if (digits.length < 5 || numbers.includes(digits)) return;
    onSave(mode, [...numbers, digits]);
  }

  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">{acc.label}</span>
        <Select
          value={mode}
          disabled={busy}
          onValueChange={(v) => {
            if (v) onSave(v as WhatsappBotAccessMode, numbers);
          }}
        >
          <SelectTrigger size="sm" className="min-w-[13rem] text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="allow_all">{acc.everyone}</SelectItem>
            <SelectItem value="allowlist">{acc.numbers}</SelectItem>
            <SelectItem value="blocklist">{acc.block}</SelectItem>
            <SelectItem value="group_members">{acc.groupMembers}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs italic text-muted-foreground">
        {mode === "allowlist"
          ? acc.numbersDesc
          : mode === "blocklist"
            ? acc.blockDesc
            : mode === "group_members"
              ? acc.groupMembersDesc
              : acc.everyoneDesc}
      </p>
      {showNumbers && (
        <div className="flex flex-col gap-1.5">
          {numbers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {numbers.map((num, i) => (
                <span
                  key={`${num}-${i}`}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs"
                >
                  {num}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={acc.removeNumber}
                    onClick={() =>
                      onSave(
                        mode,
                        numbers.filter((_, j) => j !== i),
                      )
                    }
                    className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem(
                "waAccessNumber",
              ) as HTMLInputElement;
              addNumber(input.value);
              input.value = "";
            }}
            className="flex items-center gap-2"
          >
            <input
              name="waAccessNumber"
              type="text"
              inputMode="numeric"
              disabled={busy}
              placeholder={acc.numberPlaceholder}
              className="w-44 rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {numberMode ? acc.blockNumber : acc.addNumber}
            </button>
          </form>
          <p className="text-xs text-muted-foreground">{acc.numberHint}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Acknowledgment reaction — the emoji reacted to the inbound message when the
 * bot starts working. Mirrors the Telegram/Slack "Acknowledgment reaction"
 * control (the WhatsApp adapter supports `sendReaction`).
 */
function WhatsappAckReaction({
  value,
  busy,
  onSave,
}: {
  value: string;
  busy: boolean;
  onSave: (emoji: string) => void;
}) {
  const t = useT();
  const cfg = t.studioPage.channels.config;
  const hint = t.studioPage.ingestRules.whatsapp.bot.ackHint;
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm">{cfg.ackLabel}</span>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={draft}
          disabled={busy}
          placeholder="👀"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== value) onSave(draft);
          }}
          className="w-32 rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
        />
        {["👀", "🧠", "👍"].map((emoji) => (
          <button
            key={emoji}
            type="button"
            disabled={busy}
            onClick={() => onSave(emoji)}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            {emoji}
          </button>
        ))}
        {value ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onSave("")}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {cfg.ackClear}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Per-group reply opt-in — which group chats the bot answers in (consulted when
 * the send scope is `dm_and_groups`). The WhatsApp analogue of Telegram's
 * per-chat / per-topic overrides; WhatsApp groups have no topics, so it is a
 * flat group checklist. Group inventory comes from the seen-group list.
 */
function WhatsappGroupOptIn({
  workspaceId,
  selected,
  busy,
  onSave,
}: {
  workspaceId: string;
  selected: string[];
  busy: boolean;
  onSave: (groupOptIn: string[]) => void;
}) {
  const t = useT();
  const wa = t.studioPage.ingestRules.whatsapp;
  const bot = wa.bot;
  const [groups, setGroups] = useState<WhatsappGroup[] | null>(null);

  useEffect(() => {
    getWhatsappIngest(workspaceId)
      .then((s) => setGroups(s.groups))
      .catch(() => setGroups([]));
  }, [workspaceId]);

  function toggle(chatJid: string): void {
    const next = selected.includes(chatJid)
      ? selected.filter((j) => j !== chatJid)
      : [...selected, chatJid];
    onSave(next);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm">{bot.groupOptInTitle}</span>
      <p className="text-xs text-muted-foreground">{bot.groupOptInHint}</p>
      {groups === null ? (
        <p className="text-xs text-muted-foreground">{wa.working}</p>
      ) : groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">{bot.groupOptInEmpty}</p>
      ) : (
        <div className="flex flex-col gap-1 rounded-md border border-border p-2">
          {groups.map((g) => (
            <label
              key={g.chatJid}
              className="flex items-center gap-2 text-xs"
            >
              <input
                type="checkbox"
                disabled={busy}
                checked={selected.includes(g.chatJid)}
                onChange={() => toggle(g.chatJid)}
              />
              <span className="truncate">{g.title ?? wa.untitledGroup}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function WhatsappRepliesSection({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const bot = t.studioPage.ingestRules.whatsapp.bot;
  const [config, setConfig] = useState<WhatsappBotConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [newType, setNewType] = useState("is_dm");
  const [keywords, setKeywords] = useState("");

  const load = useCallback(() => {
    getWhatsappBot(workspaceId)
      .then(setConfig)
      .catch(() => setConfig(null));
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(false);
    try {
      await fn();
      load();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const triggerLabel = (ft: string): string =>
    ft === "is_dm"
      ? bot.triggerIsDm
      : ft === "is_mention"
        ? bot.triggerIsMention
        : ft === "keyword_match"
          ? bot.triggerKeyword
          : ft === "always"
            ? bot.triggerAlways
            : ft;

  const chatEnabled = config?.chatEnabled ?? false;

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t.studioPage.channels.config.title}
      </div>

      {/* Enable replies — the `chat` capability toggle, styled like the other
          channels' bot-behavior toggles (ConfigToggle). */}
      <ConfigToggle
        label={bot.enableLabel}
        hint={bot.enableHint}
        checked={chatEnabled}
        disabled={busy || !config?.connected}
        onChange={(v) =>
          void run(() =>
            v
              ? enableWhatsappBot(workspaceId, "dm")
              : disableWhatsappBot(workspaceId),
          )
        }
      />

      {chatEnabled && config && (
        <>
          {/* Acknowledgment reaction (emoji reacted when the bot starts). */}
          <WhatsappAckReaction
            value={config.ackReaction}
            busy={busy}
            onSave={(emoji) =>
              run(() => setWhatsappBotBehavior(workspaceId, { ackReaction: emoji }))
            }
          />

          {/* Reply scope — label left, control right (Telegram parity). */}
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">{bot.scopeLabel}</span>
            <Select
              value={config.sendScope}
              disabled={busy}
              onValueChange={(v) => {
                if (v) void run(() => enableWhatsappBot(workspaceId, v as WhatsappBotSendScope));
              }}
            >
              <SelectTrigger size="sm" className="min-w-[13rem] text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dm">{bot.scopeDm}</SelectItem>
                <SelectItem value="dm_and_groups">{bot.scopeGroups}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {config.sendScope === "dm_and_groups" && (
            <>
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {bot.groupWarning}
              </p>
              <WhatsappGroupOptIn
                workspaceId={workspaceId}
                selected={config.groupOptIn}
                busy={busy}
                onSave={(groupOptIn) =>
                  run(() => setWhatsappBotBehavior(workspaceId, { groupOptIn }))
                }
              />
            </>
          )}

          <WhatsappAccessControl
            config={config}
            busy={busy}
            onSave={(mode, numbers) =>
              run(() => setWhatsappBotAccess(workspaceId, mode, numbers))
            }
          />

          {/* Reply triggers (WhatsApp's bot-behavior analogue of Telegram's
              per-chat overrides). */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm">{bot.triggersTitle}</span>
            {config.triggers.length === 0 ? (
              <p className="text-xs text-muted-foreground">{bot.triggersEmpty}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {config.triggers.map((tr) => {
                  const kw = (tr.filterParams as { keywords?: unknown }).keywords;
                  return (
                    <li key={tr.id} className="flex items-center gap-2 text-xs">
                      <span className="font-medium">{triggerLabel(tr.filterType)}</span>
                      {tr.filterType === "keyword_match" && Array.isArray(kw) && (
                        <span className="font-mono text-muted-foreground">
                          {(kw as string[]).join(", ")}
                        </span>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(() => deleteWhatsappBotTrigger(workspaceId, tr.id))
                        }
                        className="ml-auto text-muted-foreground hover:text-destructive disabled:opacity-50"
                      >
                        {bot.remove}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Select value={newType} onValueChange={(v) => v && setNewType(v)}>
                <SelectTrigger size="sm" className="min-w-[11rem] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="is_dm">{bot.triggerIsDm}</SelectItem>
                  <SelectItem value="is_mention">{bot.triggerIsMention}</SelectItem>
                  <SelectItem value="keyword_match">{bot.triggerKeyword}</SelectItem>
                  <SelectItem value="always">{bot.triggerAlways}</SelectItem>
                </SelectContent>
              </Select>
              {newType === "keyword_match" && (
                <input
                  type="text"
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  placeholder={bot.keywordsPlaceholder}
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
                />
              )}
              <button
                type="button"
                disabled={busy || (newType === "keyword_match" && !keywords.trim())}
                onClick={() =>
                  void run(() =>
                    addWhatsappBotTrigger(
                      workspaceId,
                      newType,
                      newType === "keyword_match"
                        ? {
                            keywords: keywords
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          }
                        : {},
                    ),
                  )
                }
                className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {bot.add}
              </button>
            </div>
          </div>
        </>
      )}

      {error && <p className="text-xs text-destructive">{bot.error}</p>}
    </div>
  );
}

/**
 * WhatsApp card config wrapper. Surfaces the live connection state so a
 * phone-side logout (device unlinked in the WhatsApp app → the integration
 * flips to `revoked` server-side) shows a reconnect prompt instead of stale
 * controls. Re-checks on focus / visibility / a light interval — the old
 * standalone panel did this; the channel card otherwise only loads on mount.
 * When connected, renders the replies (bot) config. Group ingestion lives on
 * the Studio → Events page now (the Channels/Events split — Channels owns the
 * chat/broadcast surface, Events owns ingestion).
 */
// Official shared-bot surface (hosted-only). The number is paired centrally; a
// workspace doesn't pair it - users add the number to a group (which binds that
// group to the adder's workspace) and manage their bound groups here. Backend:
// packages/api-platform/src/routes/whatsapp-official-admin.ts.
// [COMP:app-web/whatsapp-official-card]
function WhatsappOfficialCard({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const c = t.studioPage.channels.whatsappOfficial;
  const [state, setState] = useState<{
    officialNumber: string | null;
    bindings: WhatsappOfficialBinding[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getWhatsappOfficial(workspaceId)
      .then((s) => {
        setState({ officialNumber: s.officialNumber, bindings: s.bindings });
        setError(null);
      })
      .catch(() => setError(c.loadError));
  }, [workspaceId, c.loadError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function onStop(groupJid: string) {
    const ok = await confirmDialog({
      title: c.stopConfirmTitle,
      description: c.stopConfirmBody,
      confirmLabel: c.stopConfirmCta,
      cancelLabel: c.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setStopping(groupJid);
    try {
      await unbindWhatsappOfficialGroup(workspaceId, groupJid);
      refresh();
    } catch {
      setError(c.stopError);
    } finally {
      setStopping(null);
    }
  }

  return (
    <section className="border border-border rounded-md bg-card/50 p-4 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{c.title}</h3>
        <p className="text-[13px] text-muted-foreground max-w-prose">{c.intro}</p>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{c.numberLabel}</span>
        {state?.officialNumber ? (
          <code className="text-sm font-medium">{state.officialNumber}</code>
        ) : (
          <span className="text-[13px] text-muted-foreground">
            {c.numberUnconfigured}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">{c.howToTitle}</span>
        <ol className="list-decimal list-inside text-[13px] text-muted-foreground flex flex-col gap-1">
          <li>{c.howToStep1}</li>
          <li>{c.howToStep2}</li>
          <li>{c.howToStep3}</li>
        </ol>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <span className="text-xs font-medium">{c.groupsTitle}</span>
        {error ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">{error}</p>
        ) : null}
        {state === null ? null : state.bindings.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{c.groupsEmpty}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {state.bindings.map((b) => (
              <li
                key={b.groupJid}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="flex flex-col min-w-0">
                  <code className="truncate text-[13px]">{b.groupJid}</code>
                  <span className="text-xs text-muted-foreground">
                    {b.boundByYou ? c.boundByYou : c.boundByTeammate}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => onStop(b.groupJid)}
                  disabled={stopping === b.groupJid}
                  className="shrink-0 text-xs font-medium rounded-md border border-border px-2 py-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {stopping === b.groupJid ? c.stopping : c.stopCta}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function WhatsappCardSection({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const wa = t.studioPage.ingestRules.whatsapp;
  const [connected, setConnected] = useState<boolean | null>(null);

  const refresh = useCallback(() => {
    getWhatsappIngest(workspaceId)
      .then((s) => setConnected(s.connected))
      .catch(() => setConnected(false));
  }, [workspaceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    const id = window.setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(id);
    };
  }, [refresh]);

  if (connected === false) {
    return (
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {wa.disconnectedNote}
        </p>
        <WhatsappConnectTab workspaceId={workspaceId} onConnected={refresh} />
      </div>
    );
  }

  return <WhatsappRepliesSection workspaceId={workspaceId} />;
}
