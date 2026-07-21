/**
 * SDK for the Studio → Channels surface (app-web).
 *
 * Ported from `apps/web/src/lib/api/channels.ts` as part of the app
 * consolidation (docs/architecture/features/doc.md §9 #5, CHUNK 4).
 * Identical wire contract — workspace-owned channels (the workspace-channels
 * model): list a workspace's channels, edit clearance / capabilities / status,
 * and wire per-surface assistant routing. Backed by the
 * `/api/workspaces/:workspaceId/channels` routes. See
 * docs/architecture/channels/adapter-pattern.md.
 *
 * Kept as its own file (not imported from apps/web), same convention as
 * `lib/api/views.ts` / `lib/api/studio.ts`.
 *
 * [COMP:app-web/channels-sdk]
 */

import { authFetch } from "@/lib/auth-fetch";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type ChannelType = "telegram" | "slack" | "whatsapp" | "discord" | "email" | "msteams";
export type ChannelClearance = "public" | "internal" | "confidential";
export type ChannelCapability = "chat" | "broadcast" | "ingest";
type ChannelStatus = "active" | "revoked" | "invalid";
export type ChannelModelAlias = "standard" | "pro" | "max";
export type UserAccessMode =
  | "allow_all"
  | "allowlist"
  | "blocklist"
  | "group_members";

/** A Telegram chat the bot has seen — feeds the per-chat override picker. */
export type SeenChat = {
  chatId: string;
  chatTitle: string | null;
  isForum: boolean;
  topics: { topicId: number; name: string | null; lastSeenAt: string }[];
  lastSeenAt: string;
};

/** A per-chat / per-topic flip of the `requireMention` default (Telegram). */
export type RequireMentionOverride = { chatId: string; topicId?: number | null };

/**
 * Per-integration behavior config — the `channel_integrations.config` JSONB.
 * Mirrors `ChannelIntegrationConfig` in packages/api. Not every field applies
 * to every channel: `replyInThread` is Slack-only, `requireMentionOverrides` /
 * `seenChats` are Telegram-only.
 */
export type ChannelIntegrationConfig = {
  replyInThread?: boolean;
  ackReaction?: string;
  requireMention?: boolean;
  requireMentionOverrides?: RequireMentionOverride[];
  /** Webhook-populated, read-only — never sent in a config PATCH. */
  seenChats?: SeenChat[];
  userAccessMode?: UserAccessMode;
  allowedUserIds?: string[];
  blockedUserIds?: string[];
};

/** The fields a config PATCH may set — `seenChats` is webhook-owned. */
export type ChannelConfigPatch = Partial<Omit<ChannelIntegrationConfig, "seenChats">>;

export type Channel = {
  id: string;
  workspaceId: string;
  channelType: ChannelType;
  clearance: ChannelClearance;
  enabledCapabilities: ChannelCapability[];
  status: ChannelStatus;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  /** The channel's `channel_integrations` row id — null when it has none. */
  integrationId: string | null;
  /** Per-integration behavior config — null when the channel has no integration. */
  config: ChannelIntegrationConfig | null;
};

export type ChannelAssistant = {
  id: string;
  channelId: string;
  assistantId: string;
  /** Slack channel / Telegram chat / WhatsApp chat ID. null = channel default. */
  externalSurfaceId: string | null;
  /**
   * Per-routing model tier (migration 197). The webhook routes use this
   * when picking the LLM for replies on the matched routing row. Defaults
   * to 'standard' for fresh rows; seeded from the connecting assistant's
   * `*_model_alias` on first attach.
   */
  modelAlias: ChannelModelAlias;
  createdAt: string;
};

export async function listChannels(workspaceId: string): Promise<Channel[]> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/channels`,
  );
  if (!res.ok) throw new Error(`Failed to load channels (${res.status})`);
  const data = (await res.json()) as { channels?: Channel[] };
  return Array.isArray(data.channels) ? data.channels : [];
}

export async function updateChannel(
  workspaceId: string,
  channelId: string,
  patch: Partial<
    Pick<Channel, "clearance" | "enabledCapabilities" | "status" | "displayName">
  >,
): Promise<Channel> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    // Forward the route's `error` slug (e.g. `clearance_exceeds_member_tier`)
    // so callers can branch on it. Fall back to a status-based message when
    // the body isn't JSON.
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new Error(body.error ?? `Update failed (${res.status})`);
  }
  const data = (await res.json()) as { channel: Channel };
  return data.channel;
}

/**
 * Update a channel's per-integration behavior config (require-@mention,
 * allow/blocklist, ack reaction, …). Send only the fields being changed —
 * the server merges them into the stored config. Returns the channel with
 * its refreshed `config`.
 */
export async function updateChannelConfig(
  workspaceId: string,
  channelId: string,
  patch: ChannelConfigPatch,
): Promise<Channel> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/config`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`Config update failed (${res.status})`);
  const data = (await res.json()) as { channel: Channel };
  return data.channel;
}

/**
 * Disconnect (delete) a channel. Cascades to its `channel_integrations` row
 * and `channel_assistants` routing on the server.
 */
export async function deleteChannel(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`Delete failed (${res.status})`);
}

// ── Workspace-driven channel connect ────────────────────────────

export type ConnectSlackInput = {
  botToken: string;
  signingSecret: string;
  /** Optional — also create a default `channel_assistants` routing row. */
  defaultAssistantId?: string | null;
  displayName?: string;
};

export type ConnectSlackResult = {
  channel: Channel;
  /** True if the connect refreshed credentials on an existing channel. */
  reused: boolean;
  /** Path the user must register in their Slack app's Event Subscriptions. */
  webhookPath: string;
  /** Full URL with hostname when the server knows its public URL. */
  webhookUrl: string | null;
};

/** Create or refresh a Slack channel for a workspace. */
export async function connectSlackChannel(
  workspaceId: string,
  input: ConnectSlackInput,
): Promise<ConnectSlackResult> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/channels/slack`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new Error(
      data.detail ?? data.error ?? `Slack connect failed (${res.status})`,
    );
  }
  return (await res.json()) as ConnectSlackResult;
}

export type ConnectTelegramInput = {
  botToken: string;
  defaultAssistantId?: string | null;
  displayName?: string;
};

export type ConnectTelegramResult = {
  channel: Channel;
  reused: boolean;
  botUsername: string;
};

/** Create or refresh a Telegram channel for a workspace. Auto-registers the webhook. */
export async function connectTelegramChannel(
  workspaceId: string,
  input: ConnectTelegramInput,
): Promise<ConnectTelegramResult> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/channels/telegram`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new Error(
      data.detail ?? data.error ?? `Telegram connect failed (${res.status})`,
    );
  }
  return (await res.json()) as ConnectTelegramResult;
}

export type ConnectDiscordInput = {
  botToken: string;
  defaultAssistantId?: string | null;
  displayName?: string;
};
export type ConnectDiscordResult = {
  channel: Channel;
  reused: boolean;
  botUsername: string;
  /** Bot user id == Discord Application id — used to build the server-invite URL. */
  botId: string;
  /**
   * Non-null when the integration was saved but the Gateway connector couldn't
   * open the socket (e.g. connector down). The connector's restoreAll retries
   * on its next boot; the UI surfaces this as a soft warning, not a failure.
   */
  connectorError: string | null;
};

/**
 * Create or refresh a Discord channel for a workspace. Validates the bot token,
 * stores it encrypted, and asks the Gateway connector to open the bot's socket.
 * Receiving is over the connector; sending is API -> Discord REST.
 */
export async function connectDiscordChannel(
  workspaceId: string,
  input: ConnectDiscordInput,
): Promise<ConnectDiscordResult> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/channels/discord`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new Error(
      data.detail ?? data.error ?? `Discord connect failed (${res.status})`,
    );
  }
  return (await res.json()) as ConnectDiscordResult;
}

export type ConnectMsTeamsInput = {
  appId: string;
  appPassword: string;
  tenantId: string;
  defaultAssistantId?: string | null;
  displayName?: string;
};
export type ConnectMsTeamsResult = {
  channel: Channel;
  reused: boolean;
  /** Messaging-endpoint path the operator pastes into their Azure Bot. */
  webhookPath: string;
  webhookUrl: string | null;
};

/**
 * Create or refresh a Microsoft Teams channel for a workspace. Validates the
 * Azure Bot credentials by minting a Bot Connector token, stores them
 * encrypted, and returns the messaging-endpoint URL to register on the bot.
 */
export async function connectMsTeamsChannel(
  workspaceId: string,
  input: ConnectMsTeamsInput,
): Promise<ConnectMsTeamsResult> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/channels/msteams`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new Error(
      data.detail ?? data.error ?? `Teams connect failed (${res.status})`,
    );
  }
  return (await res.json()) as ConnectMsTeamsResult;
}

export async function listChannelAssistants(
  workspaceId: string,
  channelId: string,
): Promise<ChannelAssistant[]> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/assistants`,
  );
  if (!res.ok) throw new Error(`Failed to load routing (${res.status})`);
  const data = (await res.json()) as { assistants?: ChannelAssistant[] };
  return Array.isArray(data.assistants) ? data.assistants : [];
}

export async function attachChannelAssistant(
  workspaceId: string,
  channelId: string,
  assistantId: string,
  externalSurfaceId: string | null,
  modelAlias?: ChannelModelAlias,
): Promise<ChannelAssistant> {
  const body: Record<string, unknown> = { assistantId, externalSurfaceId };
  if (modelAlias) body.modelAlias = modelAlias;
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/assistants`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new Error(err.detail ?? err.error ?? `Attach failed (${res.status})`);
  }
  const data = (await res.json()) as { assistant: ChannelAssistant };
  return data.assistant;
}

/**
 * Patch a routing row's per-routing model alias. Today this is the only
 * mutable field on `channel_assistants` (assistant + surface assignments
 * are immutable — callers detach+attach to change them).
 */
export async function updateChannelAssistant(
  workspaceId: string,
  channelId: string,
  channelAssistantId: string,
  patch: { modelAlias?: ChannelModelAlias },
): Promise<ChannelAssistant> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/assistants/${encodeURIComponent(channelAssistantId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new Error(err.detail ?? err.error ?? `Update failed (${res.status})`);
  }
  const data = (await res.json()) as { assistant: ChannelAssistant };
  return data.assistant;
}

export async function detachChannelAssistant(
  workspaceId: string,
  channelId: string,
  channelAssistantId: string,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/assistants/${encodeURIComponent(channelAssistantId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`Detach failed (${res.status})`);
}
