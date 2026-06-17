# @sidanclaw/channels

Channel adapters. One file group per platform; shared utilities at the root. **Read this first when entering this package.** Project-wide rules in the root `CLAUDE.md`.

## Layout

```
packages/channels/src/
├── types.ts                 # ChannelAdapter interface
├── chunking.ts              # Format-aware text splitter (paragraph → sentence → hard)
├── dedup.ts                 # Bounded ring buffer for webhook dedup (~1000 entries)
├── telegram/                # adapter.ts, api.ts, webhook.ts, markdown.ts, index.ts
├── slack/                   # adapter.ts, api.ts, verify.ts, index.ts
├── whatsapp/                # adapter.ts, formatter.ts, index.ts
├── discord/                 # adapter.ts, api.ts, markdown.ts, verify.ts, validate.ts, index.ts
└── __tests__/telegram.test.ts
```

## Architecture doc

`docs/architecture/channels/adapter-pattern.md` for the design rationale. Component-map tags: `[COMP:channels/telegram]`, `[COMP:channels/slack]`, `[COMP:channels/chunking]`, `[COMP:channels/dedup]`.

## The `ChannelAdapter` interface

```typescript
type ChannelAdapter = {
  type: string
  maxMessageLength: number
  supportsMarkdown: boolean
  supportsMessageEdit: boolean
  drainDelayMs: number              // 0 for web, ~2000 for messaging — idle drain batching

  parseIncoming(webhookPayload: unknown): IncomingMessage | null
  deduplicateId(webhookPayload: unknown): string | null

  sendMessage(channelId: string, response: OutgoingMessage): Promise<string>
  editMessage(channelId: string, messageId: string, response: OutgoingMessage): Promise<void>
  sendTypingIndicator(channelId: string): Promise<void>
  sendStatus(channelId: string, status: string): Promise<string>
}
```

Edit-in-place is the key UX trick: send a status message ("ooh let me check..."), then `editMessage` it into the full response. One notification per turn instead of two.

## Telegram specifics

- **Media group buffering** — same `media_group_id` within 500ms is merged into one logical message.
- **Text fragment reassembly** — consecutive message IDs with <1.5s gap are merged into one logical message (catches the user typing in three short bursts).
- **Group chat detection** — only respond when `@<bot_username>` is in the entities. Check `isBotMentioned()` in `adapter.ts`.
- **Webhook verification** — `verifyTelegramWebhook(secret, header)` does a constant-time string compare against `TELEGRAM_WEBHOOK_SECRET`. Mounted before any route logic.
- **Outbound formatting uses HTML parse_mode.** The LLM emits GitHub-flavored markdown (headers, bullets, tables) which neither MarkdownV2 nor plain Markdown can render; we convert once via `markdownToTelegramHTML()` in `telegram/markdown.ts` and send with `parse_mode: 'HTML'`. HTML is strictly more permissive than MarkdownV2 — only `<`, `>`, `&` need escaping and inline tags nest freely (`<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`, `<tg-spoiler>`). `stripMarkdown()` is the last-ditch fallback when Telegram rejects the HTML (unclosed tag, unsafe link scheme) and normalises the same constructs so the user never sees raw `###` / `*   `.

## Slack specifics

- **HMAC-SHA256 signature verification** in `slack/verify.ts`. Takes the signing secret as an argument — there is **no global `SLACK_SIGNING_SECRET` env var**. Slack uses BYO credentials per assistant, loaded from the `channel_integrations` table by the API package. See `docs/architecture/channels/adapter-pattern.md` → "Slack Credential Provisioning".
- **Adapter is a factory** — `createSlackAdapter({ botToken, botUserId, onMessage? })`. Every webhook request constructs a new adapter bound to that assistant's decrypted bot token. `onMessage` is optional so the scheduled-job executor can build a delivery-only adapter without a noop callback. The Telegram adapter follows the same pattern (`onMessage?` optional) for the same reason.
- **`validateSlackCredentials(botToken)`** wraps Slack's `auth.test` for credential validation during the settings-UI setup flow. Returns `{ teamId, teamName, botUserId }` on success, throws on Slack API errors so the caller can surface them.
- **Adapter is leaner** than Telegram — no media group buffering (Slack handles aggregation upstream), no text fragment reassembly (less of an issue for Slack's UX).

## Discord specifics

Full spec: `docs/architecture/channels/discord.md`. This is the **adapter only** — the receiving transport (Gateway WebSocket vs HTTP Interactions) and its route/DB wiring are deferred.

- **`parseIncoming` handles two payload shapes** — a Gateway `MESSAGE_CREATE` dispatch (the only transport for free-form chat; needs the privileged `MESSAGE_CONTENT` intent) and an HTTP Interaction `APPLICATION_COMMAND` (slash commands only). A bare forwarded message object (just the dispatch's `d`) is also accepted.
- **`verifyDiscordSignature`** does Ed25519 over `timestamp + rawBody` (headers `X-Signature-Ed25519` / `X-Signature-Timestamp`), built on Node `crypto` with no `tweetnacl` dependency. Gateway delivery has no per-message signature — verification is for the Interactions path. PING (type 1) → `DISCORD_PONG`.
- **`botUserId` is required for self-mention detection** in servers — resolve it once via `validateDiscordCredentials` (`GET /users/@me`) and persist it. Without it, `requireMention` never matches and server messages are dropped.
- **Outbound mention safety**: messages default to `allowed_mentions: { parse: [] }` so model output can't trigger an `@everyone`/role ping. `config.allowUserMentions` opts into `users`-only.
- **Status → edit-in-place**: Discord has no native thinking indicator, so `sendStatus` posts a real message and returns its id for the caller to `editMessage`. 2000-char limit; `markdownToDiscord` is light (Discord renders most GFM natively).

## Adding a new adapter

1. Create `packages/channels/src/<name>/`.
2. Implement `ChannelAdapter` from `types.ts`. Don't add fields to the interface — if you need adapter-specific config, take it as a constructor option.
3. Webhook verification goes in `<name>/verify.ts` or `<name>/webhook.ts`. Always constant-time compare; never log secrets.
4. Tests in `packages/channels/src/__tests__/<name>.test.ts`. Tag: `[COMP:channels/<name>]`.
5. Add a row to `docs/workflow/component-map.md`.
6. Add a route to mount the webhook in `packages/api/src/routes/<name>.ts`.

## Common gotchas

- **`drainDelayMs: 0` for web**, `2000` for messaging. The caller (route handler) implements the actual idle-drain — the adapter just declares its preference.
- **Deduplication** is **per-adapter, in-memory**. On restart, the buffer empties and a redelivered webhook will reprocess. For at-least-once correctness, the route handler must also check `session_messages` for the inbound message ID.
- **`sendMessage` returns the message ID** — the caller stores this so it can later `editMessage` (e.g. when streaming a response into a previously-sent status message).
- **Don't log incoming message text** anywhere in this package. Only log channel IDs and message IDs. The analytics layer enforces this at the schema level (`SafeValue`), but the adapter is the first opportunity for a leak.
