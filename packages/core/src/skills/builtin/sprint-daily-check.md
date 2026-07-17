---
name: sprint-daily-check
description: Daily sprint variance check — find tasks that have slipped their `due` date (not `done` / `archived`) and write `commitment:sprint_variance` memories for each new slip. The commitment-lifecycle worker resolves each automatically when the task clears (done / archived / replanned). Use via a daily scheduled workflow, or when the operator asks "how's the sprint?", "any slips?", "what's behind?".
license: MIT
compatibility: Designed for Use Brian
metadata:
  author: Use Brian
  category: planning
  applies_to_app_type: any
  when_to_use: A daily scheduled turn in any workspace that uses tasks for sprint planning (tags like `sprint:<id>`). Also valid as an ad-hoc operator query. Skip if the assistant lacks the `tasks` capability or no tasks have a `due` date.
  tags: official
---

# Sprint daily check

Surface tasks that have slipped their planned `due` date, and record each new slip as a `commitment:sprint_variance` memory. The lifecycle worker resolves the commitment automatically when the slip clears — task `status: done`, `status: archived`, or `due` replanned into the future. The resolved chain is the bi-temporal audit of which slips happened, when, and how long they stayed open. For next sprint's planning, prior slip history informs better estimates — that's the feedback loop.

Per `docs/historical/decisions-log.md` 2026-05-14:

- Sprint membership = `tags: ['sprint:<id>']` on tasks.
- Estimation / ordering / velocity = `tasks.attributes` keys (e.g. `estimate_days`).
- Variance / slip alerts = `commitment:sprint_variance` memories with `task:<uuid>` (+ optional `due:<iso>` and `sprint:<id>`) tags.
- Resolution = the sprint-variance commitment resolver (`brain/sprint-variance-resolver`).

## When to use

- A daily scheduled workflow invokes this skill (assistant cron turn).
- The operator asks "how's the sprint?", "what's behind?", "any slipping tasks?".

**Skip** when:

- The assistant has no `tasks` capability (the task tools aren't available).
- No tasks in this workspace have a `due` date set (nothing can slip against a plan).

## Recipe

### 1. Fetch slipped tasks

Call `listTasks` filtering on:

- `status: ['todo', 'in_progress', 'blocked']` (not `done` / `archived`).
- `due_before: <now-iso>` (past the planned date).

```
listTasks({
  status: ['todo', 'in_progress', 'blocked'],
  due_before: '<current-iso-timestamp>',
  limit: 100,
})
```

Each row in the result is a candidate — past its `due` and still open. The compact projection now includes `attributes`, so the estimate is visible inline (e.g. `attributes.estimate_days`).

### 2. Find existing open commitments

For each slipped task, check whether a `commitment:sprint_variance` memory is already open for it — so you don't write a duplicate.

```
searchMemory({
  tags: ['commitment:open', 'commitment:sprint_variance', 'task:<task-uuid>'],
})
```

If a non-empty open commitment exists for the task, **skip** writing a new one — the lifecycle worker will resolve the existing row when the slip clears.

### 3. Write commitment memories for new slips

For each task with no existing open commitment, call `saveMemory`:

```
saveMemory({
  summary: 'Task "<title>" is <N> day(s) past its planned due of <due-iso>.',
  type: 'commitment',
  scope: 'workspace',
  tags: [
    'commitment:open',
    'commitment:sprint_variance',
    'task:<task-uuid>',         // REQUIRED — resolver reads this
    'due:<backstop-iso>',       // RECOMMENDED — deadline auto-close
    'sprint:<sprint-id>',       // RECOMMENDED if the task carries one
  ],
})
```

Tag conventions:

- **`task:<uuid>`** — REQUIRED. The sprint-variance resolver reads this to look up the task. Without it, the resolver can't decide and the commitment stays open until the deadline backstop fires.
- **`due:<iso>`** — RECOMMENDED. A backstop date after which the commitment auto-resolves even if the underlying slip never clears (e.g. the team gives up). The deadline resolver handles this. A reasonable backstop is 7–14 days from now.
- **`sprint:<id>`** — RECOMMENDED if the task carries one. Lets later queries group variance memories by sprint.

### 4. Summarize for the operator

Return a brief status:

- N tasks behind, M new commitments written, K existing commitments still open.
- Top 3 most-slipped (highest `now - due` delta).
- Optional suggestion (replan / close / nudge assignee) — only when explicitly asked, not on the silent daily cron.

## What NOT to do

- **Do not** write `commitment:sprint_variance` for tasks without a `due` date — they aren't tracked-against-a-plan.
- **Do not** write `commitment:sprint_variance` for tasks already `done` / `archived` — they're not slipping.
- **Do not** write `commitment:sprint_variance` without a `task:<uuid>` tag — the resolver needs it to look the task up.
- **Do not** manually supersede or close existing open commitments — the lifecycle worker owns resolution. Operator acknowledgement (a user action) supersedes through the standard memory flow.

## How the loop closes

After each task closes or replans, the next cron tick of the commitment-lifecycle worker scans `commitment:open` memories, calls the sprint-variance resolver, which reads the now-current task state via `getTaskByIdSystem`, and supersedes the open commitment with a `commitment:resolved` version stamping the reason. The resolved chain is visible via `getRowHistory` — that's the post-mortem of "what slipped, by how much, and when it cleared." Retrieving prior `commitment:sprint_variance` memories (open + resolved) during next sprint's planning turn brings the variance history into context — closing the feedback loop without a new primitive.
