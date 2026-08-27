---
name: seo-geo-task-executor
description: Safely claim, execute, verify, and terminate Brian-routed GEO action tasks, including the bounded watchdog path for abandoned queued or running actions.
license: MIT
compatibility: Designed for Use Brian
metadata:
  author: Use Brian
  category: productivity
  applies_to_app_type: any
  when_to_use: Enforced by the GEO Brian Action Executor or Action Watchdog workflow. Operate only on a task whose live tags and Project context satisfy the workflow trigger.
  tags: official
---

# GEO Brian action executor

Operate only on the live task supplied by the workflow. Use only tools explicitly granted to the workflow step. If a required tool or authority is absent, block the task with the exact missing requirement; never hunt for a replacement capability or ask for a secret value.

## Eligibility and claim

Read the task by its live event ID. It is eligible only when its current tags include all of:

- `geo:action`
- `geo:route:brian`
- one `geo:site:*`
- one `geo:key:*`
- `geo:queued`

It must belong to the workflow's frozen Project. If any invariant is absent, do not mutate it and return an ineligible result.

Claim once by changing status to `in_progress`, replacing `geo:queued` with `geo:running`, and recording the originating workflow run in the description/result metadata. Every task update may return a new live ID; use that returned ID for the next mutation or re-resolve before editing. Never retry a stale ID.

## Authority boundary

Allowed work is bounded, reversible, internal workspace work named in the task: research, drafting, scorecard/page maintenance, and similar actions whose result can be read back. Follow the task's `Allowed actions` and `Done when` literally.

Always block rather than:

- edit source code or configuration;
- deploy, publish, merge, or request indexing;
- contact an external person or perform outreach;
- expose, move, request, or invent a secret;
- bypass an approval or permission;
- make a brand, product, pricing, legal, or strategic decision for a human; or
- start unbounded or newly paid work.

Do not automatically retry a task already marked blocked.

## Execute and verify

1. Re-read Objective, Evidence, Allowed actions, Done when, Dependencies, and Links.
2. Confirm every dependency and required tool/authority before mutation outside the task itself.
3. Perform only the bounded action.
4. Read the affected page/record/task back or use another explicit verification named in `Done when`.
5. Preserve a compact evidence trail; never copy a full provider payload or secret into the task.

## Terminal state

Exactly one terminal outcome is required.

For success, change status to `done`, retain the route/site/key tags, remove `geo:running`, and append:

- `Result:` what changed;
- `Verification:` what was read back and why it satisfies Done when;
- `Originating run:` the source workflow run link/id.

For a blocker, change status to `blocked`, retain the route/site/key tags, remove `geo:running`, and append:

- `Blocker:` the exact missing authority/input/capability;
- `Work completed:` safe work already finished, or `none`;
- `Input/action required:` the smallest human or coding action that unblocks it;
- `Originating run:` the source workflow run link/id.

Do not claim completion without read-back verification. Do not leave a claimed task in progress when the step ends.

## Watchdog mode

The hourly watchdog lists Brian-routed tasks and considers only current `geo:queued` or `geo:running` tasks. A task is abandoned only when more than two hours have elapsed since its last progress evidence. Do not use age since creation when a later progress update exists.

For each abandoned task, set status to `blocked`, remove queued/running state tags, and record `Blocker: execution made no progress for more than two hours`, any safe work already visible, and the required manual review/retry action. Do not execute the underlying task in watchdog mode. The task lifecycle notifier owns Slack delivery.
