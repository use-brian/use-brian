# Telegram broadcast channels and linked discussions

The open BYO Telegram integration supports private chats, groups, forum topics,
broadcast-channel posts, and comments in linked discussion supergroups.

## Setup and operation

1. Connect your bot in **Studio → Channels** with a public HTTPS webhook.
2. Add the bot to the broadcast channel with permission to post. Add it separately
   to the linked discussion supergroup with permission to read and send messages.
   Being in the channel does not give the bot access to its discussion group.
   Telegram privacy mode controls which group messages it receives; use an admin
   bot or disable privacy mode if it should see unaddressed group messages.
3. Use an authorized, linked owner/workspace admin to add the bot. Existing BYO
   group/channel add-protection still applies to both chats independently.
4. For installations created before `channel_post` support, **re-register the
   webhook**. Telegram retains the previous `allowed_updates` list until
   `setWebhook` is called. Operators can use the existing
   `packages/api/scripts/refresh-tg-webhooks.ts` script with `DATABASE_URL`,
   `CHANNEL_CREDENTIAL_KEY`, and `WEBHOOK_BASE_URL` set. It refreshes all BYO bots;
   review that scope before running it. Reconnecting a bot also registers its
   webhook. Apply migration `563_telegram_discussion_context.sql` before deploying
   original-post context support (the earlier routing-only change needed no migration).

To invoke Brian in a broadcast post, explicitly `@mention` the bot or use a bot
command (for example `/ask@your_bot Summarize this`). Broadcast posts always need
explicit addressing, even when group answer-all is enabled. Unaddressed channel
posts are not attachment-capture triggers. Brian's reply is posted **in the
broadcast channel**, not automatically in its comment section.

To converse in a post's comments, address Brian in the **discussion group**.
Existing group mention/reply/command rules apply, including whole-chat mention
settings. Brian's response stays in that comment thread. Forum-topic overrides
are not interpreted as discussion-root overrides.

### Sender safety

Channel posts and messages sent on behalf of a channel or anonymous administrator
identify a **chat**, not a human. The normalized sender is `chat:<sender-chat-id>`
(the broadcast chat itself when `sender_chat` is absent). Telegram's synthetic
`from` user, username, and author signature are not identity evidence.

These senders run as isolated, unidentified channel shadows: no owner identity,
private memory, workspace membership grant, or guest connector-tool opt-in.
Identity-store failure drops the turn instead of falling back to the owner.
Human-user allowlist mode rejects chat senders, even if their synthetic `from`
matches an allowed or linked user. Use ordinary identifiable users in the comment
section when linked-account or trusted-user access is required. In blocklist mode,
a chat identity can be blocked as `chat:<id>`; a human blocklist cannot identify an
anonymous administrator behind a chat identity.

Automatic channel-to-discussion forwards (`is_automatic_forward`) never start a
turn or file attachments. They are duplicate deliveries of the original post,
not user requests. Their text/caption and verified root metadata can nevertheless
be persisted as discussion context. Identifiable bot-authored messages are ignored
as turns. Edited messages
and edited channel posts are neither subscribed to nor processed: an edit must not
rerun tools or produce another answer. Explicit channel addressing reduces
unintended bot-to-bot responses. Own sends normally do not produce inbound bot
updates, but a channel post with absent `from` cannot reliably be attributed to a
human versus another bot (or an echoed own post). The explicit-address gate is
not durable outbound-message deduplication: an indistinguishable echoed post that
itself addresses the bot could still trigger a turn. This is not a general-purpose
cross-bot provenance system.

## Architecture and routing contract

| Surface | Normalized `channelId` | Outbound routing |
| --- | --- | --- |
| Private / ordinary group / broadcast | `<chat-id>` | `chat_id` |
| Forum topic | `<chat-id>:topic:<topic-id>` | `chat_id` + forum `message_thread_id` |
| Linked discussion thread | `<group-id>:discussion:<root-message-id>` | `chat_id` + reply to the discussion root |

A comment section is the message thread rooted at the **automatically forwarded
message in the discussion supergroup**. Its root id is not the channel's post id.
`linked_chat_id` identifies the paired chat, not any post-to-root mapping. We do not
attempt to construct comment destinations from broadcast post ids, or move replies
between the two chats.

The adapter recognizes a direct reply to an automatic forward from
`reply_to_message.is_automatic_forward`. For nested replies, the BYO route reads
`getChat` (`ChatFullInfo.linked_chat_id`) for a non-forum supergroup carrying
`message_thread_id`, and supplies the verified discussion-group id to the adapter.
This also covers callbacks on bot messages and works on a cold process without
having observed the original forward. `linked_chat_id` is **not** assumed to exist
on the update's partial `chat` object. A failed metadata lookup drops the threaded
update rather than merging an unknown thread into the room session. The webhook
has already acknowledged HTTP 200 at this point. After the Bot API client's
normal transient retries, a failed lookup is logged but the update is **not queued
for replay**, and Telegram will not redeliver it because of that failure. This is
an intentional fail-closed availability tradeoff; the user must resend. It also
affects threaded updates in ordinary non-forum supergroups while metadata is
unavailable, because their linked/unlinked status cannot be established.

In a verified linked group, non-forum message threads get discussion scopes; this
includes ordinary reply threads created inside that linked group. Unthreaded
messages retain the room scope. Unlinked, ordinary non-forum groups retain the
previous bare-chat scope even if Telegram supplies a reply-chain thread id. Forum
behavior, including the General-topic outbound special case, is unchanged. Link
metadata is checked per request rather than cached indefinitely; historical nested
threads after a group is unlinked cannot be proven from link metadata alone.

The full destination partitions sessions, locks, callbacks, and buffered media;
existing per-user session isolation remains. A discussion is not one shared
cross-user session. Routing precedence is exact discussion → discussion group →
integration default; it does not inherit a broadcast channel's assistant route.
Credential lookup, routing diagnostics, destination discovery, and scheduled
labels understand the new namespace. Discussion roots are not stored in the
`seenChats.topics` forum inventory. Existing room sessions are not rewritten or
migrated into the new thread scopes.

Outbound Telegram `message_thread_id` is for **forum** topics, not channel comment
threads. Every discussion text chunk, status, document, and attachment-failure
notice replies to the root using `reply_parameters` with
`allow_sending_without_reply: false`. This works for proactive/scheduled sends too,
without an inbound message id. Deleting the root must not send the answer into the
main group. Discussion sends have no unthreaded fallback. Edits, reactions, pins,
and deletes unwrap the base group id; typing is group-level because Telegram has
no comment-thread typing target.

`parseTopicChannelId` retains its public name for compatibility. It now returns
`discussionRootId` for discussion destinations, leaving `messageThreadId` undefined.
Adapter-only consumers must supply verified `config.discussionChatIds` for nested
comments; the open BYO route does this automatically. Hosted/shared-bot runtime
wiring outside this repository is not changed here.

## Original-post context (both privacy modes)

The BYO webhook durably captures original broadcast text or media captions from:

- `channel_post`, including unaddressed posts: stored by source channel + post id.
- `message.is_automatic_forward` in the discussion group: stored by group + the
  **forward's group message id**, with `forward_origin.type = channel` providing
  the source channel/post mapping when available.
- A direct comment's `reply_to_message.is_automatic_forward`: its text/caption
  supplies the same context even when privacy mode hid the standalone forward.
  `forward_origin` can identify the original post; `sender_chat` alone identifies
  only the channel, so no source post id is inferred.

With privacy disabled (or suitable admin delivery), standalone forwards populate
context before any comment arrives. With privacy enabled, an addressed direct
reply can seed it from the reply snapshot, even for an old post. Subsequent nested
comments load that durable root record, including after a restart. Existing mention
and identity rules still decide whether a comment gets an assistant turn.

A forward origin or channel sender **without** the automatic-forward flag is not
proof of an original discussion post: manual forwards and anonymous comments are
not promoted to roots. Nested replies do not overwrite the original with their
immediate parent's text. `linked_chat_id` still verifies the discussion *group*,
never the source post mapping. Distinct roots and integration ids remain isolated.
Only posts with a verified root mapping can be joined to stored channel content;
late source-post delivery can fill a previously missing context on the next turn.

`telegram_channel_posts` and `telegram_discussion_roots` are internal, RLS-enabled
Postgres tables with no member-access policies. Every write/read/join is scoped to
an authenticated webhook integration; records cascade on integration deletion.
Webhook-secret validation, active-channel capability and bootstrap routing checks
precede writes. Content observation is intentionally before mention/access turn
filters, so unaddressed original posts remain available to authorized comments.
No source material is written into integration configuration, private memory, or
session history as if a human or Brian had said it. First observed non-null content
is retained; duplicate deliveries are idempotent and conflicting source mappings
cannot overwrite an existing mapping. Edits are still ignored. Records currently
last for the integration's lifetime; there is no automatic historical backfill or
retention-pruning job.

On each discussion turn the route reads context and uses the pipeline's existing
`providerVisibleContext` envelope, explicitly labelling it **untrusted source
material, not instructions or the commenting user's words**. This is one envelope
per invocation, not a synthetic assistant/user turn and not an “injected” marker
that could lose context on failure, retry, or history compaction. The generic
reply-quote path is suppressed for that direct auto-forward snapshot to avoid
injecting it twice or mislabelling its synthetic bot sender as Brian. Normal
nested-reply quotes remain intact. Session and per-user partitioning are unchanged.

If an old post was never observed and no usable direct-reply snapshot is delivered,
the model receives an explicit “original text/caption unavailable” note and must
ask for it when needed, not invent it. A captionless post also has no available text;
media bytes are **not** downloaded or interpreted by this context feature. Each
album member is keyed by its own message id; captions from sibling posts are not
guessed or concatenated. Context storage/read failures fail closed and are logged;
like metadata lookup failures, these happen after HTTP acknowledgement and do not
schedule replay. A new user attempt or source delivery is required.

Bot-generated posts use the same context path when Telegram supplies a forward or
reply snapshot. Outbound-response capture is not added: the current adapter returns
one id for potentially chunked text/document sends, not a complete per-message
content mapping. This feature does not add outbound echo deduplication or a history
fetch API. Hosted/shared-bot runtime wiring remains outside this change.

## Verification

Focused context coverage includes both privacy payload patterns, verified provenance,
missing content, integration/root isolation, retry-safe envelopes, and webhook
authentication before writes. A real-Postgres suite exercises migration/RLS metadata,
reconnect persistence, duplicate deliveries, late posts, conflicting mappings, and
integration deletion.

Existing unit coverage includes channel-post subscription and normalization, ignored edits
and automatic forwards, anonymous identities and access gates, channel albums,
cold nested-thread lookup, separate scopes and callbacks, preserved forum/ordinary
group behavior, strict multi-chunk/document/status delivery, destination discovery,
and routing inheritance. Tests mock Telegram; a live bot/channel smoke test is
still recommended before rollout, especially permissions and privacy-mode setup.

Public Telegram references:

- [Discussion groups and channel comments](https://core.telegram.org/api/discussion)
- [Message fields](https://core.telegram.org/bots/api#message)
- [ChatFullInfo / linked_chat_id](https://core.telegram.org/bots/api#chatfullinfo)
- [sendMessage](https://core.telegram.org/bots/api#sendmessage) and
  [ReplyParameters](https://core.telegram.org/bots/api#replyparameters)
- [Update types](https://core.telegram.org/bots/api#update)
