# Approval confirmation consolidation

The existing Chat miniapp has
`ApprovalReviewAttention` and the shared `ChatConfirmationCard` tool-request UI.
External approvals extend those surfaces, not a new decision queue.

## Feature-branch merge plan

1. Remove the new Approvals sidebar row and the external-action decision card
   from the legacy Approvals panel. Existing native-kind routes and APIs remain
   compatible; this feature does not delete unrelated workflow/skill review UI.
2. Reuse `ChatConfirmationCard` for the complete frozen external request in
   Chat and the existing Needs you popover. Allow/Deny acts in place, without
   an Open Approvals detour. Explicitly selected web conversations restore cards in their session;
   Needs you remains the existing attention surface. Legacy registrations stay compatible.
3. Return all applicable external confirmations as an additive array from the
   existing session pending endpoint, independent of live tool confirmations.
   Preserve active tool turn leases, native pending fields and native responses.
4. Keep human consent on `/api/approvals/:id/respond`. Sharing presentation is
   not sharing execution authority: external decisions never call chat confirm,
   create tool invocations, block a composer or resume a Brian turn/workflow.
5. Preserve channel Allow/Deny actions and exact `approve|reject <id>` reply
   binding. Notification links open Chat's existing Needs you surface.
6. Verify full literal content, concurrent requests, session/user/assistant
   isolation, expiry, lost races, offline/retry behavior and native regressions.

## Safety and compatibility

No standing grants, reviewer delegation, batch approval, tool input or denial
comments are exposed for external requests. Source authority, destination and
expiry are checked server-side on every decision. The UI disables elapsed
requests and never reports a competing decision as the attempted choice.
Transient reads preserve mounted cards; permission-loss reads clear them.

The legacy Approvals panel remains for pre-existing native kinds. Replacing all
native email revision, skill diff and workflow review flows is a separate
migration, not a prerequisite or an excuse to introduce a second external
approvals inbox. The additive conversation-member schema is documented in
[external human approvals](external-human-approvals.md); it does not change native approvals.
No deployment or migration application is implied.

## Connected-conversation registration

Administrators choose name, assistant and an explicit connected conversation (web included), not an approver or recent history. Discovery returns opaque destination IDs and connection availability reasons; registration posts `{name,assistantId,destinationId}`. Not every installed connection can deliver. Web is session-bound, not a proactive transport.

The immutable audience binds the selected session, integration and exact Slack/Feishu thread, distinguishing unthreaded from threaded, and requires the pinned assistant to remain the winning route. A deciding human needs current workspace membership and canonical assistant/conversation access. Revalidate live auth-session or channel-linked identity and policy epoch in the same owner transaction as the decision. No source-secret public decisions, models or delegation. Legacy registration and hashes remain compatible.

Focused PGlite tests mock canonical helper bodies; the ordinary-owner fresh-chain test separately applies the real migrations. Neither proves multi-connection PostgreSQL races or live end-to-end delivery. No live deployment, migration application or credential operation is implied.
