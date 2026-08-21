"use client";

/**
 * Studio → Channels section (app-web), master-detail.
 *
 * The workspace-channels operator surface (Phase D of
 * docs/architecture/channels/adapter-pattern.md → "Workspace channels").
 * Channels are owned by the workspace — this page lists them, renames them,
 * edits each one's clearance and enabled capabilities, and wires per-surface
 * assistant routing. Channels are *created* by connecting a bot from the
 * "+ Add channel" modal (`AddChannelDialog`); there is no separate "new
 * channel" page.
 *
 * Mirrors Studio → Connectors / Events: a left rail groups every channel by
 * status — Needs attention (revoked/invalid) / Active / the hosted-only
 * official WhatsApp shared-bot pseudo-row — and the selected row's management
 * panel renders beside it (clearance + capabilities, bot behavior config,
 * assistant routing, disconnect). Bucketing is the pure helper
 * `@/lib/channel-rail-groups` ([COMP:app-web/channel-rail-groups]).
 *
 * app-web deltas vs the retired apps/web page:
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
import { cn } from "@/lib/utils";
import { useWorkspaces } from "@/contexts/workspace-context";
import { authFetch } from "@/lib/auth-fetch";
import { buildManifest } from "@/components/slack-setup-inline";
import { buildTeamsAppPackage } from "@/lib/teams-app-package";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import {
  groupChannelRail,
  type ChannelRailGroupId,
} from "@/lib/channel-rail-groups";
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
import { modelTierPlanGateApplies } from "@/lib/plan-gate";
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
  connectFeishuChannel,
  connectMsTeamsChannel,
  connectWhatsAppCloudChannel,
  startWechatPairing,
  getWechatPairingStatus,
  submitWechatVerifyCode,
  connectCustomChannel,
  rotateCustomChannelToken,
  getCustomChannelState,
  submitCustomChannelInput,
  disconnectCustomChannel,
  customChannelBridgePath,
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
  type CustomChannelState,
  type RequireMentionOverride,
  type UserAccessMode,
} from "@/lib/api/channels";
import { listAssistants, type StudioAssistantSummary } from "@/lib/api/studio";
import type { WorkspaceRole } from "@/lib/api/workspaces";
import {
  probeEmailInboxes,
  createEmailInbox,
  updateEmailInbox,
  deleteEmailInbox,
  type EmailInbox,
  type EmailDomainSummary,
} from "@/lib/api/email-inboxes";
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
import { StudioTopbarActions } from "@/components/studio/studio-topbar";
import { DISPLAY_API_URL } from "@/lib/display-api-url";
import {
  Bot,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  MessageCircle,
  Pencil,
  SmilePlus,
  UsersRound,
  X,
} from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";

// Slack manifest's `request_url` must be a syntactically valid URL — Slack
// posts a verification challenge to it. Our slack route returns the challenge
// for any URL regardless of channel id (the route's url_verification handler
// runs before integration lookup), so this placeholder satisfies Slack until
// the real URL is shown after Connect and the user updates Event Subscriptions.
// Uses the absolute display origin: in dev the fetch base is blanked
// (next.config rewrite) and a relative URL would be invalid in the manifest.
const PLACEHOLDER_SLACK_WEBHOOK_URL = `${DISPLAY_API_URL}/webhook/slack/REPLACE-AFTER-CONNECT`;

// Glyphs for channel types without a dedicated brand mark. WhatsApp was
// dropped from the product UI; legacy rows still in the backend fall back to a
// generic glyph rather than rendering blank.
const PLATFORM_GLYPH: Partial<Record<Channel["channelType"], string>> = {
  slack: "#",
  feishu: "F",
  email: "@",
  msteams: "T",
  wechat: "微",
  custom: "∞",
};

function TelegramGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-[1.1rem] w-[1.1rem]"
    >
      <circle cx="12" cy="12" r="12" fill="#229ED9" />
      <path
        fill="#fff"
        transform="translate(0 1.5)"
        d="M18.07 5.51c.28-.11.54.07.47.42l-2.12 10c-.05.24-.2.3-.4.19l-3.22-2.38-1.55 1.49c-.17.17-.32.31-.65.31l.23-3.28 5.97-5.39c.26-.23-.06-.36-.4-.13l-7.38 4.65-3.18-.99c-.69-.22-.7-.69.14-1.02l12.09-4.66Z"
      />
    </svg>
  );
}

// Official Discord mark, monochrome — `fill-current` inherits the chip's
// `text-muted-foreground` without injecting brand colour. Sized to match the
// `text-base` glyphs.
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

/**
 * Platform mark for a channel row — Telegram and Discord get brand SVGs,
 * WhatsApp the shared brand icon (`ConnectorIcon`, same as the Events rail),
 * and legacy/unknown types fall back to a dot.
 */
function ChannelTypeIcon({ type }: { type: Channel["channelType"] }) {
  if (type === "telegram") return <TelegramGlyph />;
  if (type === "discord") return <DiscordGlyph />;
  if (type === "whatsapp") return <ConnectorIcon connectorId="whatsapp" />;
  return <>{PLATFORM_GLYPH[type] ?? "•"}</>;
}

/** Status pill — shared by the detail headers (Connectors/Events parity). */
function pillCls(tone: "on" | "off" | "attention"): string {
  return cn(
    "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
    tone === "attention"
      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
      : tone === "on"
        ? "bg-primary/10 text-primary"
        : "bg-muted text-muted-foreground",
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

export function normalizeWhatsAppPhoneNumberInput(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const rawDigits = trimmed.replace(/\D/g, "");
  const digits = trimmed.startsWith("00") ? rawDigits.slice(2) : rawDigits;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
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
 * Pull the caller's own `workspace_members` row for `workspaceId` off the
 * existing `GET /workspaces/:id` endpoint. The endpoint returns `members[]`
 * with one row per workspace member; we match on `me.id` to find ours.
 *
 * Two fields are read from it. `clearance` filters the clearance dropdown to
 * the caller's own tier (RLS would reject a higher one anyway). `role` gates
 * the rename affordance — the PATCH route refuses `displayName` from a plain
 * member, so showing the pencil to one would only produce a 403.
 *
 * Returns nulls on any failure: the UI then keeps its safe 'internal' default
 * and treats the caller as a non-admin, so a failed probe never *grants* an
 * affordance the server would reject.
 */
async function fetchWorkspaceMembership(workspaceId: string): Promise<{
  clearance: ChannelClearance | null;
  role: WorkspaceRole | null;
}> {
  try {
    const res = await authFetch(
      `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}`,
    );
    if (!res.ok) return { clearance: null, role: null };
    const data = (await res.json()) as {
      me?: { id?: string };
      members?: {
        userId: string;
        clearance?: ChannelClearance;
        role?: WorkspaceRole;
      }[];
    };
    const meId = data.me?.id;
    if (!meId || !Array.isArray(data.members)) return { clearance: null, role: null };
    const mine = data.members.find((m) => m.userId === meId);
    return { clearance: mine?.clearance ?? null, role: mine?.role ?? null };
  } catch {
    return { clearance: null, role: null };
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
  // The caller's workspace role, from the same GET /workspaces/:id read.
  // Null until it resolves (and on failure) — rename stays hidden until we
  // positively know the caller is an owner or admin.
  const [myRole, setMyRole] = useState<WorkspaceRole | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // Master-detail selection — a rail row key (channel UUID or "official");
  // null / stale keys resolve to the first rail row.
  const [selected, setSelected] = useState<string | null>(null);
  // Assistant email inboxes (agentmail.md). Null while probing; a 503 probe
  // means no email provider is configured server-side — the email tab and
  // inbox affordances then stay hidden (the dark contract).
  const [emailInboxes, setEmailInboxes] = useState<EmailInbox[] | null>(null);
  const [emailDomains, setEmailDomains] = useState<EmailDomainSummary[]>([]);
  const [emailConfigured, setEmailConfigured] = useState(false);

  const refreshEmailInboxes = useCallback(async () => {
    if (!activeId) return;
    try {
      const probe = await probeEmailInboxes(activeId);
      if (probe.configured) {
        setEmailConfigured(true);
        setEmailInboxes(probe.inboxes);
        setEmailDomains(probe.domains);
      } else {
        setEmailConfigured(false);
        setEmailInboxes([]);
        setEmailDomains([]);
      }
    } catch {
      // Probe failure hides the surface — same posture as not configured.
      setEmailConfigured(false);
    }
  }, [activeId]);

  useEffect(() => {
    setEmailInboxes(null);
    setEmailConfigured(false);
    void refreshEmailInboxes();
  }, [refreshEmailInboxes]);

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
        const [chans, asts, me] = await Promise.all([
          listChannels(activeId),
          listAssistants(activeId),
          fetchWorkspaceMembership(activeId),
        ]);
        if (cancelled) return;
        setAssistants(asts);
        setChannels(chans);
        if (me.clearance) setMyClearance(me.clearance);
        setMyRole(me.role);
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
      // Jump the detail panel to the fresh install.
      setSelected(created.id);
      // The backend may have seeded a default `channel_assistants` row when
      // `defaultAssistantId` was provided — pull routing so the new panel
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

  const tr = t.studioPage.channels;

  // ── Rail bucketing + selection resolution ─────────────────────
  //
  // The official shared bot (hosted-only, gated behind isHostedEdition() so
  // the open OSS core never renders it — its backend lives in closed
  // api-platform; docs/architecture/channels/whatsapp.md) joins the rail as a
  // page-level pseudo-row: it has no `channels` row.
  const officialPresent = isHostedEdition() && !!activeId;
  const railGroups = groupChannelRail({
    channels: channels ?? [],
    official: officialPresent,
  });
  const groupLabels: Record<ChannelRailGroupId, string> = {
    attention: tr.sectionAttention,
    active: tr.sectionActive,
    official: tr.sectionOfficial,
  };
  const railOrder = railGroups.flatMap((g) => g.rows);
  const sel = railOrder.find((r) => r.key === selected) ?? railOrder[0] ?? null;
  const selKey = sel?.key ?? null;

  const platformLabel = (type: Channel["channelType"]): string =>
    (tr.platforms as Partial<Record<Channel["channelType"], string>>)[type] ??
    type;

  function railRowButton(row: (typeof railOrder)[number]) {
    const isSel = selKey === row.key;
    const isChannel = row.kind === "channel";
    const label = isChannel ? row.channel.displayName : tr.whatsappOfficial.title;
    const subtitle = isChannel
      ? platformLabel(row.channel.channelType)
      : platformLabel("whatsapp");
    const dot: "on" | "attention" | null = !isChannel
      ? null
      : row.channel.status === "active"
        ? "on"
        : "attention";
    return (
      <li key={row.key}>
        <button
          type="button"
          onClick={() => setSelected(row.key)}
          aria-current={isSel ? "true" : undefined}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            isSel
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <ChannelTypeIcon
              type={isChannel ? row.channel.channelType : "whatsapp"}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{label}</span>
            <span className="block truncate text-[11px] font-normal text-muted-foreground">
              {subtitle}
            </span>
          </span>
          {dot && (
            <span
              aria-hidden
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                dot === "attention" ? "bg-amber-500" : "bg-primary",
              )}
            />
          )}
        </button>
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <StudioTopbarActions>
        {activeId && (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="shrink-0 text-sm font-medium rounded-md bg-action text-action-foreground px-3 py-1.5"
          >
            {tr.add.cta}
          </button>
        )}
      </StudioTopbarActions>

      {activeId && (
        <AddChannelDialog
          open={addOpen}
          onClose={() => setAddOpen(false)}
          workspaceId={activeId}
          assistants={assistants}
          onCreated={onChannelCreated}
          emailConfigured={emailConfigured}
          emailDomains={emailDomains}
          onEmailCreated={refreshEmailInboxes}
        />
      )}

      {!activeId ? (
        <div className="text-sm text-muted-foreground border border-border rounded-md p-4">
          {tr.noActiveWorkspace}
        </div>
      ) : error ? (
        <div className="text-sm text-muted-foreground border border-border rounded-md p-4">
          {tr.loadError}
        </div>
      ) : channels === null ? (
        <div className="text-sm text-muted-foreground py-10 text-center">
          {tr.loading}
        </div>
      ) : railOrder.length === 0 ? (
        <div className="border border-border rounded-md bg-card/50 p-6 flex flex-col gap-1">
          <div className="font-medium text-sm">{tr.emptyTitle}</div>
          <p className="text-sm text-muted-foreground">{tr.emptyBody}</p>
        </div>
      ) : (
        /* ── Master-detail: status-grouped rail + selected channel panel ── */
        <div className="flex flex-col gap-6 md:flex-row">
          <aside className="w-full md:w-64 shrink-0 self-start">
            <nav aria-label={tr.railAriaLabel} className="flex flex-col gap-3">
              {railGroups.map((g) => (
                <div key={g.id}>
                  <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {groupLabels[g.id]}
                    <span className="font-normal text-muted-foreground/50">
                      {g.rows.length}
                    </span>
                  </div>
                  <ul className="flex flex-col gap-0.5">
                    {g.rows.map(railRowButton)}
                  </ul>
                </div>
              ))}
            </nav>
          </aside>

          {/* Detail — the selected channel's management panel. */}
          <div className="min-w-0 flex-1">
            {!sel ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                {tr.selectPrompt}
              </div>
            ) : sel.kind === "official" ? (
              <WhatsappOfficialDetail workspaceId={activeId} />
            ) : (
              <ChannelDetail
                key={sel.channel.id}
                workspaceId={activeId}
                channel={sel.channel}
                routing={routing[sel.channel.id] ?? []}
                assistants={assistants}
                myClearance={myClearance}
                canRename={myRole === "owner" || myRole === "admin"}
                onUpdated={onChannelUpdated}
                onRoutingChanged={() => refreshRouting(sel.channel.id)}
                onDeleted={onChannelDeleted}
                emailInbox={
                  sel.channel.channelType === "email"
                    ? (emailInboxes ?? []).find((i) => i.channelId === sel.channel.id) ?? null
                    : null
                }
                onEmailChanged={refreshEmailInboxes}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The selected channel's management panel — the master-detail right pane.
 * Header (platform mark, click-to-edit name, status pill), clearance +
 * capabilities, the per-platform bot-behavior config, assistant routing, and
 * disconnect.
 *
 * The name is `channels.display_name` — the workspace's own label, seeded from
 * the platform on connect (Slack team name, Telegram bot username, …). It is
 * editable here through the same `PATCH .../channels/:id` that carries
 * clearance and capabilities; the platform-side bot name is untouched.
 */
export function ChannelDetail({
  workspaceId,
  channel,
  routing,
  assistants,
  myClearance,
  canRename,
  onUpdated,
  onRoutingChanged,
  onDeleted,
  emailInbox = null,
  onEmailChanged,
}: {
  workspaceId: string;
  channel: Channel;
  routing: ChannelAssistant[];
  assistants: StudioAssistantSummary[];
  myClearance: ChannelClearance;
  /**
   * Whether the caller may rename the channel — workspace owner or admin only,
   * mirroring the `rename_requires_admin` gate on the PATCH route. Everything
   * else in this panel stays open to any member.
   */
  canRename: boolean;
  onUpdated: (c: Channel) => void;
  onRoutingChanged: () => void;
  onDeleted: (channelId: string) => void;
  emailInbox?: EmailInbox | null;
  onEmailChanged?: () => void | Promise<void>;
}) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  // `boolean | "clearanceTooHigh"` — distinguish the (403 RLS WITH CHECK)
  // case so the inline message can explain *why* a save was rejected. The
  // server returns `error: 'clearance_exceeds_member_tier'` for this; any
  // other failure falls back to the generic saveError copy.
  const [saveError, setSaveError] = useState<
    boolean | "clearanceTooHigh" | "renameNotAllowed"
  >(false);
  // Header rename. The panel is keyed by channel id upstream, so this state is
  // per-channel by construction; the draft is seeded when the user opens the
  // editor rather than mirrored from the prop, so an in-flight edit survives
  // an unrelated refresh of the channel row.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [attachAssistantId, setAttachAssistantId] = useState("");
  const [attachSurface, setAttachSurface] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);

  async function onDisconnect(): Promise<void> {
    const dc = t.studioPage.channels.disconnect;
    const ok = await confirmDialog({
      title: dc.confirmTitle,
      description: dc.warning,
      confirmLabel: dc.confirm,
      cancelLabel: dc.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setDeleting(true);
    setDeleteError(false);
    try {
      if (channel.channelType === "email") {
        // Email inboxes tear down through their own surface — it deletes the
        // vendor inbox + connector instance before the channel row cascades.
        await deleteEmailInbox({ workspaceId, channelId: channel.id });
      } else {
        await deleteChannel(workspaceId, channel.id);
      }
      onDeleted(channel.id);
      // On success the panel unmounts via onDeleted — leave `deleting` true
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
    p: Partial<Pick<Channel, "clearance" | "enabledCapabilities" | "displayName">>,
  ): Promise<boolean> {
    setSaving(true);
    setSaveError(false);
    try {
      onUpdated(await updateChannel(workspaceId, channel.id, p));
      return true;
    } catch (e) {
      // The route now translates RLS clearance rejections into a 403 with
      // `error: 'clearance_exceeds_member_tier'`; pick that up so we can
      // explain *why* it failed instead of the generic "couldn't save".
      const msg = (e as Error).message;
      setSaveError(
        msg.includes("clearance_exceeds_member_tier")
          ? "clearanceTooHigh"
          : // Belt-and-braces: the pencil is hidden for non-admins, so this
            // only fires for a role that changed under a stale page.
            msg.includes("rename_requires_admin")
            ? "renameNotAllowed"
            : true,
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  /**
   * Commit the header rename. The name is the workspace's own label for the
   * channel (`channels.display_name`), seeded from the platform on connect —
   * renaming here never touches the bot or team name on the platform side.
   * Owner / admin only, matching the route's `rename_requires_admin` gate.
   * Empty / unchanged drafts are dropped rather than sent: the route's zod
   * `displayName` is `min(1)`, so a blank submit would 400.
   */
  async function onRename(): Promise<void> {
    if (!canRename) {
      setRenaming(false);
      return;
    }
    const next = nameDraft.trim();
    if (!next || next === channel.displayName) {
      setRenaming(false);
      return;
    }
    if (await patch({ displayName: next })) setRenaming(false);
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
    <div className="space-y-4">
      {/* Header — platform mark, name, platform line, status pill. */}
      <div className="flex items-start gap-3">
        <div
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-base font-medium text-muted-foreground"
        >
          <ChannelTypeIcon type={channel.channelType} />
        </div>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void onRename();
              }}
            >
              <input
                type="text"
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setRenaming(false);
                  }
                }}
                disabled={saving}
                // Matches the route's zod cap (displayName: max 200).
                maxLength={200}
                placeholder={t.studioPage.channels.rename.placeholder}
                aria-label={t.studioPage.channels.rename.placeholder}
                className="min-w-0 flex-1 rounded-md border border-border bg-muted/50 px-2 py-1 text-[15px] font-semibold tracking-tight text-foreground placeholder:font-normal placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={saving || !nameDraft.trim()}
                className="shrink-0 rounded-md bg-action px-2.5 py-1 text-[12px] font-medium text-action-foreground transition-colors hover:bg-action/80 disabled:pointer-events-none disabled:opacity-50"
              >
                {saving
                  ? t.studioPage.channels.saving
                  : t.studioPage.channels.rename.save}
              </button>
              <button
                type="button"
                onClick={() => setRenaming(false)}
                disabled={saving}
                className="shrink-0 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                {t.studioPage.channels.rename.cancel}
              </button>
            </form>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <h2 className="truncate text-[15px] font-semibold tracking-tight">
                {channel.displayName}
              </h2>
              {canRename && (
                <button
                  type="button"
                  onClick={() => {
                    setNameDraft(channel.displayName);
                    setSaveError(false);
                    setRenaming(true);
                  }}
                  aria-label={t.studioPage.channels.rename.action}
                  title={t.studioPage.channels.rename.action}
                  className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </div>
          )}
          <p
            className={cn(
              "text-[12px] text-muted-foreground",
              // The platform line is one word; the rename hint is a sentence
              // and must wrap rather than clip.
              renaming ? "mt-1" : "truncate",
            )}
          >
            {renaming
              ? t.studioPage.channels.rename.hint
              : (t.studioPage.channels.platforms as Partial<Record<Channel["channelType"], string>>)[
                  channel.channelType
                ] ?? channel.channelType}
          </p>
        </div>
        <span className={pillCls(statusActive ? "on" : "attention")}>
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
        ) : saveError === "renameNotAllowed" ? (
          <span className="text-xs text-destructive">
            {t.studioPage.channels.rename.notAllowedError}
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

      {/* Custom bridge — live state card (polls while the panel is open),
          the action surface, token rotation and bridge disconnect. */}
      {channel.channelType === "custom" && (
        <CustomBridgeSection workspaceId={workspaceId} channel={channel} />
      )}

      {(channel.channelType === "slack" ||
        channel.channelType === "telegram" ||
        channel.channelType === "discord" ||
        channel.channelType === "feishu" ||
        channel.channelType === "custom" ||
        (channel.channelType === "whatsapp" && channel.integrationProvider === "cloud_api")) &&
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
      {channel.channelType === "whatsapp" && channel.integrationProvider !== "cloud_api" && (
        <WhatsappCardSection workspaceId={workspaceId} />
      )}

      {channel.channelType === "whatsapp" && channel.integrationProvider === "cloud_api" && (
        <>
          <div className="rounded-lg border border-border px-4 py-3 text-xs text-muted-foreground">
            {t.studioPage.channels.add.whatsappCloudConnectedDetail}
          </div>
          <WhatsAppCloudChatSection
            phoneNumber={channel.config?.whatsappDisplayPhoneNumber ?? null}
          />
        </>
      )}

      {/* WeChat — the iLink bot limits, stated plainly on the connected card
          (bot contact, DMs only, no history, one connection). */}
      {channel.channelType === "wechat" && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border px-4 py-3">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {t.studioPage.channels.wechat.limitsTitle}
          </div>
          <ul className="flex flex-col gap-1 text-xs text-muted-foreground list-disc pl-4">
            <li>{t.studioPage.channels.wechat.limitContact}</li>
            <li>{t.studioPage.channels.wechat.limitDmsOnly}</li>
            <li>{t.studioPage.channels.wechat.limitNoHistory}</li>
            <li>{t.studioPage.channels.wechat.limitSingleConnection}</li>
          </ul>
        </div>
      )}

      {/* Assistant inbox — address + the sender allowlist (fail-closed gate:
          only these senders, plus workspace members, converse with the
          assistant; everyone else lands in the brain + an attention card). */}
      {channel.channelType === "email" && (
        <EmailInboxSection
          workspaceId={workspaceId}
          channel={channel}
          inbox={emailInbox}
          assistants={assistants}
          onChannelUpdated={onUpdated}
          onChanged={async () => {
            await onEmailChanged?.();
            onRoutingChanged();
          }}
        />
      )}

      {channel.channelType !== "email" && (
      <div className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3">
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
          {/* Official WhatsApp Cloud groups are addressable by Meta group id.
              Linked-number WhatsApp, WeChat, and custom bridge peer ids are not
              operator-discoverable here, so those transports use the default. */}
          {(channel.channelType !== "whatsapp" || channel.integrationProvider === "cloud_api") &&
            channel.channelType !== "wechat" &&
            channel.channelType !== "custom" && (
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
            className="text-sm font-medium rounded-md bg-action text-action-foreground px-3 py-1 disabled:opacity-50"
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
      )}

      {/* Disconnect — destructive, confirmed via the shared confirmDialog. */}
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => void onDisconnect()}
            disabled={deleting}
            className="text-xs font-medium text-destructive/70 hover:text-destructive transition-colors disabled:opacity-50"
          >
            {deleting
              ? t.studioPage.channels.disconnect.confirming
              : t.studioPage.channels.disconnect.cta}
          </button>
        </div>
        {deleteError && (
          <p className="text-xs text-destructive text-right">
            {t.studioPage.channels.disconnect.error}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Per-routing model picker. Patches `channel_assistants.model_alias` so each
 * routed surface can run on its own LLM tier (migration 197). Hosted Pro is
 * gated behind the Pro plan and Max behind Pro+Max; OSS has no plans. The
 * backend re-validates the same edition-aware policy.
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
  const edition = isHostedEdition() ? "hosted" : "oss";
  const proDisabled = modelTierPlanGateApplies(edition, plan, "pro");
  const maxDisabled = modelTierPlanGateApplies(edition, plan, "max");
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
 * Per-integration behavior config for a messaging channel — the
 * `channel_integrations.config` JSONB. Edits PATCH
 * `/workspaces/:id/channels/:id/config`; the server merges each patch into the
 * stored config. See docs/architecture/channels/adapter-pattern.md.
 */
export function ChannelConfigSection({
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
  const isWhatsAppCloud =
    channel.channelType === "whatsapp" && channel.integrationProvider === "cloud_api";
  // Discord's config surface today is access-control only: `requireMention` is
  // enforced connector-side (not from this config) and there is no ack-reaction
  // on the Discord inbound path, so both are hidden for Discord channels.
  const isDiscord = channel.channelType === "discord";
  const isFeishu = channel.channelType === "feishu";
  // A custom bridge: group mention gating (the bridge reports `isMentioned`)
  // + access control by bridge-reported sender id. No ack reaction — the
  // protocol has no reaction item.
  const isCustom = channel.channelType === "custom";
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

  const accessMode: UserAccessMode =
    config.userAccessMode ?? (isWhatsAppCloud ? "allowlist" : "allow_all");
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

  async function setTrustedGuestFullAccess(next: boolean): Promise<void> {
    if (next) {
      const ok = await confirmDialog({
        title: cfg.trustedGuestFullAccessConfirmTitle,
        description: cfg.trustedGuestFullAccessConfirmDescription,
        confirmLabel: cfg.trustedGuestFullAccessConfirmAction,
        cancelLabel: cfg.trustedGuestFullAccessConfirmCancel,
      });
      if (!ok) return;
    }
    await save({ allowTrustedGuestFullAccess: next });
  }

  const accessControl = (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">
          {isTelegram
            ? cfg.accessLabelTelegram
            : isWhatsAppCloud
              ? cfg.accessLabelWhatsApp
              : cfg.accessLabel}
        </span>
        <Select
          value={accessMode}
          items={{
            allow_all: isTelegram
              ? cfg.accessLinkedTelegram
              : cfg.accessAllowAll,
            allowlist: isTelegram
              ? cfg.accessAllowlistTelegram
              : cfg.accessAllowlist,
            blocklist: cfg.accessBlocklist,
          }}
          disabled={saving}
          onValueChange={(v) => {
            if (v) void save({ userAccessMode: v as UserAccessMode });
          }}
        >
          <SelectTrigger size="sm" className="text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="allow_all">
              {isTelegram ? cfg.accessLinkedTelegram : cfg.accessAllowAll}
            </SelectItem>
            <SelectItem value="allowlist">
              {isTelegram ? cfg.accessAllowlistTelegram : cfg.accessAllowlist}
            </SelectItem>
            <SelectItem value="blocklist">{cfg.accessBlocklist}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        {accessMode === "allowlist"
          ? isTelegram
            ? cfg.accessAllowlistDescTelegram
            : isWhatsAppCloud
              ? cfg.accessAllowlistDescWhatsApp
              : cfg.accessAllowlistDesc
          : accessMode === "blocklist"
            ? isTelegram
              ? cfg.accessBlocklistDescTelegram
              : isWhatsAppCloud
                ? cfg.accessBlocklistDescWhatsApp
                : cfg.accessBlocklistDesc
            : isSlack
              ? cfg.accessAllDescSlack
              : isDiscord
                ? cfg.accessAllDescDiscord
                : isFeishu
                  ? cfg.accessAllDescFeishu
                : isCustom
                  ? cfg.accessAllDescCustom
                  : isWhatsAppCloud
                    ? cfg.accessAllDescWhatsApp
                    : cfg.accessAllDescTelegram}
      </p>
      {accessMode !== "allow_all" && (
        <div className="flex flex-col gap-1.5 pt-1">
          {accessIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {accessIds.map((uid, i) => (
                <span
                  key={`${uid}-${i}`}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-1 text-xs font-mono"
                >
                  {uid}
                  <button
                    type="button"
                    disabled={saving}
                    aria-label={cfg.removeUser}
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
              let value = input.value;
              if (isWhatsAppCloud) {
                const normalized = normalizeWhatsAppPhoneNumberInput(value);
                if (!normalized) {
                  input.setCustomValidity(cfg.userIdInvalidWhatsApp);
                  input.reportValidity();
                  return;
                }
                value = normalized;
              }
              input.setCustomValidity("");
              addAccessId(value);
              input.value = "";
            }}
            className="flex items-center gap-2"
          >
            <input
              name="accessUserId"
              type="text"
              inputMode={isWhatsAppCloud ? "tel" : undefined}
              disabled={saving}
              onInput={(e) => e.currentTarget.setCustomValidity("")}
              placeholder={
                isSlack
                  ? cfg.userIdPlaceholderSlack
                  : isDiscord
                    ? cfg.userIdPlaceholderDiscord
                    : isFeishu
                      ? cfg.userIdPlaceholderFeishu
                    : isCustom
                      ? cfg.userIdPlaceholderCustom
                      : isWhatsAppCloud
                        ? cfg.userIdPlaceholderWhatsApp
                        : cfg.userIdPlaceholderTelegram
              }
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm font-mono"
            />
            <button
              type="submit"
              disabled={saving}
              className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {accessMode === "blocklist" ? cfg.blockUser : cfg.addUser}
            </button>
          </form>
          <p className="text-xs text-muted-foreground">
            {isSlack
              ? cfg.userIdHintSlack
              : isDiscord
                ? cfg.userIdHintDiscord
                : isFeishu
                  ? cfg.userIdHintFeishu
                : isCustom
                  ? cfg.userIdHintCustom
                  : isWhatsAppCloud
                    ? cfg.userIdHintWhatsApp
                    : cfg.userIdHintTelegram}
          </p>
        </div>
      )}
    </div>
  );

  const ackReactionControl = (
    <div className="flex flex-col gap-1">
      {!isTelegram && <span className="text-sm">{cfg.ackLabel}</span>}
      <p className="text-xs text-muted-foreground">
        {isSlack ? cfg.ackHintSlack : cfg.ackHintTelegram}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={config.ackReaction ?? ""}
          disabled={saving}
          aria-label={cfg.ackLabel}
          placeholder={isSlack ? "eyes" : "👀"}
          onChange={(e) =>
            setConfig((c) => ({ ...c, ackReaction: e.target.value }))
          }
          onBlur={() => void save({ ackReaction: config.ackReaction ?? "" })}
          className="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-sm font-mono"
        />
        {(isSlack ? ["eyes", "brain", "thumbsup"] : ["👀", "🧠", "👍"]).map(
          (emoji) => (
            <button
              key={emoji}
              type="button"
              disabled={saving}
              onClick={() => void save({ ackReaction: emoji })}
              className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
            >
              {isSlack ? `:${emoji}:` : emoji}
            </button>
          ),
        )}
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
  );

  if (isTelegram) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {cfg.title}
        </div>

        <div className="grid gap-3 xl:grid-cols-2">
          <section className="flex flex-col gap-3 rounded-lg border border-border bg-background p-3">
            <div className="flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400">
                <MessageCircle className="size-4" aria-hidden />
              </span>
              <h3 className="text-sm font-semibold">
                {cfg.telegramAccessTitle}
              </h3>
              <span className="ml-auto rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                {cfg.telegramAccessScope}
              </span>
            </div>
            {accessControl}
            {accessMode === "allowlist" && (
              <>
                <ConfigToggle
                  label={cfg.trustedGuestFullAccess}
                  hint={cfg.trustedGuestFullAccessHint}
                  checked={config.allowTrustedGuestFullAccess ?? false}
                  disabled={saving}
                  onChange={(v) => void setTrustedGuestFullAccess(v)}
                />
                {!config.allowTrustedGuestFullAccess && (
                  <ConfigToggle
                    label={cfg.guestConnectorTools}
                    hint={cfg.guestConnectorToolsHint}
                    checked={config.allowGuestConnectorTools ?? false}
                    disabled={saving}
                    onChange={(v) => void save({ allowGuestConnectorTools: v })}
                  />
                )}
              </>
            )}
          </section>

          <section className="flex flex-col gap-3 rounded-lg border border-border bg-background p-3">
            <div className="flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400">
                <UsersRound className="size-4" aria-hidden />
              </span>
              <h3 className="text-sm font-semibold">{cfg.telegramGroupTitle}</h3>
              <span className="ml-auto rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300">
                {cfg.telegramGroupScope}
              </span>
            </div>
            <ConfigToggle
              label={cfg.requireMention}
              hint={cfg.requireMentionHintTelegram}
              checked={config.requireMention ?? true}
              disabled={saving}
              onChange={(v) => void save({ requireMention: v })}
            />
            <TelegramMentionOverrides
              config={config}
              saving={saving}
              onChange={(next) => void save({ requireMentionOverrides: next })}
            />
          </section>

          <section className="flex flex-col gap-3 rounded-lg border border-border bg-background p-3 xl:col-span-2">
            <div className="flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <SmilePlus className="size-4" aria-hidden />
              </span>
              <h3 className="text-sm font-semibold">
                {cfg.telegramReactionTitle}
              </h3>
              <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {cfg.telegramAllChatsScope}
              </span>
            </div>
            {ackReactionControl}
          </section>
        </div>

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

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        {cfg.title}
      </div>

      {(isSlack || isFeishu) && (
        <ConfigToggle
          label={cfg.replyInThread}
          hint={cfg.replyInThreadHint}
          checked={config.replyInThread ?? false}
          disabled={saving}
          onChange={(v) => void save({ replyInThread: v })}
        />
      )}

      {!isDiscord && !isWhatsAppCloud && (
        <ConfigToggle
          label={cfg.requireMention}
          hint={
            isCustom
              ? cfg.requireMentionHintCustom
              : isFeishu
                ? cfg.requireMentionHintFeishu
                : cfg.requireMentionHintSlack
          }
          checked={config.requireMention ?? true}
          disabled={saving}
          onChange={(v) => void save({ requireMention: v })}
        />
      )}

      {/* Acknowledgment reaction — not wired on the Discord inbound path, and
          the custom bridge protocol has no reaction item. */}
      {!isDiscord && !isWhatsAppCloud && !isCustom && ackReactionControl}

      {accessControl}

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

export function WhatsAppCloudChatSection({
  phoneNumber,
}: {
  phoneNumber: string | null;
}) {
  const t = useT();
  const add = t.studioPage.channels.add;
  const normalized = phoneNumber
    ? normalizeWhatsAppPhoneNumberInput(phoneNumber)
    : null;
  if (!normalized) return null;

  const chatUrl = `https://wa.me/${normalized}`;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3">
      <div>
        <h3 className="text-sm font-semibold">{add.whatsappCloudChatTitle}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {add.whatsappCloudChatHint}
        </p>
      </div>
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <a
          href={chatUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={add.whatsappCloudOpenChat}
          className="rounded-xl border border-border bg-white p-3"
        >
          <QRCodeSVG value={chatUrl} size={160} />
        </a>
        <div className="flex min-w-0 flex-col gap-2">
          <code className="break-all rounded bg-muted px-2 py-1.5 text-xs">
            +{normalized}
          </code>
          <a
            href={chatUrl}
            target="_blank"
            rel="noreferrer"
            className="self-start rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            {add.whatsappCloudOpenChat}
          </a>
        </div>
      </div>
    </section>
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
 * Telegram-only cumulative per-chat / per-topic overrides of the
 * `requireMention` default.
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
        <span className="font-medium text-foreground">{effectLabel}</span>.
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
 * "+ Add channel" modal on studio/channels. A base-ui `Dialog` that hosts
 * `AddChannelForm` — the popup owns the title / close affordance and the
 * scroll container so the form body stays chrome-free (and mountable
 * standalone in tests). Closing mid-pairing is allowed: every connect tab
 * tears its own stream / poll down on unmount.
 */
export function AddChannelDialog({
  open,
  onClose,
  ...formProps
}: {
  open: boolean;
  onClose: () => void;
} & Omit<Parameters<typeof AddChannelForm>[0], "onClose">) {
  const t = useT();
  const add = t.studioPage.channels.add;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm transition-opacity duration-150",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          )}
        />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[calc(100vh-3rem)] w-[calc(100vw-2rem)] max-w-2xl flex-col",
            "rounded-2xl border border-border bg-background shadow-xl ring-1 ring-foreground/5 outline-none",
            "transition-all duration-150",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 px-5 pt-5 pb-3">
            <Dialog.Title className="text-sm font-semibold text-foreground">
              {add.title}
            </Dialog.Title>
            <Dialog.Close
              aria-label={add.close}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
            {open && <AddChannelForm {...formProps} onClose={onClose} />}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Workspace-driven channel connect — the body of the "+ Add channel" modal
 * (`AddChannelDialog`) on studio/channels. Validates credentials via the
 * workspace-scoped connect endpoints
 * (`POST /api/workspaces/:id/channels/{slack,telegram}`), optionally seeds
 * default routing to an assistant in this workspace, and shows the Slack
 * webhook URL the user must register manually (Telegram auto-registers).
 * Renders no card chrome or title of its own — the dialog owns those.
 */
export function AddChannelForm({
  workspaceId,
  assistants,
  onCreated,
  onClose,
  emailConfigured = false,
  emailDomains = [],
  onEmailCreated,
}: {
  workspaceId: string;
  assistants: StudioAssistantSummary[];
  onCreated: (channel: Channel) => void | Promise<void>;
  onClose: () => void;
  emailConfigured?: boolean;
  emailDomains?: EmailDomainSummary[];
  onEmailCreated?: () => void | Promise<void>;
}) {
  const t = useT();
  const add = t.studioPage.channels.add;
  const [platform, setPlatform] = useState<
    "slack" | "telegram" | "discord" | "feishu" | "whatsapp" | "email" | "msteams" | "wechat" | "custom"
  >("slack");

  // WhatsApp pairs via QR (no token submit). After the connect stream reports
  // `connected`, the integration row lands shortly after — poll the channel
  // list until the WhatsApp channel appears, then surface it like the others.
  const handleWhatsappConnected = useCallback(async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const chans = await listChannels(workspaceId);
        const wa = chans.find(
          (c) => c.channelType === "whatsapp" && c.integrationProvider !== "cloud_api",
        );
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
    | {
        kind: "telegram";
        botUsername: string;
        pairingCode: string | null;
      }
    | { kind: "discord"; botUsername: string; inviteUrl: string; connectorError: string | null }
    | {
        kind: "feishu";
        botName: string;
        brand: "feishu" | "lark";
        connectorError: string | null;
      }
    | { kind: "email"; address: string }
    | { kind: "msteams"; webhookUrl: string }
    | { kind: "custom"; channelId: string; kindLabel: string | null; bridgeToken: string }
  >(null);
  const [copied, setCopied] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [defaultAssistantId, setDefaultAssistantId] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [tgBotToken, setTgBotToken] = useState("");
  const [dcBotToken, setDcBotToken] = useState("");
  const [feishuBrand, setFeishuBrand] = useState<"feishu" | "lark">("feishu");
  const [feishuAppId, setFeishuAppId] = useState("");
  const [feishuAppSecret, setFeishuAppSecret] = useState("");
  const [msAppId, setMsAppId] = useState("");
  const [msAppPassword, setMsAppPassword] = useState("");
  const [msTenantId, setMsTenantId] = useState("");
  const [emailUsername, setEmailUsername] = useState("");
  const [emailDomainId, setEmailDomainId] = useState<string>("__default__");
  const [customName, setCustomName] = useState("");
  const [customKind, setCustomKind] = useState("");
  const verifiedDomains = useMemo(
    () => emailDomains.filter((d) => d.status === "verified"),
    [emailDomains],
  );

  // Slack app manifest customization (collapsed by default).
  const [manifestOpen, setManifestOpen] = useState(false);
  const [appName, setAppName] = useState("My AI Assistant");
  const [appDescription, setAppDescription] = useState(
    "AI assistant powered by Use Brian",
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
  const requiredAssistantItems = useMemo(
    () => Object.fromEntries(assistants.map((a) => [a.id, a.name])),
    [assistants],
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
        setSuccess({
          kind: "telegram",
          botUsername: result.botUsername,
          pairingCode: result.pairingCode,
        });
        setTgBotToken("");
      } else if (platform === "feishu") {
        const result = await connectFeishuChannel(workspaceId, {
          appId: feishuAppId.trim(),
          appSecret: feishuAppSecret,
          brand: feishuBrand,
          defaultAssistantId: defaultAssistantId || null,
        });
        await onCreated(result.channel);
        setSuccess({
          kind: "feishu",
          botName: result.botName,
          brand: result.brand,
          connectorError: result.connectorError,
        });
        setFeishuAppSecret("");
      } else if (platform === "msteams") {
        const result = await connectMsTeamsChannel(workspaceId, {
          appId: msAppId.trim(),
          appPassword: msAppPassword,
          tenantId: msTenantId.trim(),
          defaultAssistantId: defaultAssistantId || null,
        });
        await onCreated(result.channel);
        setSuccess({
          kind: "msteams",
          webhookUrl: result.webhookUrl ?? result.webhookPath,
        });
        setMsAppId("");
        setMsAppPassword("");
        setMsTenantId("");
      } else if (platform === "custom") {
        const kind = customKind.trim();
        const result = await connectCustomChannel(workspaceId, {
          displayName: customName.trim(),
          kind: kind || null,
          defaultAssistantId: defaultAssistantId || null,
        });
        await onCreated(result.channel);
        setSuccess({
          kind: "custom",
          channelId: result.channel.id,
          kindLabel: kind || null,
          bridgeToken: result.bridgeToken,
        });
        setCustomName("");
        setCustomKind("");
      } else if (platform === "email") {
        const result = await createEmailInbox({
          workspaceId,
          username: emailUsername.trim(),
          domainId: emailDomainId === "__default__" ? null : emailDomainId,
          assistantId: defaultAssistantId,
        });
        // The channel row lands with the POST — pull the list once so the
        // rail + detail panel pick up the fresh inbox like other channels.
        const chans = await listChannels(workspaceId);
        const created = chans.find((c) => c.id === result.channelId);
        if (created) await onCreated(created);
        await onEmailCreated?.();
        setSuccess({ kind: "email", address: result.address });
        setEmailUsername("");
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
        ? tgBotToken.length > 0 &&
          (isHostedEdition() || defaultAssistantId.length > 0)
        : platform === "feishu"
          ? feishuAppId.trim().length > 0 && feishuAppSecret.length > 0
        : platform === "msteams"
          ? msAppId.trim().length > 0 && msAppPassword.length > 0 && msTenantId.trim().length > 0
          : platform === "email"
            ? /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(emailUsername.trim().toLowerCase()) &&
              defaultAssistantId.length > 0
            : platform === "custom"
              ? customName.trim().length > 0
              : dcBotToken.length > 0);

  function pickPlatform(p: "slack" | "telegram" | "discord" | "feishu" | "whatsapp" | "email" | "msteams" | "wechat" | "custom"): void {
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
    if (success?.kind !== "slack" && success?.kind !== "msteams") return;
    void navigator.clipboard.writeText(success.webhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  // Download the ready-to-upload Teams app package: manifest.json (bot id
  // pre-filled) + the brand color/outline icons, zipped client-side.
  async function downloadTeamsPackage(): Promise<void> {
    setError(null);
    try {
      const [colorPng, outlinePng] = await Promise.all(
        ["/icon-192.png", "/teams/outline.png"].map(async (path) => {
          const res = await fetch(path);
          if (!res.ok) throw new Error(`icon fetch failed: ${path}`);
          return new Uint8Array(await res.arrayBuffer());
        }),
      );
      const zip = buildTeamsAppPackage(msAppId, colorPng, outlinePng);
      const blob = new Blob([zip], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "use-brian-teams.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(add.packageError);
    }
  }

  const TAB_BASE =
    "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm transition-colors";
  const FIELD_INPUT =
    "text-sm rounded-md border border-border bg-background px-2 py-1.5 font-mono disabled:opacity-50";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {(
          [
            "slack",
            "telegram",
            "discord",
            "feishu",
            "msteams",
            "whatsapp",
            "wechat",
            "custom",
            ...(emailConfigured ? ["email"] : []),
          ] as Array<"slack" | "telegram" | "discord" | "feishu" | "whatsapp" | "email" | "msteams" | "wechat" | "custom">
        ).map((p) => (
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
            <span className="grid size-5 place-items-center text-muted-foreground">
              <ChannelTypeIcon type={p} />
            </span>
            <span>{add.platform[p]}</span>
          </button>
        ))}
      </div>

      {platform === "whatsapp" ? (
        <WhatsappConnectTab
          workspaceId={workspaceId}
          assistants={assistants}
          onConnected={handleWhatsappConnected}
          onCloudConnected={(channel) => void onCreated(channel)}
        />
      ) : platform === "wechat" ? (
        <WechatConnectTab
          workspaceId={workspaceId}
          defaultAssistantId={defaultAssistantId || null}
          onConnected={(channel) => {
            if (channel) void onCreated(channel);
          }}
        />
      ) : platform === "custom" ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{add.custom.hint}</p>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{add.custom.nameLabel}</span>
            <input
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder={add.custom.namePlaceholder}
              maxLength={200}
              disabled={submitting || !!success}
              className="text-sm rounded-md border border-border bg-background px-2 py-1.5 disabled:opacity-50"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{add.custom.kindLabel}</span>
            <input
              type="text"
              value={customKind}
              onChange={(e) => setCustomKind(e.target.value)}
              placeholder={add.custom.kindPlaceholder}
              maxLength={64}
              disabled={submitting || !!success}
              className={FIELD_INPUT}
            />
            <span className="text-xs text-muted-foreground">{add.custom.kindHint}</span>
          </label>
        </div>
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
      ) : platform === "email" ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{add.emailHint}</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">{add.emailUsernameLabel}</span>
              <input
                type="text"
                value={emailUsername}
                onChange={(e) => setEmailUsername(e.target.value)}
                placeholder="ada"
                disabled={submitting || !!success}
                className={FIELD_INPUT}
              />
            </label>
            <span className="pb-1.5 text-sm text-muted-foreground">@</span>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">{add.emailDomainLabel}</span>
              <Select
                value={emailDomainId}
                onValueChange={(v) => {
                  if (v) setEmailDomainId(v);
                }}
                items={{
                  __default__: "agentmail.to",
                  ...Object.fromEntries(verifiedDomains.map((d) => [d.id, d.domain])),
                }}
                disabled={submitting || !!success}
              >
                <SelectTrigger size="sm" className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">agentmail.to</SelectItem>
                  {verifiedDomains.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.domain}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
        </div>
      ) : platform === "telegram" ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center">
              <span className="scale-150">
                <TelegramGlyph />
              </span>
            </span>
            <div>
              <h3 className="text-sm font-semibold">{add.telegramSetupTitle}</h3>
              <p className="text-xs text-muted-foreground">
                {add.telegramSetupSubtitle}
              </p>
            </div>
          </div>

          <ol className="grid gap-2 sm:grid-cols-3">
            <li className="flex items-center gap-2 rounded-lg border border-border bg-background p-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400">
                <Bot className="size-4" aria-hidden />
              </span>
              <div className="min-w-0">
                <span className="block text-[11px] font-medium text-muted-foreground">
                  {format(add.telegramStep, { number: 1 })}
                </span>
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                >
                  {add.telegramStepCreate}
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              </div>
            </li>
            <li className="flex items-center gap-2 rounded-lg border border-border bg-background p-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400">
                <KeyRound className="size-4" aria-hidden />
              </span>
              <div>
                <span className="block text-[11px] font-medium text-muted-foreground">
                  {format(add.telegramStep, { number: 2 })}
                </span>
                <span className="text-xs font-semibold">
                  {add.telegramStepToken}
                </span>
              </div>
            </li>
            <li className="flex items-center gap-2 rounded-lg border border-border bg-background p-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-4" aria-hidden />
              </span>
              <div>
                <span className="block text-[11px] font-medium text-muted-foreground">
                  {format(add.telegramStep, { number: 3 })}
                </span>
                <span className="text-xs font-semibold">
                  {add.telegramStepAssistant}
                </span>
              </div>
            </li>
          </ol>

          <label className="flex flex-col gap-1">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium">
              <KeyRound className="size-3.5 text-muted-foreground" aria-hidden />
              {add.botTokenLabel}
            </span>
            <input
              type="password"
              value={tgBotToken}
              onChange={(e) => setTgBotToken(e.target.value)}
              placeholder="123456:ABC-..."
              disabled={submitting || !!success}
              className={FIELD_INPUT}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium">
              <Bot className="size-3.5 text-muted-foreground" aria-hidden />
              {add.defaultAssistantLabel}
            </span>
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
          </label>
        </div>
      ) : platform === "feishu" ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{add.feishu.hint}</p>
          <a
            href={
              feishuBrand === "feishu"
                ? "https://open.feishu.cn/app"
                : "https://open.larksuite.com/app"
            }
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 self-start text-xs text-primary hover:underline"
          >
            {add.feishu.portalLink}
            <ExternalLink className="size-3" aria-hidden />
          </a>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{add.feishu.brandLabel}</span>
            <Select
              value={feishuBrand}
              onValueChange={(v) => {
                if (v === "feishu" || v === "lark") setFeishuBrand(v);
              }}
              items={{
                feishu: add.feishu.brandFeishu,
                lark: add.feishu.brandLark,
              }}
              disabled={submitting || !!success}
            >
              <SelectTrigger size="sm" className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="feishu">{add.feishu.brandFeishu}</SelectItem>
                <SelectItem value="lark">{add.feishu.brandLark}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{add.feishu.appIdLabel}</span>
            <input
              type="text"
              value={feishuAppId}
              onChange={(e) => setFeishuAppId(e.target.value)}
              placeholder="cli_..."
              disabled={submitting || !!success}
              className={FIELD_INPUT}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{add.feishu.appSecretLabel}</span>
            <input
              type="password"
              value={feishuAppSecret}
              onChange={(e) => setFeishuAppSecret(e.target.value)}
              placeholder="••••••••••••••••"
              disabled={submitting || !!success}
              className={FIELD_INPUT}
            />
          </label>
        </div>
      ) : platform === "msteams" ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{add.msteamsHint}</p>
          <a
            href="https://portal.azure.com/#create/Microsoft.AzureBot"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary hover:underline self-start"
          >
            {add.msteamsPortalLink}
          </a>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{add.appIdLabel}</span>
            <input
              type="text"
              value={msAppId}
              onChange={(e) => setMsAppId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              disabled={submitting || !!success}
              className={FIELD_INPUT}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{add.appPasswordLabel}</span>
            <input
              type="password"
              value={msAppPassword}
              onChange={(e) => setMsAppPassword(e.target.value)}
              placeholder="••••••••••••••••"
              disabled={submitting || !!success}
              className={FIELD_INPUT}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{add.tenantIdLabel}</span>
            <input
              type="text"
              value={msTenantId}
              onChange={(e) => setMsTenantId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              disabled={submitting || !!success}
              className={FIELD_INPUT}
            />
          </label>
          <button
            type="button"
            onClick={() => void downloadTeamsPackage()}
            className="text-xs text-primary hover:underline self-start"
          >
            {add.downloadPackage}
          </button>
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

      {platform !== "whatsapp" && platform !== "telegram" && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">
            {platform === "email"
              ? add.emailHandlerLabel
              : add.defaultAssistantLabel}
          </span>
          <Select
            value={
              platform === "email"
                ? defaultAssistantId
                : defaultAssistantId || "__none__"
            }
            onValueChange={(v) =>
              setDefaultAssistantId(v && v !== "__none__" ? v : "")
            }
            items={
              platform === "email"
                ? requiredAssistantItems
                : defaultAssistantItems
            }
            disabled={submitting || !!success}
          >
            <SelectTrigger size="sm" className="text-sm">
              <SelectValue
                placeholder={
                  platform === "email"
                    ? add.emailHandlerPlaceholder
                    : undefined
                }
              />
            </SelectTrigger>
            <SelectContent>
              {platform !== "email" && (
                <SelectItem value="__none__">{add.defaultAssistantNone}</SelectItem>
              )}
              {assistants.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {platform === "email"
              ? add.emailHandlerHint
              : add.defaultAssistantHint}
          </span>
        </label>
      )}

      {platform !== "whatsapp" && platform !== "wechat" && !success && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="text-sm font-medium rounded-md bg-action text-action-foreground px-3 py-1.5 disabled:opacity-50"
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
      {success?.kind === "custom" && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 flex flex-col gap-3">
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
            {add.custom.created}
          </p>
          <BridgeTokenReveal
            bridgeToken={success.bridgeToken}
            channelId={success.channelId}
            kind={success.kindLabel}
          />
          <div className="flex items-center gap-2">
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
      {success?.kind === "msteams" && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 flex flex-col gap-2">
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
            {add.connectedMsTeams}
          </p>
          <p className="text-xs text-muted-foreground">{add.msteamsWebhookHint}</p>
          <code className="text-xs bg-muted px-2 py-1.5 rounded font-mono break-all">
            {success.webhookUrl}
          </code>
          <p className="text-xs text-muted-foreground">{add.msteamsUploadHint}</p>
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
              onClick={() => void downloadTeamsPackage()}
              className="text-xs font-medium rounded-md border border-border px-2 py-1 hover:bg-muted"
            >
              {add.downloadPackage}
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
      {success?.kind === "email" && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400 break-all">
            {format(add.connectedEmail, { address: success.address })}
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
      {success?.kind === "telegram" && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <TelegramGlyph />
            <CheckCircle2
              className="size-4 text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
            <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
              {format(add.connectedTelegram, { username: success.botUsername })}
            </p>
          </div>
          {success.pairingCode && (
            <>
              <p className="text-xs text-muted-foreground">
                {add.telegramPairingHint}
              </p>
              <code className="w-fit rounded bg-muted px-3 py-1.5 font-mono text-base font-semibold tracking-[0.2em]">
                {success.pairingCode}
              </code>
            </>
          )}
          <div className="flex items-center gap-2">
            {success.pairingCode && (
              <a
                href={`https://t.me/${encodeURIComponent(success.botUsername)}?start=${encodeURIComponent(success.pairingCode)}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-medium rounded-md bg-action text-action-foreground px-2 py-1"
              >
                {add.telegramPairingOpen}
              </a>
            )}
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
      {success?.kind === "feishu" && (
        <div className="flex flex-col gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
            {format(add.feishu.connected, {
              name: success.botName,
              platform:
                success.brand === "feishu"
                  ? add.feishu.brandFeishu
                  : add.feishu.brandLark,
            })}
          </p>
          {success.connectorError && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {add.feishu.connectorWarning}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {add.feishu.testHint}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
            >
              {add.done}
            </button>
          </div>
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
              className="text-xs font-medium rounded-md bg-action text-action-foreground px-2 py-1"
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
  assistants = [],
  onConnected,
  onCloudConnected,
  initialMode = "cloud",
}: {
  workspaceId: string;
  assistants?: StudioAssistantSummary[];
  onConnected: () => void;
  onCloudConnected?: (channel: Channel) => void;
  initialMode?: "cloud" | "linked";
}) {
  const t = useT();
  const wa = t.studioPage.ingestRules.whatsapp;
  const add = t.studioPage.channels.add;
  const [phase, setPhase] = useState<WaConnectPhase>({ kind: "idle" });
  const [mode, setMode] = useState<"cloud" | "linked">(initialMode);
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [assistantId, setAssistantId] = useState("");
  const [cloudSubmitting, setCloudSubmitting] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudResult, setCloudResult] = useState<{ webhookUrl: string; verifyToken: string } | null>(null);
  const [copiedCloud, setCopiedCloud] = useState(false);
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

  async function connectCloud(): Promise<void> {
    setCloudSubmitting(true);
    setCloudError(null);
    try {
      const result = await connectWhatsAppCloudChannel(workspaceId, {
        accessToken,
        appSecret,
        phoneNumberId: phoneNumberId.trim(),
        wabaId: wabaId.trim(),
        defaultAssistantId: assistantId || null,
      });
      onCloudConnected?.(result.channel);
      setCloudResult({ webhookUrl: result.webhookUrl ?? result.webhookPath, verifyToken: result.verifyToken });
    } catch (e) {
      setCloudError((e as Error).message);
    } finally {
      setCloudSubmitting(false);
    }
  }

  function copyCloudSetup(): void {
    if (!cloudResult) return;
    void navigator.clipboard.writeText(`${cloudResult.webhookUrl}\n${cloudResult.verifyToken}`).then(() => {
      setCopiedCloud(true);
      setTimeout(() => setCopiedCloud(false), 2000);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 rounded-md bg-muted p-1 self-start">
        <button
          type="button"
          onClick={() => setMode("cloud")}
          className={cn("rounded px-2.5 py-1 text-xs", mode === "cloud" ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}
        >
          {add.whatsappCloudMode}
        </button>
        <button
          type="button"
          onClick={() => setMode("linked")}
          className={cn("rounded px-2.5 py-1 text-xs", mode === "linked" ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}
        >
          {add.whatsappLinkedMode}
        </button>
      </div>

      {mode === "cloud" ? (
        cloudResult ? (
          <div className="flex flex-col gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
            <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">{add.connectedWhatsAppCloud}</p>
            <p className="text-xs text-muted-foreground">{add.whatsappCloudWebhookHint}</p>
            <code className="break-all rounded bg-muted px-2 py-1.5 text-xs">{cloudResult.webhookUrl}</code>
            <p className="text-xs text-muted-foreground">{add.whatsappCloudVerifyHint}</p>
            <code className="break-all rounded bg-muted px-2 py-1.5 text-xs">{cloudResult.verifyToken}</code>
            <button type="button" onClick={copyCloudSetup} className="self-start rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
              {copiedCloud ? add.copied : add.whatsappCloudCopySetup}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">{add.whatsappCloudHint}</p>
            <a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer" className="self-start text-xs text-primary hover:underline">
              {add.whatsappCloudPortalLink}
            </a>
            {[
              [add.whatsappAccessTokenLabel, accessToken, setAccessToken, "EAAB...", "password"],
              [add.whatsappAppSecretLabel, appSecret, setAppSecret, "••••••••••••••••", "password"],
              [add.whatsappPhoneNumberIdLabel, phoneNumberId, setPhoneNumberId, "123456789012345", "text"],
              [add.whatsappWabaIdLabel, wabaId, setWabaId, "123456789012345", "text"],
            ].map(([label, value, setter, placeholder, type]) => (
              <label key={label as string} className="flex flex-col gap-1">
                <span className="text-xs font-medium">{label as string}</span>
                <input
                  type={type as string}
                  value={value as string}
                  onChange={(e) => (setter as (v: string) => void)(e.target.value)}
                  placeholder={placeholder as string}
                  disabled={cloudSubmitting}
                  className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm disabled:opacity-50"
                />
              </label>
            ))}
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">{add.defaultAssistantLabel}</span>
              <Select
                value={assistantId || "__none__"}
                onValueChange={(v) => setAssistantId(v && v !== "__none__" ? v : "")}
                items={{ __none__: add.defaultAssistantNone, ...Object.fromEntries(assistants.map((a) => [a.id, a.name])) }}
                disabled={cloudSubmitting}
              >
                <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{add.defaultAssistantNone}</SelectItem>
                  {assistants.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void connectCloud()}
                disabled={cloudSubmitting || !accessToken || appSecret.length < 8 || !/^\d+$/.test(phoneNumberId) || !/^\d+$/.test(wabaId)}
                className="self-start rounded-md bg-action px-3 py-1.5 text-sm font-medium text-action-foreground disabled:opacity-50"
              >
                {cloudSubmitting ? add.connecting : add.connect}
              </button>
              {cloudError && <span className="text-xs text-destructive">{cloudError}</span>}
            </div>
          </div>
        )
      ) : (
        <>
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
            className="rounded-md bg-action px-3 py-1.5 text-sm font-medium text-action-foreground"
          >
            {wa.dialogRetry}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={start}
          className="self-start rounded-md bg-action px-3 py-1.5 text-sm font-medium text-action-foreground"
        >
          {wa.connectAction}
        </button>
      )}
        </>
      )}
    </div>
  );
}

/** WeChat QR pairing phases — inline in the Add-a-channel form. */
/** Copy-to-clipboard button with a 2 s "Copied!" flip. */
function CopyValueButton({
  value,
  label,
  copiedLabel,
}: {
  value: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="shrink-0 text-xs font-medium rounded-md border border-border px-2 py-1 hover:bg-muted"
    >
      {copied ? copiedLabel : label}
    </button>
  );
}

/**
 * One-time reveal of a custom channel's bridge token, plus the two other
 * facts a bridge needs to boot (channel id, API base URL) and the per-kind
 * quickstart. Shared by the add-channel success state and the rotate-token
 * flow — the token is returned once by the API and never shown again, so
 * the copy affordance and the "copy it now" line live here, in one place.
 * docs/architecture/channels/custom-channel.md → "Studio UI".
 */
export function BridgeTokenReveal({
  bridgeToken,
  channelId,
  kind,
  title,
}: {
  bridgeToken: string;
  channelId: string;
  kind: string | null;
  title?: string;
}) {
  const t = useT();
  const c = t.studioPage.channels.add.custom;
  const row =
    "flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5";
  const code = "min-w-0 flex-1 text-xs font-mono break-all";
  const steps =
    kind === "wechat-desktop"
      ? [
          c.kinds.wechatDesktop.step1,
          c.kinds.wechatDesktop.step2,
          c.kinds.wechatDesktop.step3,
          c.kinds.wechatDesktop.step4,
          c.kinds.wechatDesktop.step5,
        ]
      : null;
  return (
    <div className="flex flex-col gap-3">
      {title && <p className="text-sm font-medium">{title}</p>}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">{c.tokenLabel}</span>
        <div className={row}>
          <input
            type="text"
            readOnly
            value={bridgeToken}
            aria-label={c.tokenLabel}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 bg-transparent text-xs font-mono outline-none"
          />
          <CopyValueButton value={bridgeToken} label={c.copyToken} copiedLabel={c.copied} />
        </div>
        <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
          {c.tokenOnce}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">{c.channelIdLabel}</span>
        <div className={row}>
          <code className={code}>{channelId}</code>
          <CopyValueButton value={channelId} label={c.copyChannelId} copiedLabel={c.copied} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">{c.apiUrlLabel}</span>
        <div className={row}>
          <code className={code}>{DISPLAY_API_URL}</code>
          <CopyValueButton value={DISPLAY_API_URL} label={c.copyApiUrl} copiedLabel={c.copied} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {steps ? c.kinds.wechatDesktop.title : c.quickstartTitle}
        </span>
        {steps ? (
          <ol className="flex flex-col gap-0.5 text-xs text-muted-foreground list-decimal pl-4">
            {steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">
            {format(c.genericQuickstart, { path: customChannelBridgePath(channelId) })}
          </p>
        )}
      </div>
    </div>
  );
}

/** Tone of the bridge status chip (mirrors `pillCls`). */
function customStatusTone(status: CustomChannelState["status"]): "on" | "off" | "attention" {
  if (status === "connected") return "on";
  if (status === "needs_action" || status === "error") return "attention";
  return "off";
}

/**
 * Custom bridge state card — what the bridge last published (`PUT /state`)
 * plus the API's liveness view of it. Polls `GET …/custom/state` every 2 s
 * while the detail panel is mounted. The latch is reset on the way IN (React
 * Strict Mode runs effect → cleanup → effect on mount; a cleanup-only latch
 * would leave `stopRef` true and the loop would exit on its first check — the
 * graded `strict-mode-unmount-latch` rule). Renders the action surface: a QR
 * (`imageDataUrl` wins, else `url`/`text` rendered as a QR by the client), an
 * input field that answers through `POST …/custom/input`, or a
 * confirm-on-device note. "Bridge offline" shows whenever `online` is false,
 * whatever status the bridge last published — a stale `connected` is not
 * connected. docs/architecture/channels/custom-channel.md → "Studio UI".
 */
export function CustomBridgeSection({
  workspaceId,
  channel,
}: {
  workspaceId: string;
  channel: Channel;
}) {
  const t = useT();
  const c = t.studioPage.channels.custom;
  const channelId = channel.id;
  const [state, setState] = useState<CustomChannelState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [inputSending, setInputSending] = useState(false);
  const [inputError, setInputError] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState(false);
  const stopRef = useRef(false);

  useEffect(() => {
    // Clear the latch on the way IN — see the component comment.
    stopRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function tick(): Promise<void> {
      if (stopRef.current) return;
      try {
        const next = await getCustomChannelState(workspaceId, channelId);
        if (stopRef.current) return;
        setState(next);
        setLoadError(false);
      } catch {
        if (stopRef.current) return;
        setLoadError(true);
      }
      if (stopRef.current) return;
      timer = setTimeout(() => void tick(), 2000);
    }
    void tick();
    return () => {
      stopRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId, channelId]);

  // A fresh action request should not inherit a half-typed answer to the
  // previous one.
  const requestId = state?.action?.kind === "input" ? state.action.requestId : null;
  useEffect(() => {
    setInputValue("");
    setInputError(false);
  }, [requestId]);

  async function submitInput(): Promise<void> {
    if (!requestId || !inputValue.trim() || inputSending) return;
    setInputSending(true);
    setInputError(false);
    try {
      await submitCustomChannelInput(workspaceId, channelId, {
        requestId,
        value: inputValue.trim(),
      });
      setInputValue("");
    } catch {
      setInputError(true);
    } finally {
      setInputSending(false);
    }
  }

  async function rotate(): Promise<void> {
    const ok = await confirmDialog({
      title: c.rotateConfirmTitle,
      description: c.rotateConfirmBody,
      confirmLabel: c.rotateConfirmCta,
      cancelLabel: c.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setRotating(true);
    setRotateError(false);
    try {
      const result = await rotateCustomChannelToken(workspaceId, channelId);
      setNewToken(result.bridgeToken);
    } catch {
      setRotateError(true);
    } finally {
      setRotating(false);
    }
  }

  async function disconnect(): Promise<void> {
    const ok = await confirmDialog({
      title: c.disconnectConfirmTitle,
      description: c.disconnectConfirmBody,
      confirmLabel: c.disconnectConfirmCta,
      cancelLabel: c.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setDisconnecting(true);
    setDisconnectError(false);
    try {
      await disconnectCustomChannel(workspaceId, channelId);
    } catch {
      setDisconnectError(true);
    } finally {
      setDisconnecting(false);
    }
  }

  const status = state?.status ?? "connecting";
  const online = state?.online ?? false;
  const action = state?.action ?? null;
  const qrValue =
    action?.kind === "qr" && !action.imageDataUrl ? (action.url ?? action.text ?? null) : null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {c.stateTitle}
        </span>
        <span className={pillCls(customStatusTone(status))}>{c.status[status]}</span>
        <span className={pillCls(online ? "on" : "attention")}>
          {online ? c.online : c.offline}
        </span>
        {state?.bridgeVersion && (
          <span
            className="text-[11px] font-mono text-muted-foreground"
            title={c.bridgeVersion}
          >
            {state.bridgeVersion}
          </span>
        )}
      </div>

      {loadError && <p className="text-xs text-destructive">{c.stateError}</p>}

      {state && !state.lastSeenAt && (
        <p className="text-xs text-muted-foreground">{c.neverSeen}</p>
      )}

      {state?.accountLabel && (
        <p className="text-sm">
          <span className="text-muted-foreground">{c.accountLabel}: </span>
          <span className="font-medium">{state.accountLabel}</span>
        </p>
      )}

      {state?.message && <p className="text-sm">{state.message}</p>}

      {action?.kind === "qr" && (
        <div className="flex flex-col items-center gap-2 self-center py-2">
          <div className="rounded-lg bg-white p-3">
            {action.imageDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={action.imageDataUrl}
                alt={c.qrHint}
                width={208}
                height={208}
                className="block h-52 w-52"
              />
            ) : qrValue ? (
              <QRCodeSVG value={qrValue} size={208} />
            ) : null}
          </div>
          {!action.imageDataUrl && !action.url && action.text && (
            <code className="text-xs font-mono break-all">{action.text}</code>
          )}
          {!state?.message && (
            <p className="max-w-xs text-center text-xs text-muted-foreground">{c.qrHint}</p>
          )}
          {action.expiresAt && (
            <p className="text-[11px] text-muted-foreground">
              {format(c.qrExpires, { time: new Date(action.expiresAt).toLocaleTimeString() })}
            </p>
          )}
        </div>
      )}

      {action?.kind === "input" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitInput();
          }}
          className="flex flex-col gap-2"
        >
          <label className="text-sm">{action.prompt}</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode={action.inputKind === "numeric" ? "numeric" : "text"}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={c.inputPlaceholder}
              aria-label={action.prompt}
              disabled={inputSending}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm font-mono"
            />
            <button
              type="submit"
              disabled={!inputValue.trim() || inputSending}
              className="rounded-md bg-action px-3 py-1.5 text-sm font-medium text-action-foreground disabled:opacity-50"
            >
              {inputSending ? c.inputSending : c.inputSubmit}
            </button>
          </div>
          {inputError && <p className="text-xs text-destructive">{c.inputError}</p>}
        </form>
      )}

      {action?.kind === "confirm_on_device" && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
          {action.message}
        </p>
      )}

      {state && state.outboxDepth > 0 && (
        <p className="text-xs text-muted-foreground">
          {format(c.outboxDepth, { n: state.outboxDepth })}
        </p>
      )}

      {state?.lastSeenAt && (
        <p className="text-[11px] text-muted-foreground">
          {c.lastSeen}: {new Date(state.lastSeenAt).toLocaleString()}
        </p>
      )}

      {newToken && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 flex flex-col gap-2">
          <BridgeTokenReveal
            bridgeToken={newToken}
            channelId={channelId}
            kind={null}
            title={c.newTokenTitle}
          />
          <button
            type="button"
            onClick={() => setNewToken(null)}
            className="self-start text-xs font-medium rounded-md border border-border px-2 py-1 hover:bg-muted"
          >
            {c.dismiss}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
        <button
          type="button"
          onClick={() => void rotate()}
          disabled={rotating}
          className="text-xs font-medium rounded-md border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
        >
          {c.rotateToken}
        </button>
        <button
          type="button"
          onClick={() => void disconnect()}
          disabled={disconnecting || status === "disconnected"}
          className="text-xs font-medium rounded-md border border-border px-2 py-1 text-destructive/80 hover:bg-muted hover:text-destructive disabled:opacity-50"
        >
          {c.disconnect}
        </button>
        {rotateError && <span className="text-xs text-destructive">{c.rotateError}</span>}
        {disconnectError && (
          <span className="text-xs text-destructive">{c.disconnectError}</span>
        )}
      </div>
    </div>
  );
}

type WechatConnectPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "qr"; url: string }
  | { kind: "scanned" }
  | { kind: "verify"; rejected: boolean }
  | { kind: "connected"; connectorError: string | null }
  | { kind: "already_bound" }
  | { kind: "expired" }
  | { kind: "error"; message: string };

/**
 * WeChat connect tab — BYON iLink bot binding by QR. Poll-based (not SSE like
 * WhatsApp) because iLink's login machine has a mid-flow input state: it can
 * demand a pairing code (`need_verifycode`) that the user reads off their
 * phone and types here. The QR may also refresh in place when a code expires.
 * On `connected` the API already persisted the channel + started the
 * long-poll, and returns the channel row for the rail. The iLink limits are
 * stated inline — this connects a NEW bot contact, not the user's own WeChat.
 */
function WechatConnectTab({
  workspaceId,
  defaultAssistantId,
  onConnected,
}: {
  workspaceId: string;
  defaultAssistantId: string | null;
  onConnected: (channel: Channel | null) => void;
}) {
  const t = useT();
  const wc = t.studioPage.channels.add.wechat;
  const limits = t.studioPage.channels.wechat;
  const [phase, setPhase] = useState<WechatConnectPhase>({ kind: "idle" });
  const [verifyCode, setVerifyCode] = useState("");
  const pairingIdRef = useRef<string | null>(null);
  const stopRef = useRef(false);

  const poll = useCallback(
    async (pairingId: string) => {
      while (!stopRef.current && pairingIdRef.current === pairingId) {
        try {
          const status = await getWechatPairingStatus(workspaceId, pairingId);
          if (stopRef.current || pairingIdRef.current !== pairingId) return;
          if (status.status === "connected") {
            setPhase({ kind: "connected", connectorError: status.connectorError ?? null });
            onConnected(status.channel ?? null);
            return;
          }
          if (status.status === "qr" && status.qrcodeUrl) {
            setPhase({ kind: "qr", url: status.qrcodeUrl });
          } else if (status.status === "scanned") {
            setPhase({ kind: "scanned" });
          } else if (status.status === "need_verifycode") {
            setPhase({ kind: "verify", rejected: false });
          } else if (status.status === "verify_code_rejected") {
            setPhase({ kind: "verify", rejected: true });
          } else if (status.status === "already_bound") {
            setPhase({ kind: "already_bound" });
            return;
          } else if (status.status === "expired") {
            setPhase({ kind: "expired" });
            return;
          } else if (status.status === "error") {
            setPhase({ kind: "error", message: status.error ?? "" });
            return;
          }
        } catch (e) {
          if (stopRef.current || pairingIdRef.current !== pairingId) return;
          setPhase({ kind: "error", message: (e as Error).message });
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    },
    [workspaceId, onConnected],
  );

  const start = useCallback(() => {
    setPhase({ kind: "loading" });
    setVerifyCode("");
    void startWechatPairing(workspaceId, { defaultAssistantId })
      .then((started) => {
        pairingIdRef.current = started.pairingId;
        setPhase({ kind: "qr", url: started.qrcodeUrl });
        void poll(started.pairingId);
      })
      .catch((e: unknown) => {
        setPhase({ kind: "error", message: (e as Error).message });
      });
  }, [workspaceId, defaultAssistantId, poll]);

  const submitCode = useCallback(() => {
    const pairingId = pairingIdRef.current;
    const code = verifyCode.trim();
    if (!pairingId || !code) return;
    setPhase({ kind: "scanned" });
    setVerifyCode("");
    void submitWechatVerifyCode(workspaceId, pairingId, code).catch((e: unknown) => {
      setPhase({ kind: "error", message: (e as Error).message });
    });
  }, [workspaceId, verifyCode]);

  useEffect(
    () => () => {
      stopRef.current = true;
    },
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{wc.hint}</p>
      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground list-disc pl-4">
        <li>{limits.limitContact}</li>
        <li>{limits.limitDmsOnly}</li>
        <li>{limits.limitNoHistory}</li>
        <li>{limits.limitSingleConnection}</li>
      </ul>

      {phase.kind === "qr" ? (
        <div className="flex flex-col items-center gap-2 self-center py-2">
          <div className="rounded-lg bg-white p-3">
            <QRCodeSVG value={phase.url} size={208} />
          </div>
          <p className="max-w-xs text-center text-xs text-muted-foreground">
            {wc.scanHint}
          </p>
        </div>
      ) : phase.kind === "loading" ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{wc.loading}</p>
      ) : phase.kind === "scanned" ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{wc.verifying}</p>
      ) : phase.kind === "verify" ? (
        <div className="flex flex-col gap-2 self-center py-2">
          <p className="max-w-xs text-center text-sm">
            {phase.rejected ? wc.verifyRejected : wc.verifyPrompt}
          </p>
          <div className="flex items-center gap-2 self-center">
            <input
              type="text"
              inputMode="numeric"
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCode();
              }}
              maxLength={8}
              className="w-28 text-center text-sm rounded-md border border-border bg-background px-2 py-1.5 font-mono tracking-widest"
            />
            <button
              type="button"
              onClick={submitCode}
              disabled={!verifyCode.trim()}
              className="rounded-md bg-action px-3 py-1.5 text-sm font-medium text-action-foreground disabled:opacity-50"
            >
              {wc.verifySubmit}
            </button>
          </div>
        </div>
      ) : phase.kind === "connected" ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
            {wc.connected}
          </p>
          {phase.connectorError && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {wc.connectorWarning}
            </p>
          )}
        </div>
      ) : phase.kind === "already_bound" ? (
        <p className="text-sm text-muted-foreground">{wc.alreadyBound}</p>
      ) : phase.kind === "expired" || phase.kind === "error" ? (
        <div className="flex items-center gap-3">
          <span className="text-xs text-destructive">
            {phase.kind === "expired" ? wc.expired : wc.error}
          </span>
          <button
            type="button"
            onClick={start}
            className="rounded-md bg-action px-3 py-1.5 text-sm font-medium text-action-foreground"
          >
            {wc.retry}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={start}
          className="self-start rounded-md bg-action px-3 py-1.5 text-sm font-medium text-action-foreground"
        >
          {wc.startAction}
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
      {(mode === "allowlist" || mode === "group_members") && (
        <p className="text-xs text-muted-foreground">{acc.lidNote}</p>
      )}
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
    <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3">
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
                className="rounded-md bg-action px-2.5 py-1 text-xs font-medium text-action-foreground disabled:opacity-50"
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
// Official shared-bot surface (hosted-only), rendered as the detail panel of
// the rail's "official" pseudo-row. The number is paired centrally; a
// workspace doesn't pair it - users add the number to a group (which binds that
// group to the adder's workspace) and manage their bound groups here. Backend:
// packages/api-platform/src/routes/whatsapp-official-admin.ts.
// [COMP:app-web/whatsapp-official-card]
function WhatsappOfficialDetail({ workspaceId }: { workspaceId: string }) {
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
    <div className="space-y-4">
      {/* Header — brand mark, title, the shared number as the identity line. */}
      <div className="flex items-start gap-3">
        <div
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted"
        >
          <ConnectorIcon connectorId="whatsapp" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold tracking-tight">
            {c.title}
          </h2>
          <p className="truncate text-[12px] text-muted-foreground">
            {state?.officialNumber ?? c.numberUnconfigured}
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
        {c.intro}
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3">
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
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {c.groupsTitle}
        </span>
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
    </div>
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
      <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {wa.disconnectedNote}
        </p>
        <WhatsappConnectTab workspaceId={workspaceId} onConnected={refresh} initialMode="linked" />
      </div>
    );
  }

  return <WhatsappRepliesSection workspaceId={workspaceId} />;
}

/**
 * Assistant inbox management — the email channel's detail section: the
 * address, incoming access mode, exact sender routing, and mailbox authority.
 * Non-members always use the isolated external-guest lane, even when the
 * operator opens the inbox to anyone.
 */
const AGENTMAIL_SEND_ACTION = "agentmailSendMessage";
const AGENTMAIL_DRAFT_ACTION = "agentmailCreateDraft";

type AssistantConnectorGrant = {
  connectorId: string;
  allowedActions: string[];
};

export function EmailInboxSection({
  workspaceId,
  channel,
  inbox,
  assistants,
  onChannelUpdated,
  onChanged,
}: {
  workspaceId: string;
  channel: Channel;
  inbox: EmailInbox | null;
  assistants: StudioAssistantSummary[];
  onChannelUpdated?: (channel: Channel) => void;
  onChanged?: () => void | Promise<void>;
}) {
  const t = useT();
  const em = t.studioPage.channels.email;
  const address = inbox?.address ?? channel.displayName;
  const allowlist = useMemo(() => inbox?.allowlist ?? [], [inbox]);
  const senderRoutes = useMemo(() => inbox?.senderRoutes ?? [], [inbox]);
  const [newContact, setNewContact] = useState("");
  const [saving, setSaving] = useState(false);
  const [accessSaving, setAccessSaving] = useState(false);
  const [handlerSaving, setHandlerSaving] = useState(false);
  const [ingestSaving, setIngestSaving] = useState(false);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [grantsSaving, setGrantsSaving] = useState(false);
  const [selectedHandlerId, setSelectedHandlerId] = useState(
    inbox?.assistantId ?? "",
  );
  const [selectedAccessMode, setSelectedAccessMode] = useState<
    "allowlist" | "allow_all"
  >(inbox?.accessMode ?? "allowlist");
  const [allowedActions, setAllowedActions] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const governanceId = inbox?.connectorInstanceId
    ? `agentmail:${inbox.connectorInstanceId}`
    : null;
  const assistantItems = useMemo(
    () => Object.fromEntries(assistants.map((assistant) => [assistant.id, assistant.name])),
    [assistants],
  );
  const senderRoutingItems = useMemo(
    () => ({ __default__: em.defaultHandlerOption, ...assistantItems }),
    [assistantItems, em.defaultHandlerOption],
  );

  useEffect(() => {
    setSelectedHandlerId(inbox?.assistantId ?? "");
  }, [inbox?.assistantId]);

  useEffect(() => {
    setSelectedAccessMode(inbox?.accessMode ?? "allowlist");
  }, [inbox?.accessMode]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedHandlerId || !governanceId) {
      setAllowedActions(new Set());
      setGrantsLoading(false);
      return;
    }
    setGrantsLoading(true);
    authFetch(
      `${API_URL}/api/assistant-connector-grants/${encodeURIComponent(selectedHandlerId)}`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(em.saveError);
        return (await res.json()) as { grants?: AssistantConnectorGrant[] };
      })
      .then((data) => {
        if (cancelled) return;
        const exact = data.grants?.find(
          (grant) => grant.connectorId === governanceId,
        );
        setAllowedActions(new Set(exact?.allowedActions ?? []));
      })
      .catch(() => {
        if (!cancelled) setAllowedActions(new Set());
      })
      .finally(() => {
        if (!cancelled) setGrantsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedHandlerId, governanceId, em.saveError]);

  function copyAddress(): void {
    void navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function saveAllowlist(next: string[]): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await updateEmailInbox({ workspaceId, channelId: channel.id, allowlist: next });
      await onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function saveAccessMode(next: "allowlist" | "allow_all"): Promise<void> {
    const previous = selectedAccessMode;
    setSelectedAccessMode(next);
    setAccessSaving(true);
    setError(null);
    try {
      await updateEmailInbox({ workspaceId, channelId: channel.id, accessMode: next });
      await onChanged?.();
    } catch {
      setSelectedAccessMode(previous);
      setError(em.saveError);
    } finally {
      setAccessSaving(false);
    }
  }

  async function saveSenderRoute(email: string, assistantId: string | null): Promise<void> {
    const next = senderRoutes.filter((route) => route.email !== email);
    if (assistantId) next.push({ email, assistantId });
    setSaving(true);
    setError(null);
    try {
      await updateEmailInbox({ workspaceId, channelId: channel.id, senderRoutes: next });
      await onChanged?.();
    } catch {
      setError(em.saveError);
    } finally {
      setSaving(false);
    }
  }

  async function removeContact(email: string): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await updateEmailInbox({
        workspaceId,
        channelId: channel.id,
        allowlist: allowlist.filter((entry) => entry !== email),
        senderRoutes: senderRoutes.filter((route) => route.email !== email),
      });
      await onChanged?.();
    } catch {
      setError(em.saveError);
    } finally {
      setSaving(false);
    }
  }

  async function saveHandler(nextAssistantId: string): Promise<void> {
    if (!nextAssistantId || nextAssistantId === selectedHandlerId) return;
    const previous = selectedHandlerId;
    setSelectedHandlerId(nextAssistantId);
    setHandlerSaving(true);
    setError(null);
    try {
      await updateEmailInbox({
        workspaceId,
        channelId: channel.id,
        assistantId: nextAssistantId,
      });
      await onChanged?.();
    } catch {
      setSelectedHandlerId(previous);
      setError(em.saveError);
    } finally {
      setHandlerSaving(false);
    }
  }

  async function saveIngest(next: boolean): Promise<void> {
    setIngestSaving(true);
    setError(null);
    try {
      const updated = await updateChannel(workspaceId, channel.id, {
        enabledCapabilities: next
          ? [...new Set([...channel.enabledCapabilities, "ingest" as const])]
          : channel.enabledCapabilities.filter((capability) => capability !== "ingest"),
      });
      onChannelUpdated?.(updated);
    } catch {
      setError(em.saveError);
    } finally {
      setIngestSaving(false);
    }
  }

  async function toggleAction(action: string): Promise<void> {
    if (!selectedHandlerId || !governanceId) return;
    const previous = allowedActions;
    const next = new Set(previous);
    if (next.has(action)) next.delete(action);
    else next.add(action);
    setAllowedActions(next);
    setGrantsSaving(true);
    setError(null);
    try {
      const res = await authFetch(
        `${API_URL}/api/assistant-connector-grants/${encodeURIComponent(selectedHandlerId)}/${encodeURIComponent(governanceId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            readAllowed: true,
            allowedActions: Array.from(next),
          }),
        },
      );
      if (!res.ok) throw new Error(em.saveError);
    } catch {
      setAllowedActions(previous);
      setError(em.saveError);
    } finally {
      setGrantsSaving(false);
    }
  }

  async function addContact(): Promise<void> {
    const entry = newContact.trim().toLowerCase();
    if (!entry) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry)) {
      setError(em.invalidAddress);
      return;
    }
    setNewContact("");
    await saveAllowlist([...new Set([...allowlist, entry])]);
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        {em.title}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <code className="text-sm bg-muted px-2 py-1 rounded font-mono break-all">
          {address}
        </code>
        <button
          type="button"
          onClick={copyAddress}
          className="text-xs font-medium rounded-md border border-border px-2 py-1 hover:bg-muted"
        >
          {copied ? em.copied : em.copyAddress}
        </button>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        <span className="text-xs font-medium">{em.handledByLabel}</span>
        <Select
          value={selectedHandlerId}
          items={assistantItems}
          disabled={handlerSaving || assistants.length === 0}
          onValueChange={(value) => {
            if (value) void saveHandler(value);
          }}
        >
          <SelectTrigger size="sm" className="w-fit min-w-48 text-sm">
            <SelectValue placeholder={em.handledByPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {assistants.map((assistant) => (
              <SelectItem key={assistant.id} value={assistant.id}>
                {assistant.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{em.handledByHint}</p>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        <span className="text-xs font-medium">{em.accessModeLabel}</span>
        <Select
          value={selectedAccessMode}
          items={{
            allowlist: em.accessModeApprovedOnly,
            allow_all: em.accessModeAnyone,
          }}
          disabled={accessSaving}
          onValueChange={(value) => {
            if (value === "allowlist" || value === "allow_all") {
              void saveAccessMode(value);
            }
          }}
        >
          <SelectTrigger size="sm" className="w-fit min-w-56 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="allowlist">{em.accessModeApprovedOnly}</SelectItem>
            <SelectItem value="allow_all">{em.accessModeAnyone}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {selectedAccessMode === "allow_all"
            ? em.accessModeAnyoneHint
            : em.accessModeApprovedHint}
        </p>
      </div>

      <label className="flex items-start gap-2 border-t border-border pt-3 text-sm">
        <input
          type="checkbox"
          checked={channel.enabledCapabilities.includes("ingest")}
          disabled={ingestSaving}
          onChange={(event) => void saveIngest(event.target.checked)}
          className="mt-0.5"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-xs font-medium">{em.brainIngestLabel}</span>
          <span className="text-xs text-muted-foreground">{em.brainIngestHint}</span>
        </span>
      </label>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div>
          <div className="text-xs font-medium">{em.outboundActionsLabel}</div>
          <p className="text-xs text-muted-foreground">{em.outboundActionsHint}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allowedActions.has(AGENTMAIL_SEND_ACTION)}
            disabled={grantsLoading || grantsSaving || !governanceId || !selectedHandlerId}
            onChange={() => void toggleAction(AGENTMAIL_SEND_ACTION)}
          />
          <span>{em.sendEmailAction}</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allowedActions.has(AGENTMAIL_DRAFT_ACTION)}
            disabled={grantsLoading || grantsSaving || !governanceId || !selectedHandlerId}
            onChange={() => void toggleAction(AGENTMAIL_DRAFT_ACTION)}
          />
          <span>{em.createDraftAction}</span>
        </label>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        <span className="text-xs font-medium">{em.senderRoutingLabel}</span>
        <p className="text-xs text-muted-foreground">
          {selectedAccessMode === "allow_all"
            ? em.senderRoutingAnyoneHint
            : em.senderRoutingApprovedHint}
        </p>
        {allowlist.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {allowlist.map((entry) => {
              const route = senderRoutes.find((candidate) => candidate.email === entry);
              return (
                <li
                  key={entry}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5"
                >
                  <span className="min-w-52 flex-1 break-all font-mono text-xs">{entry}</span>
                  <Select
                    value={route?.assistantId ?? "__default__"}
                    items={senderRoutingItems}
                    disabled={saving}
                    onValueChange={(value) => {
                      if (value) {
                        void saveSenderRoute(
                          entry,
                          value === "__default__" ? null : value,
                        );
                      }
                    }}
                  >
                    <SelectTrigger size="sm" className="w-fit min-w-48 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">{em.defaultHandlerOption}</SelectItem>
                      {assistants.map((assistant) => (
                        <SelectItem key={assistant.id} value={assistant.id}>
                          {assistant.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    aria-label={em.removeContact}
                    disabled={saving}
                    onClick={() => void removeContact(entry)}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newContact}
            onChange={(e) => setNewContact(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addContact();
            }}
            placeholder={em.contactPlaceholder}
            disabled={saving}
            className="text-sm rounded-md border border-border bg-background px-2 py-1.5 font-mono disabled:opacity-50 min-w-[220px]"
          />
          <button
            type="button"
            onClick={() => void addContact()}
            disabled={saving || newContact.trim().length === 0}
            className="text-xs font-medium rounded-md border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
          >
            {saving ? em.saving : em.addContact}
          </button>
        </div>
      </div>

      <div className="rounded-md bg-muted/50 px-3 py-2">
        <div className="text-xs font-medium">{em.guestSafetyLabel}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{em.guestSafetyHint}</p>
      </div>

      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
