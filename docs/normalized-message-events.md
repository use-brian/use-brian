# Incoming message workflow events

All installed messaging transports use `packages/api/src/message-events.ts` after authentication, source resolution and message normalization. That layer converts a normalized message to the existing core `DispatchEvent`; workflow matching, goal wakeups and run queuing remain in the source-independent dispatcher. `boot.ts` installs it once. New transports call `dispatchIncomingMessageEvent`, rather than constructing workflow events themselves.

## Coverage

| Ingress | Source provider | Source identity |
| --- | --- | --- |
| Telegram | telegram | integration UUID |
| Slack | slack | integration UUID |
| Feishu/Lark | feishu | integration UUID |
| WhatsApp Cloud and BYON | whatsapp | integration UUID |
| Discord | discord | integration UUID |
| Microsoft Teams | msteams | integration UUID |
| WeChat | wechat | integration UUID |
| Custom bridges | custom | integration UUID |
| Workspace-shared, unrestricted web/app messages, including workflow docks and assistant chats | web | persisted session UUID |
| Mailbox email | imap connector | connector instance UUID (existing normalized ingest event bridge) |

The workflow event source picker discovers installed integrations and eligible recent web sessions. Web discovery checks membership, assistant access and session-read scope; it inspects at most 200 recent candidate sessions. Because workflow run inputs are workspace-wide, both dispatch and discovery require workspace visibility, explicit public clearance, no compartments or Team/Project binding, and non-draft mode. Private/restricted chats fail closed even when a subscription contains their known UUID. Web events use the persisted session UUID for both source and conversation identity, never a caller-selected alias.

## Admission and contract

- Message events are independent of assistant reply routing, mention gates and the chat capability. Passive/group and media-only input can start workflows without forcing a conversational reply.
- Transport authentication, active-channel status and configured sender restrictions still apply. Self echoes and transport callbacks are not incoming human-message events. Public/API guest turns intentionally remain outside workspace-wide automation: their client authority cannot be represented by the existing dispatcher. Internal assistant/workflow output is not new human input.
- Supply the trusted workspace and integration IDs, an `IncomingMessage` plus `channelType`, and optional normalized mention IDs. The event boundary takes **Unix seconds**; adapters using milliseconds convert at the boundary. Provider-specific safe metadata may be supplied in `payload` for compatibility.
- The common payload includes message/conversation/actor identity, text, reply identity and safe attachment descriptors. Raw transport envelopes, credentials, media URLs and bytes are not automatically copied.
- Web dispatch happens after new human input persistence. Regeneration, edits and reuse of an existing room message do not re-emit it.
- Existing transport deduplication remains; Slack additionally uses a durable claim for the message/app-mention pair. This is best-effort dispatch, not a durable exactly-once outbox. Dispatch failures are logged and do not interrupt chat. Bot-origin matching retains the dispatcher's default opt-out behavior.
- Triggering a workflow is distinct from delivering its result to a channel. Existing workflow step/delivery capabilities are unchanged.

## Verification

Regression suites cover shared normalization and real dispatcher matching, all changed ingress routes, passive/media input, sender restrictions, self echoes/callbacks, Slack dual delivery, Telegram discussion identity, provider mention matching, web-source permissions and source-to-dispatch identity. Existing core event-trigger and mailbox ingest-trigger suites cover downstream matching and email normalization.
