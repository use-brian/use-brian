# Recent messaging channel for workflow approvals

A `tool_call` step may configure `approval.deliveryChannel: "recent"`.
The builder exposes this as **Most recent messaging channel**; conversational
workflow authoring uses the same field. This option does not require approval
by itself: use `approval.required: true` to force a pause even under Allow policy.
Omitting the delivery channel retains the existing `web` default.

## Routing contract

Resolve the destination when creating each approval, not when authoring the
workflow. Use the assigned approver's most recent inbound user message to the
workflow's executing assistant in the same workspace. Never select another
user's history or let outgoing assistant messages, workflow notifications, or
session activity move the target. Messaging history considers Telegram, Slack, WhatsApp, Microsoft Teams,
and Feishu first. When no safe messaging destination exists, the resolver
falls back to the approver's most recent personal web chat with the same
assistant. Internal sessions still do not compete. Recent notifications
support positively identified connected Telegram, Slack, Microsoft Teams, and
Feishu integrations. A latest WhatsApp conversation cannot yet pin its owning
account safely, so it also falls through to personal web chat (or the Approvals
panel when none exists). Never substitute an older conversation.

Persist the resolved concrete channel type/id on the approval and pin routing
metadata in its payload. Subsequent messages cannot move an existing request.
Telegram topics and Slack threads retain their conversation routing. Feishu
uses the inbound message id for reply delivery. Bound channel integrations use
the existing workflow delivery adapters, including BYO credentials. Missing or
ambiguous integration bindings fall back to personal web chat rather than
guessing a bot. Surface bindings resolve exact conversation, Telegram parent
chat, then default; bindings for unrelated conversations do not compete.
Legacy official Telegram history without a positively identifiable integration
is web-chat-or-panel only in recent mode; it must not be confused with a
removed BYO bot.

No matching messaging or personal web-chat history means Approvals-panel-only
review. A provider delivery failure or unsupported delivery configuration never
approves or runs the action: the request remains in the web Approvals queue.
Native workflow notifications keep their existing confirmation-style message
and Approvals-panel fallback. New external human approvals do **not** use this recent-history resolver. Administrators explicitly select a connected conversation (including web) after choosing an assistant, with no approver picker. Discovery returns opaque destination IDs and connection availability reasons (`no_conversation` or `unsupported_transport`); not every installed connection can deliver. Legacy external `verified_channel` registrations retain compatible recent routing.

Connected external sources freeze the exact selected session, integration and Slack/Feishu thread, with strict unthreaded/threaded separation, and require the pinned assistant to remain the winning route. WhatsApp Cloud API is unavailable for pinned external approval delivery using its public metadata discriminator; connector-backed WhatsApp requires compatible addresses. Discord is unsupported. Web is a special session-bound surface, not proactive transport. External requests use existing ChatConfirmationCard and Needs you surfaces for all concurrent requests, never the native Approvals queue. Decisions require current workspace membership and canonical assistant/conversation access, revalidated with live identity and policy-epoch locking in the same owner transaction. See [external human approvals](external-human-approvals.md).

The assigned approver's existing
authorization checks are unchanged; receiving the notification grants no new
authority. A group conversation previously used by the approver may be the
selected destination, so choose Web approvals for private review.

Explicit existing channel choices retain their legacy behavior. In particular,
legacy non-Telegram explicit notifications remain unimplemented; the builder
preserves those stored values without offering them as new working choices.

## Configuration

```json
{
  "approval": {
    "required": true,
    "deliveryChannel": "recent"
  }
}
```

The tool-step editor provides Web approvals, Most recent messaging channel,
and the existing Telegram notification option. Changing the notification
channel preserves all other step and approval properties.

## Verification

- Core schema accepts `recent` and rejects unknown delivery values.
- Resolver tests cover scope and inbound ordering, topics/threads, integration
  ambiguity, and no-history fallback.
- Approval bridge tests verify concrete persisted routing and web fallback.
- Dispatcher tests verify adapter delivery rather than the legacy bot path.
- Builder tests cover selecting `recent`, preserving approval settings, legacy
  values, and raw JSON synchronization.

Connected external SQL tests use focused PGlite fixtures with mocked canonical helper bodies; the ordinary-owner fresh-chain test separately applies the real migrations. Neither proves multi-connection PostgreSQL races or live end-to-end delivery. No live operational changes are implied.
