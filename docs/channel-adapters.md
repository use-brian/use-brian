# Shared channel interactions

Messaging routes authenticate provider events, resolve routing and sender identity,
then hand normalized events to common interaction handling. Business decisions do
not depend on whether the user pressed a button or typed a reply.

## Incoming behavior

- **Live tool approval:** `approve`, `allow`, `yes`, `ok` (or `deny`, `reject`,
  `no`) answers the initiating sender's pending request. `always allow` and
  `always deny` are accepted only when that request permits persistent policy.
  Telegram, Slack, Discord, Feishu, Teams, WhatsApp Cloud and QR-login, WeChat,
  and custom bridges all use the same registry and prompt.
- **Isolation:** pending state is scoped by provider, connected channel,
  conversation, sender and native thread. A native card can recover its thread
  only from its exact bound delivery message. Ambiguous, expired, replayed or
  wrong-sender actions cannot approve a tool. State is removed on completion,
  abort or the five-minute deadline. Unrelated text denies the pending request
  and continues as a new message; it never implies approval.
- **Cancellation:** `stop`, `cancel`, `abort`, `nevermind`, `never mind` and
  their slash forms stop only that sender's active turn in that thread. Any
  pending confirmation is denied before aborting. Slack message edits retain
  their transport-specific edit-to-retry behavior.
- **Conversational choices:** buttons, one-based option numbers and option
  labels resolve to the same canonical answer. Native choice answers are never
  reinterpreted as workflow approval commands. Free text remains available.
- **Workflow interactions:** `approve <approval-id>` / `reject <approval-id>`
  are intercepted before the model. Durable workflow questions support native
  replies, choice numbers/labels and `wq:<reference> <answer>` when quoting is
  unavailable. Scheduled confirmations use verified outbound delivery
  provenance, not a lookup for an arbitrary pending row in the channel.
  Workspace membership, assigned approver, assistant and current tool policy
  are checked again; a question answer does not grant tool approval.

Live replies must be intercepted **before** acquiring the conversation lock:
that lock is held by the turn waiting for the answer. `processChannelMessage`
registers/cleans up confirmations and active turns, handles durable workflow
replies, and binds conversational choices. Routes supply `interactionScope`,
the actual `questionIntegrationId`, original incoming metadata, and forward
core's outgoing actions. Provider ACK deadlines, signature checks, credentials,
media acquisition and native threading remain transport responsibilities.

Email has an outbound adapter but no inbound chat route in the OSS composition;
its host must use the common pipeline to support interactive replies. The
existing workflow delivery schema supports Telegram, Slack, Feishu, Teams,
custom and WhatsApp; this change does not add new workflow delivery targets.
Web UI approvals keep their authenticated structured-decision endpoints.

## Outgoing action contract

`OutgoingMessage.actions` supports callbacks (`kind: 'callback'`, or omitted)
and links (`kind: 'web_app'`). Adapters preserve all actions, including when the
message body is empty. Files and images retain their existing adapter support.

Callbacks carry `id`, `label`, and opaque `data`. Native clicks return the
unchanged data through the platform's existing callback integration. Adapters
must not interpret it as an approval, question, or other business operation.
The optional **`replyText`** is a human-sendable token supplied by core, e.g.
`approve` for a scoped live request or `wq:<reference> 1` for a durable question.
Core must recognize that token on text replies.
Adapters do not derive commands from callback data. Without `replyText`, the
label is offered as the reply (empty labels default to `Continue`); this is
readable but only actionable if the consumer recognizes that label. Blank
`replyText` also uses the label. Labels and reply tokens are trimmed.

`normalizeActionInput(data, messageId?)` optionally wraps nonempty string data
as a transport-neutral `IncomingAction`; it does not decode or authorize it.
Existing inbound webhook/callback contracts remain unchanged.

## Delivery

Shared `denormalizeActions` appends one line per action:

- `Approve — reply: approve`
- `Open dashboard: https://example.com/dashboard`

The alternative is retained **even beside native buttons**, so card/button
rejection and native action overflow cannot hide a choice. Messages with actions
use plain formatting to avoid markdown conversion corrupting reply tokens;
email sends the plain-text alternative. Existing platform-native rendering
(e.g. Slack mrkdwn, Feishu cards, WhatsApp client formatting) can still apply.
Keep reply tokens short, single-line, and safe for plain-text platform display.
Core should supply unique, unambiguous tokens and validate them on receipt.

| Adapter | Native actions | Text alternative |
| --- | --- | --- |
| Telegram | Inline callbacks and Web Apps | Always |
| Discord | Callback and URL buttons | Always |
| Feishu | Interactive-card callbacks and links | Always |
| Slack, Teams, email | None | All callbacks and links |
| WhatsApp connector / Cloud, WeChat, custom | None | All callbacks and links |

Telegram attempts up to 100 buttons with at most eight callbacks per row;
Discord attempts up to 25 buttons; Feishu attempts up to five. Additional
choices remain in the text. Provider constraints (callback size, URL validity,
chat type, permissions) may reject native controls; sends retry without native
controls, or retain the already-delivered text in Telegram. Text delivery errors
propagate; this does not promise delivery during a provider outage.

Editable adapters retain the same alternatives. Native edit rejection falls
back to text or a fresh send. An action-bearing edit exceeding the platform
message limit sends a new chunked message rather than truncating choices;
the original message is left unchanged. Unsupported edit methods retain their
existing unsupported/no-op contract; callers must honor `supportsMessageEdit`.
Long individual tokens/URLs can be split by platform text limits: use short
tokens and URLs rather than unbounded action payloads as reply text.

Custom bridges receive text alternatives in the existing outbox message
payload, without a new protocol feature. `sendMessage(..., { threadTs })`
passes that target as `payload.replyToMessageId`.
