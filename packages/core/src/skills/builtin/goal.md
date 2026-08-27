---
name: goal
description: Kick-start an autonomous goal in one message — turn "/goal <objective>" (or "set a goal to X and get it done") into a RUNNING self-terminating goal via setGoal + workTask, without doing the work inline.
license: MIT
compatibility: Designed for Use Brian
metadata:
  author: Use Brian
  category: productivity
  applies_to_app_type: any
  when_to_use: The user invoked the /goal slash command, or asked to "set a goal and work it until done" / "keep working on X autonomously until it's finished". NOT for one-off actions the assistant should just do now, and NOT for passive reminders.
  tags: official
---

# Goal kickstart

Turn the user's objective into a **running** autonomous goal. The goal driver then re-runs bounded work iterations in the background until the goal verifies done (or its budget exhausts), and delivers the result. Your job in THIS turn is only to mint and arm the goal - **never start doing the work inline**.

## Preconditions

- If `setGoal` / `workTask` are not among your tools, the goals capability is disabled for this assistant. Say exactly that and stop - do not improvise the work.
- If the objective is missing (bare `/goal`), ask ONE question: what the end state is. Stop until answered.

## Steps

1. **Compose the `outcome` (this is the whole briefing).** A verify-goal iteration sees ONLY this text, so make it self-contained (max 2000 chars): the end state, plus every concrete constraint and procedural step the user gave or that the flow obviously needs. Example for a web signup/registration: "fill the form via the browser; the site validates by email - immediately after requesting validation, read the connected inbox, open the validation link in the browser (links expire in minutes); then finish the remaining pages and save the confirmation/reference number."
2. **Choose `done_when`.** Default is `{"kind":"verify"}` (you claim completion later via `markGoalComplete`; an independent verifier checks the claim). Use `{"kind":"query","query":{"predicate":{"hostTaskDone":true}}}` only when binding to an existing task (`host_type: "task"`), or the `entityCount` predicate for "until N records exist" goals. Never invent other predicates - they never evaluate true and the goal cannot complete.
3. **Budget from the user's words.** Map "$20" → `max_spend`, "by Friday" → `deadline`, "max 10 tries" → `max_iterations`. If the user supplied ANY limit, pass exactly the limits they supplied; defaults do not fill missing siblings. If none were supplied, call `configureGoalDefaultBudget` with no arguments to read the effective workspace default, then omit all three fields so that default is copied at kickoff. Mention the effective budget in your reply so the user can object.
4. **Call `setGoal`.** It is created confirmed - no separate confirmation step is needed for a goal the user explicitly asked for.
5. **Immediately call `workTask`** with the returned goal id. Omit `workflow_id` for the default completion workflow. This arms the goal and starts the first driver tick.
6. **Reply with one short confirmation:** the goal id, the outcome in one line, the effective budget, and that progress is visible on the Goals board with the result delivered when it finishes or blocks. Nothing else - the driver owns the work from here.

## Anti-patterns

- Doing any of the actual work in this chat turn (browsing, drafting, sending). The driver does that across iterations.
- Calling `setGoal` without `workTask`: that mints a monitor that only watches `done_when` and never acts.
- A vague `outcome` ("handle my registration"): the iterations inherit exactly this text and nothing else, so vagueness here is vagueness forever.
