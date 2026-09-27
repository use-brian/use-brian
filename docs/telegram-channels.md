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
   webhook. No database migration is needed.

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
not user requests. Identifiable bot-authored messages are ignored. Edited messages
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

## Verification

Unit coverage includes channel-post subscription and normalization, ignored edits
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
