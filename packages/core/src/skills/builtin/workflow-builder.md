---
name: workflow-builder
description: Guided setup for a recurring or triggered automation — interview the user (goal, trigger, steps, which assistant per step, delivery channel, optional doc page), then proposeWorkflow → confirm → createWorkflow. Use for "set up an automation", "build a workflow", "do X every week / when Y happens".
license: MIT
compatibility: Designed for sidanclaw
metadata:
  author: sidanclaw
  category: productivity
  applies_to_app_type: any
  when_to_use: The user wants a recurring/triggered automation — "set up an automation", "build a workflow", "do X every Monday", "when a PR is merged...". Run the interview; never create a workflow from a one-line request without proposing it first.
  tags: official
---

# Workflow builder

Turn a vague "automate this" into a minimal, approved workflow. **Never** call `createWorkflow` straight from a one-liner — interview the user, `proposeWorkflow`, show the summary, get an explicit OK, *then* `createWorkflow`.

Skip the full interview for a one-off action (just do it). A **simple reminder is a 1-step scheduled workflow** — one `assistant_call` step plus `trigger: { kind: "schedule", ..., delivery: { channel } }`. Propose that single step, confirm, then `createWorkflow`; do not reach for a separate scheduling tool (`createScheduledJob` / `scheduleWorkflow` are deprecated).

## Interview — ask conversationally, a couple at a time

1. **Goal** — the outcome each run should produce, in one sentence.
2. **Trigger** — schedule · event (a *connected* connector/channel) · webhook · manual. Pick the simplest that fits. For **schedule**, pass it on the create call as `trigger: { kind: "schedule", schedule: { type: "daily"|"weekly"|"monthly"|"once"|"cron", ... }, timezone?, delivery?: { channel }, policy?: { silentUntilFire?, nagIntervalMins?, nagUntilKeyword? } }` — this schedules in the same call (no separate step). `delivery.channel` (telegram/slack/whatsapp) pushes the result and, for a recurring reminder, pins the exact chat + Telegram topic automatically. `policy` covers "nag every N min until <keyword>" and silent-until-fire.
3. **Steps** — propose a minimal sequence (often 1, rarely >5); each is an `assistant_call`, `tool_call`, `wait`, or `branch`. Show them, let them adjust.
4. **Assistant per step** — `target.assistantId` must be the literal `'primary'` (the default, the workspace's primary assistant) or a concrete assistant **UUID**. It is never a human-readable name: there is no name lookup, so a value like `'product-assistant'` is rejected when you `proposeWorkflow` and would fail the run. Default to `'primary'`; target a specific sibling only when you have its real assistant id (e.g. a connected assistant's `assistantId` from `listConnectedAssistants`). Do not invent an assistant or guess an id, default to `'primary'`.
5. **Delivery** — which channel gets the result: Telegram / Slack / WhatsApp (not web — see limits).
6. **Doc (optional)** — write/update a page? Set the step's `page` field — NEVER just name a page id in the prompt (the callee gets no page tools that way and the step fails every run). `page: {"id": "<page uuid>"}` edits an existing page; `page: {"create": true, "title": "...", "nestUnder": "<page uuid>"}` creates a saved page each run; `page: {"fromStep": "<stepId>"}` edits the page an earlier create-step made this run. The callee then runs with the doc tools (`getCurrentPage` / `patchPage` / `renderPage`) anchored to that page.
7. **Persist to brain (optional)** — should a step remember a finding for future runs / other assistants? An `assistant_call` step can call `saveMemory` (memory read+write are available to workflow steps by default). Just say so in the step prompt ("save the key finding to memory"); don't add a `tools` allow-list unless you mean to *restrict* the step (an allow-list that omits `saveMemory` removes it again).
8. **Tools (optional)** — a `tool_call` step's `toolName` must be an exact, real tool name. Built-in brain search is `searchBrain`; web search/fetch is `mcp_search`. Do not invent generic names like `search` or `update` — they fail the run with `tool_not_found`.
9. **Fetching from a connector (GitHub / Gmail / Notion / Calendar / Fathom)** — pull the data in a **dedicated `tool_call` step**, not inside a free-choice `assistant_call`. Two reasons: a `tool_call` HALTS the run if the connector errors (bad/expired token, not connected), so a failure surfaces instead of the assistant fabricating a plausible answer from memory; and it pins the exact tool instead of letting the model choose on the fly. Pattern: `tool_call` (fetch, `storeOutputAs: "data"`) → `assistant_call` (prompt consumes `{{vars.data}}` to summarize/act). If you must keep it one step, add a `tools` allow-list naming the exact connector tool. Connectors are preflighted at create time — if a referenced connector is disconnected or its token is revoked, `proposeWorkflow` / `createWorkflow` will error; reconnect it first.

## Build

Assemble the `definition` (`startStepId` + `steps[]`) and the `trigger` (a **sibling** argument, not inside the definition) → `proposeWorkflow({ name, definition, trigger })` (validates; returns a summary + **warnings**) → present it verbatim and get an explicit "create it" → `createWorkflow({ name, definition, trigger })`. createWorkflow schedules inline when the trigger is a schedule, so do **not** also call `scheduleWorkflow` / `createScheduledJob` (deprecated). To reschedule later, `updateWorkflow({ workflowId, trigger })`. Then say it's live and where to run it (the Workflow tab; "Run now" for manual).

**Act on the warnings AND errors.** `proposeWorkflow` returns `warnings[]` (silent no-op / fail-at-runtime risks — a `web` delivery target, a page edit described in prose with no `page` anchor, an unknown `tool_call` name, a connector pulled inside a free-choice `assistant_call`) and, when `ok` is false, `errors[]` (hard blocks — a delivery channel the bot can't reach, a connector that is disconnected or whose token is revoked). Errors mean `createWorkflow` will refuse the workflow: fix the cause (reconnect the connector, pick a reachable channel) and re-propose. Resolve every warning too before `createWorkflow`; never ship a workflow with unresolved warnings (this is the failure class behind "the workflow runs but never updates the doc / sends nothing / posts to the wrong place").

**Delivery channel must be reachable from where you author.** Setting `delivery.channel: "slack"` (or a per-step Slack `deliver`) captures the channel from the session you're in — so a Slack target authored from a web or Telegram chat has no real Slack channel to capture and fails `channel_not_found`. Author the workflow from inside the Slack channel you want the result posted to, or pick a channel the connected bot is a member of. Delivery targets are validated at create time; an unreachable one is a hard error.

## Limits — don't promise what the primitives lack

- **No web delivery** (the web app is pull-only) — use a messaging channel or a doc page; otherwise the output only lives in run history.
- **Doc output requires the step `page` anchor** — a page id mentioned only in prompt prose gives the callee no page tools and fails the run.
- **No event trigger on an unconnected source** — verify it's connected, else fall back to schedule/manual and offer to connect it.
- Don't fabricate channels/connectors/assistants; don't over-engineer (start with the simplest workflow that meets the goal).
