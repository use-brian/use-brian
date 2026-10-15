// Fixed acceptance inventory. Changes require review against the nine feature Goals.
export const CATALOGUE = {
  "schema": "operations-catalogue-v1",
  "dependencies": [
    {
      "id": "F01",
      "plan": "docs/plans/project-shared-spaces-implementation.md",
      "components": [
        "api/project-shared-governance",
        "access/project-shared-matrix",
        "app-web/project-shared-journey"
      ],
      "suites": [
        "packages/api/src/db/__tests__/project-shared-governance.integration.test.ts",
        "packages/api/src/context-scope/__tests__/project-shared-matrix.integration.test.ts",
        "apps/app-web/src/components/projects/__tests__/project-shared-journey.test.tsx"
      ],
      "scope": "required native implementation"
    },
    {
      "id": "F02",
      "plan": "docs/plans/project-brief-implementation.md",
      "components": [
        "api/brief-publication",
        "api/brief-context",
        "doc-sync/brief-publication",
        "app-web/brief-journey"
      ],
      "suites": [
        "packages/api/src/briefs/__tests__/publication.integration.test.ts",
        "packages/api/src/briefs/__tests__/context.integration.test.ts",
        "packages/api/src/goals/__tests__/driver.test.ts",
        "apps/doc-sync/src/__tests__/brief-publication.integration.test.ts",
        "apps/app-web/src/components/briefs/__tests__/brief-journey.test.tsx"
      ],
      "scope": "required native implementation"
    },
    {
      "id": "F03",
      "plan": "docs/plans/chat-first-actionable-briefs-and-human-follow-up.md",
      "components": [
        "tasks/responsibility",
        "api/task-responsibility",
        "api/brief-work",
        "app-web/brief-work"
      ],
      "suites": [
        "packages/core/src/tasks/__tests__/responsibility.test.ts",
        "packages/core/src/tasks/__tests__/tools.test.ts",
        "packages/api/src/tasks/__tests__/responsibility.test.ts",
        "packages/api/src/tasks/__tests__/responsibility.integration.test.ts",
        "packages/api/src/db/__tests__/goal-source-admission.integration.test.ts",
        "packages/api/src/__tests__/brain-entry-mutation.test.ts",
        "packages/api/src/brain-mcp/__tests__/brain-mcp.test.ts",
        "packages/api/src/briefs/__tests__/work.test.ts",
        "packages/api/src/briefs/__tests__/work.integration.test.ts",
        "apps/app-web/src/components/briefs/__tests__/brief-work.test.tsx",
        "apps/app-web/src/components/briefs/__tests__/brief-journey.test.tsx",
        "apps/app-web/src/lib/__tests__/suggested-landing.test.ts",
        "apps/app-web/src/lib/__tests__/surface-cache-invalidation.test.ts"
      ],
      "scope": "required native implementation"
    },
    {
      "id": "F04",
      "plan": "docs/plans/tasks-goals-resumable-execution-implementation.md",
      "components": [
        "goals/execution-qualification",
        "goals/execution-checkpoint",
        "goals/allowance-tree",
        "api/task-execution-control",
        "api/task-external-progress",
        "goals/execution-journeys",
        "app-web/task-execution-workbench"
      ],
      "suites": [
        "packages/core/src/goals/__tests__/execution.test.ts",
        "packages/api/src/goals/__tests__/execution-qualification.test.ts",
        "packages/api/src/goals/__tests__/execution-checkpoint.integration.test.ts",
        "packages/core/src/goals/__tests__/loop.test.ts",
        "packages/api/src/db/__tests__/goals-notify.test.ts",
        "packages/api/src/goals/__tests__/allowance-tree.integration.test.ts",
        "packages/api/src/tasks/__tests__/execution-control.integration.test.ts",
        "packages/api/src/tasks/__tests__/external-progress.integration.test.ts",
        "packages/api/src/goals/__tests__/execution-journeys.integration.test.ts",
        "apps/app-web/src/components/chat-app/__tests__/task-execution-workbench.test.tsx"
      ],
      "scope": "required native implementation"
    },
    {
      "id": "F05",
      "plan": "docs/plans/research-feedback-and-engine-improvement-implementation.md",
      "components": [
        "research/activity-contract",
        "api/research-delivery",
        "api/research-feedback",
        "api/research-source-authority",
        "api/research-learning",
        "api/research-commands",
        "evals/research-comparison",
        "app-web/research-detail"
      ],
      "suites": [
        "packages/core/src/research/__tests__/contracts.test.ts",
        "packages/api/src/research/__tests__/delivery.test.ts",
        "packages/api/src/research/__tests__/feedback.test.ts",
        "packages/api/src/research/__tests__/source-authority.integration.test.ts",
        "packages/api/src/research/__tests__/learning.integration.test.ts",
        "packages/api/src/research/__tests__/commands.test.ts",
        "packages/api/src/evals/research/__tests__/comparison.test.ts",
        "apps/app-web/src/components/chat-app/__tests__/research-detail.test.tsx"
      ],
      "scope": "required native implementation"
    },
    {
      "id": "F06",
      "plan": "docs/plans/operational-work-and-delegated-approvals-implementation.md",
      "components": [
        "approval-review/contracts",
        "api/approval-review-assignment",
        "api/approval-review-patterns",
        "api/approval-review-resolution",
        "api/approval-review-consumption",
        "api/operational-route-recovery",
        "app-web/approval-review-chat"
      ],
      "suites": [
        "packages/core/src/approval-review/__tests__/contracts.test.ts",
        "packages/api/src/approval-review/__tests__/assignment.integration.test.ts",
        "packages/api/src/approval-review/__tests__/patterns.integration.test.ts",
        "packages/api/src/approval-review/__tests__/resolution.integration.test.ts",
        "packages/api/src/approval-review/__tests__/consumption.test.ts",
        "packages/api/src/approval-review/__tests__/route-recovery.test.ts",
        "apps/app-web/src/components/chat-app/__tests__/approval-review-chat.test.tsx"
      ],
      "scope": "required native implementation"
    },
    {
      "id": "F07",
      "plan": "docs/plans/routine-work-intake-implementation.md",
      "components": [
        "tasks/routine-intake",
        "api/routine-intake",
        "api/routine-intake-execution",
        "api/routine-proposals",
        "app-web/routine-intake"
      ],
      "suites": [
        "packages/core/src/tasks/__tests__/routine-intake.test.ts",
        "packages/api/src/tasks/__tests__/routine-intake.integration.test.ts",
        "packages/api/src/tasks/__tests__/routine-intake-execution.integration.test.ts",
        "packages/api/src/tasks/__tests__/routine-proposals.integration.test.ts",
        "apps/app-web/src/components/workflow/__tests__/routine-intake.test.tsx"
      ],
      "scope": "required native implementation"
    },
    {
      "id": "F08",
      "plan": "docs/plans/engineering-history-capture-implementation.md",
      "components": [
        "api/engineering-history",
        "core/engineering-archive-isolation",
        "engineering-capture/collector"
      ],
      "suites": [
        "packages/api/src/db/__tests__/engineering-history-store.integration.test.ts",
        "packages/core/src/workspace-files/__tests__/engineering-archive-isolation.test.ts",
        "packages/api/src/engineering-history/__tests__/service.test.ts",
        "packages/engineering-capture/src/__tests__/cli.test.ts",
        "packages/engineering-capture/src/__tests__/delivery.test.ts",
        "packages/engineering-capture/src/__tests__/providers.test.ts",
        "packages/engineering-capture/src/__tests__/setup.test.ts",
        "packages/engineering-capture/src/__tests__/spool.test.ts"
      ],
      "scope": "archive isolation required; collector installation not_applicable (no capture required by four lanes)"
    },
    {
      "id": "F09",
      "plan": "docs/plans/client-delivery-oversight-implementation.md",
      "components": [
        "crm/delivery-oversight",
        "api/crm-delivery-oversight",
        "app-web/client-delivery-oversight"
      ],
      "suites": [
        "packages/core/src/crm/__tests__/delivery-oversight.test.ts",
        "packages/api/src/crm-operations/__tests__/delivery-oversight.test.ts",
        "packages/api/src/db/__tests__/crm-delivery-oversight.integration.test.ts",
        "apps/app-web/src/components/chat-app/__tests__/client-delivery-oversight.test.tsx"
      ],
      "scope": "required native implementation"
    }
  ],
  "suites": [
    {
      "file": "packages/api/src/db/__tests__/project-shared-governance.integration.test.ts",
      "component": "api/project-shared-governance",
      "assertions": [
        "provisions a Project, its restricted scope, creator ownership and the visible selection atomically (D17, D20, D21, D23)",
        "refuses an unavailable assistant before committing anything, and stays legacy while the capability is off",
        "Brian preselects the primary assistant unless deselected and discloses the exact roster before it runs",
        "REST and Brian share authority and errors: participants and outsiders cannot govern, a hidden Project is not_found",
        "the workspace owner sees governance metadata and reads the roster through oversight without joining (D26/D27)",
        "refuses a stale or concurrent roster change; no lost update and no duplicate edge",
        "keeps one accountable owner: last-owner removal refused, transfer is atomic, an owner edge cannot be removed",
        "recovers ownership at any time through the workspace owner only, keeping existing owners (D26)",
        "converts a legacy Project only through a reviewed, idempotent workspace-owner command that relabels nothing",
        "upgrade: an existing legacy Project keeps its meaning; linked material is counted, not relabelled, by the preview",
        "quarantine and capability disable make Project material unavailable (never General) and are reversible through product commands",
        "archive pauses bound unattended work and restore does not restart it; capability is the workspace owner's switch"
      ],
      "minimum": 12
    },
    {
      "file": "packages/api/src/context-scope/__tests__/project-shared-matrix.integration.test.ts",
      "component": "access/project-shared-matrix",
      "assertions": [
        "list and count lanes return exactly what the reference admits, for every reader",
        "the mutation floor and the store mutation predicate admit members only, never oversight (D27)",
        "an expired membership is no membership on every path",
        "disabling the capability makes Project material unavailable, never General; re-enabling restores it",
        "a workspace rolled back to the legacy read rule admits no Project-labelled row, even to an admin universe",
        "pages: a Project collection page is read by participants and the workspace owner, edited only by participants, inherited by children",
        "pages: publication and link tokens never widen Project material (unsupported release refused)",
        "aggregates and Project content: participants see counts and items, a nonparticipant admin sees nothing",
        "chats: a shared Project chat carries the label and follows admission; a private Project chat stays personal",
        "admission: a Project destination stamps the label, keeps source Departments, and refuses oversight and absent assistants",
        "doc-sync: the per-message page gate reads current admission; oversight connects read-only; removal disconnects",
        "a running turn bound to the Project is invalidated by removal and is never revived by a later re-invite",
        "losing the workspace-owner role ends oversight immediately; a frozen ceiling cannot gain a Project invited later",
        "relevance (D18): admitted to A and B, a turn about A injects no B material automatically; an explicit read still reaches B",
        "a turn whose assistant is not on the roster gets an actionable refusal, and disabling the capability contracts a live turn",
        "a label naming no shared scope in the row workspace is refused at write time"
      ],
      "minimum": 16
    },
    {
      "file": "apps/app-web/src/components/projects/__tests__/project-shared-journey.test.tsx",
      "component": "app-web/project-shared-journey",
      "assertions": [
        "creates with name and People/Assistants: primary Brian preselected and removable, nothing else implied",
        "shows an actionable message when the selected assistant is unavailable, and notes when no Brian exists",
        "gives owners roster controls with the current revision; participants see the roster only; oversight is disclosed separately",
        "reports a stale revision and a last-owner refusal without claiming success",
        "lets the workspace owner recover ownership with an audited reason, read-only otherwise",
        "converts a legacy Project only from an explicit reviewed selection, never preselected",
        "starts new Project chats shared by default with a visible private option; oversight starts private only",
        "files new Project pages in the collection: the destination reaches the wire and the rows never fall into Private",
        "keeps shared-space state inside the Project cache prefix the workspace_config signal invalidates"
      ],
      "minimum": 9
    },
    {
      "file": "packages/api/src/briefs/__tests__/publication.integration.test.ts",
      "component": "api/brief-publication",
      "assertions": [
        "a name-only Project home gets an empty, not-established Brief and nothing else",
        "a legacy description becomes a pending proposal, never accepted direction; a legacy Project has no Brief",
        "owner autosave changes only the private draft; the Page and accepted revision stay put",
        "participants and Brian propose with source evidence; a private source keeps the proposal private",
        "nonparticipants, oversight and unadmitted assistants cannot govern; Department Briefs follow Department authority",
        "the history and binding tables refuse direct writes and edits",
        "explicit Apply publishes Page, revision and history atomically exactly once; a replay returns the same receipt",
        "only an owner applies; Brian executes an owner's explicit Apply within its own admission",
        "stale and concurrent applications are refused without partial mutation",
        "every raw writer is refused: legacy CAS, raw snapshots, delete and move; Current context stays editable",
        "restoring history is a new reviewed change; a failed broadcast never fakes or loses acceptance",
        "the Brief pane (REST) and Brian (tools) share inputs, authority, conflicts and receipts",
        "Department Briefs bind only by explicit owner selection, grant no access, and refuse stale selection",
        "maintenance is source-backed and idempotent: repeats make zero writes, status comes from real work, foreign sources stay out",
        "a missing bound Page is repaired by an owner from accepted history, never manufactured",
        "legacy material is only offered: an adopted Page becomes a pending proposal, is never bound, and archive/restore keeps history"
      ],
      "minimum": 16
    },
    {
      "file": "packages/api/src/briefs/__tests__/context.integration.test.ts",
      "component": "api/brief-context",
      "assertions": [
        "two fresh chats follow the same accepted rules; pending text never appears; a later Apply reaches the next turn",
        "a name-only Project home grounds nothing invented; a Project with no Brief contributes nothing",
        "selected Department rules apply only by explicit binding and only where readable; otherwise a nonrevealing prerequisite blocks governed work",
        "a direction change refuses the next mutating action unless declared compatible; findings never interrupt; nothing is retried",
        "unattended work freezes its basis: an incompatible change refuses the next step before provider work; other Projects are untouched",
        "a Goal keeps its outcome and budget: it blocks on an incompatible change, refreshes on a compatible one, and recaptures when resumed",
        "contraction applies immediately: a removed participant or assistant reads no Brief, proposal or grounding",
        "a missing or unreadable Project Brief is a visible prerequisite, never a fallback to General or invented rules"
      ],
      "minimum": 8
    },
    {
      "file": "packages/api/src/goals/__tests__/driver.test.ts",
      "component": "api/brief-context",
      "assertions": [
        "completes the goal when done_when holds after the iteration (no re-arm)",
        "re-arms NOW when the run made progress but done_when is not yet met",
        "re-arms with BACKOFF when the run failed (no progress)",
        "advances the in-flight run (paused) next tick rather than stacking a new one",
        "accumulates spend across the handoff and blocks when maxSpend is exhausted",
        "blocks an acting goal when metering is unavailable, WITHOUT running a costly iteration",
        "blocks an unconfirmed goal and asks for clarification, without running work — autopilot enforcement",
        "is single-flight: a lost claim returns without dispatching",
        "installs the saved goal authority before claiming and keeps it through delivery",
        "does not claim a goal when its saved authoring authority is unavailable",
        "does not re-arm when explicit task deletion retires the running goal mid-iteration",
        "does not write back or deliver when deletion wins a terminal transition",
        "blocks when the workspace is over its budget (no iteration), and escalates",
        "blocks on an incompatible accepted Brief change before any iteration, leaving outcome and budget untouched",
        "runs the iteration when the workspace is UNDER its budget",
        "skips the workspace-budget gate entirely when no gate is wired (OSS)",
        "kickoff arms the first tick for an acting goal, and skips a no-means monitor goal",
        "parks on an EXTERNAL event: persists the full marker (subscriptions + state) and arms a far safety-net tick, not the 60s poll",
        "uses the goal deadline as the safety-net fire time when one is set",
        "distinguishes a paused run (60s poll, no marker) from an event park (safety tick + marker)",
        "clears a stale event-park marker after claiming the tick (the goal is acting now)",
        "resumeOnEvent clears the marker and schedules an immediate tick restoring the preserved loop state",
        "requires CRM admission and preserves the marker on an unavailable source gate",
        "schedules only after the CRM source claim accepts the exact marker",
        "blocks source authority loss without iteration, host writeback, delivery or automatic retries",
        "withholds an iteration result when its source authority contracts during execution",
        "resumeOnEvent is a no-op when the goal already un-parked (marker gone) — concurrent events resume once",
        "an errored tick releases the claim (active) and re-arms with backoff carrying errorStreak — never a dead chain",
        "backoff doubles with the carried errorStreak (capped at 15 min)",
        "gives up LOUDLY at the consecutive-error ceiling: blocked (tick_error) + delivered, no re-arm",
        "fires onTickError with willRetry on both paths",
        "a completed iteration resets the carried errorStreak to 0",
        "rethrows the ORIGINAL error when the recovery itself fails (the reaper is the backstop)",
        "kickoff applies DEFAULT_GOAL_BUDGET to a budget-less acting goal, and leaves an authored budget alone",
        "kickoff copies the workspace default onto a budget-less goal",
        "kickoff falls back to the built-in default when workspace-default lookup fails"
      ],
      "minimum": 36
    },
    {
      "file": "apps/doc-sync/src/__tests__/brief-publication.integration.test.ts",
      "component": "doc-sync/brief-publication",
      "assertions": [
        "refuses a live or offline-replayed Direction edit before broadcast; Current context edits flow and persist",
        "a publication reaches live tabs through the post-commit merge, and self-heals when the notice is missed",
        "the internal apply guard refuses an op batch that would change Direction and admits context ops"
      ],
      "minimum": 3
    },
    {
      "file": "apps/app-web/src/components/briefs/__tests__/brief-journey.test.tsx",
      "component": "app-web/brief-journey",
      "assertions": [
        "creates an empty Brief on demand in the viewer locale; nothing is generated from the name",
        "owner autosave stores only a draft; Apply direction is the explicit acceptance with no second dialog",
        "participants propose instead of applying; proposals stay labelled pending and stale ones cannot be applied",
        "history restores as a new proposal; Department rules are an explicit owner selection that grants no access",
        "workspace-owner oversight reads only; a missing Page offers the owner a repair from history; errors are typed",
        "the Project detail entry is compact: revision, rule basis and pending count, opening the pane on demand",
        "picks a task up into Chat as a draft only: the prompt travels in the one-shot handoff, never the URL"
      ],
      "minimum": 7
    },
    {
      "file": "packages/core/src/tasks/__tests__/responsibility.test.ts",
      "component": "tasks/responsibility",
      "assertions": [
        "reads person, assistant and unassigned executors from a row",
        "refuses a row or a patch that names a person AND an assistant as executor",
        "treats the executor as one slot: a person replaces an assistant and the reverse",
        "rejects a malformed home",
        "selecting a human follow-up never makes them the executor or stops the assistant",
        "clearing the contact leaves the executor alone, and changing the executor leaves the contact alone",
        "prefers the explicit contact, then the person executing",
        "routes assistant-only Department work to the current Department owners",
        "routes assistant-only independent Project work to the current Project owners",
        "re-resolves on an owner change instead of keeping the original owner",
        "discloses missing routing rather than guessing a human or an assistant",
        "puts unassigned Department work in its owners queue and invents nobody for other unassigned work",
        "shows unassigned Department work only to its eligible owners, with an assignment action",
        "lists a person their own task in My work",
        "gives an explicit human the assistant task question while the assistant stays executor",
        "shows a running assistant task in My work without inventing an attention issue",
        "raises a blocked hosted Goal on running assistant work as an actionable blocker",
        "raises blocked, in-review and overdue work into Needs you",
        "offers the author an explicit routing choice for unroutable assistant work, and nobody else",
        "never surfaces closed work",
        "orders explicit, parent, workflow default, none"
      ],
      "minimum": 21
    },
    {
      "file": "packages/core/src/tasks/__tests__/tools.test.ts",
      "component": "tasks/responsibility",
      "assertions": [
        "does not expose source_moment on a surface that has no recording",
        "exposes source_moment only when the fill passes a citation index",
        "stamps the cited moment onto the task",
        "keeps the task but drops a moment past the end of the transcript",
        "drops an impossible stamp the same way the record citations do",
        "leaves the moment null when the model omits it",
        "never stamps a moment on a surface without the widening",
        "creates a new task with defaults",
        "emits task_created event with the new task id",
        "respects assignee_id, due, tags, status, external_ref",
        "creates a sub-task when parent_id points at a same-workspace parent",
        "accepts parent_id: null at the schema boundary (no top-level task should be rejected)",
        "treats parent_id: null as a top-level task",
        "errors out when workspaceId is absent",
        "accepts offset, UTC-Z, and bare-date forms on saveTask",
        "rejects zoneless / non-ISO values with an actionable message",
        "stores the correct instant for an offset due (execute path)",
        "applies the same rule to updateTask.due and listTasks filters",
        "returns the full record including external_ref and created_at",
        "reports stored protection and distinguishes unknown from explicit General",
        "returns isError when the task is not found",
        "excludes archived by default",
        "includes archived when include_archived is true",
        "filters by status array",
        "accepts a status list the model serialised as a string",
        "still rejects an unknown status, and now says what was allowed",
        "filters by assignee + tag together",
        "returns the compact projection (no external_ref / created_at)",
        "emits task_listed with result count",
        "patches only the fields passed",
        "clears nullable fields when null is passed",
        "errors out when no fields are passed",
        "errors out when the task is not found",
        "closeTask sets status to done",
        "reopenTask sets status to todo",
        "emits task_updated event for status changes",
        "closeTask errors out when workspaceId is absent",
        "closes an exactly bound task when status updates are allowed",
        "denies a detail change when only status changes are allowed",
        "denies a task outside the target binding even when the operation is allowed",
        "keeps a historical target binding valid after the task id supersedes",
        "listTasks and getTask are read-only and concurrency-safe",
        "write tools are not read-only / concurrency-safe / require-confirmation",
        "all six task tools declare requiresCapability=\"tasks\"",
        "saveTask persists attributes and getTask returns them",
        "listTasks compact projection includes attributes",
        "updateTask overwrites the whole attributes object",
        "updateTask leaves attributes untouched when omitted (carry-forward)",
        "defaults to empty object when omitted at create time",
        "saveTask writes the body into attributes.description",
        "saveTask keeps description alongside user attribute keys",
        "updateTask merges the body onto the live bag, so siblings survive",
        "updateTask clears the body on null without touching siblings",
        "updateTask on an unknown id returns the supersession-aware recovery message",
        "saveTask threads depends_on into the store as dependsOn",
        "saveTask without depends_on leaves dependsOn undefined",
        "updateTask threads depends_on through fields.dependsOn",
        "updateTask without depends_on leaves fields.dependsOn undefined",
        "are confirmation-gated and capability-gated",
        "rejects an empty filter (would sweep the whole backlog) and an empty set",
        "previews explicit task ids as titles and readable changes",
        "previews archive targets and says when a filter currently matches nothing",
        "errors without a workspace",
        "updates only the rows matching the filter (incl. the unassigned + staleness post-filters)",
        "merges a priority set into each row's attributes without clobbering siblings",
        "archiveTasks is the archive shorthand and reports a no-match cleanly",
        "closes a shared task without making it private",
        "keeps a task shared when only the author's own conversation fed it",
        "keeps content drawn from a private row private to that user, never to one assistant",
        "refuses to write another person's private rows into a task",
        "closes, reopens and reassigns without importing unrelated Project or Team labels",
        "archives and changes bulk priority across Projects while retaining each target scope",
        "still refuses a content edit that would combine Projects",
        "reports partial commits separately from failures and retains the cause",
        "marks an all-unavailable bulk update as an error instead of claiming success",
        "does not label a committed update as failed when its event callback throws",
        "saveTask records an assistant executor, an explicit contact and a home, and getTask reads them back",
        "setting a contact never changes the assistant executor",
        "a person executor replaces an assistant executor (one slot)",
        "reports a refused responsibility change as a final error, not a crash",
        "if_unassigned claims once: idempotent for the same executor, refused for another",
        "uses the workflow default for root work, the parent for children, and an explicit choice first",
        "changes nothing outside a workflow run"
      ],
      "minimum": 83
    },
    {
      "file": "packages/api/src/tasks/__tests__/responsibility.test.ts",
      "component": "api/task-responsibility",
      "assertions": [
        "checks nothing when no responsibility value changed (a legacy row never fails an unrelated edit)",
        "checks only the changed executor and refuses an ineligible one with a typed error",
        "refuses an ineligible contact without widening anything",
        "re-checks the existing executor and contact against a new home",
        "refuses a home outside the actor and a Project home that is not the task Project",
        "clearing values needs no eligibility check",
        "claims an unassigned task for the acting person by member id",
        "is idempotent for the same claim and refuses a different holder",
        "refuses a task in another workspace and a missing task as not found"
      ],
      "minimum": 9
    },
    {
      "file": "packages/api/src/tasks/__tests__/responsibility.integration.test.ts",
      "component": "api/task-responsibility",
      "assertions": [
        "the workspace-match trigger refuses a foreign assistant executor on a plain insert",
        "refuses a person and an assistant executor in one write",
        "admits only an executor visible to the actor and admitted to the home",
        "refuses a home the actor does not belong to and a Project home that is not the task Project",
        "keeps the human contact independent of the assistant executor and carries all of it through supersession",
        "refuses a contact who cannot see the task or is not admitted to its home",
        "treats the executor as one slot and retires only automatic drafts when it changes",
        "lets racing owners claim one unassigned task exactly once, idempotently, through a stale id",
        "claims for an admitted assistant and refuses one that is not admitted",
        "resolves fallback owners from current ownership: changes and departures re-route",
        "leaves a legacy task home unknown through ordinary edits; nothing is backfilled"
      ],
      "minimum": 11
    },
    {
      "file": "packages/api/src/db/__tests__/goal-source-admission.integration.test.ts",
      "component": "api/task-responsibility",
      "assertions": [
        "uses executing actor, canonical input and finite durable consent, not historical creator",
        "one attempt, lost acknowledgment, concurrent recapture cannot duplicate a goal",
        "does not accept JSON proof, runtime absence, actor substitution, or revoked mutation",
        "keeps inherited old binding across mode/default changes; omission inherits but explicit null conflicts",
        "workspace barrier observes a winning source update; no stale source capture",
        "withholds derived goal reads when source authority is revoked",
        "clips the actual producer to saved finite source authority, and does not renew it on retry",
        "retains a single Project; rejects explicit null, runtime removal and archived Project",
        "native tool with only UUID/session/model snapshot is explicitly rejected, not treated as attended proof",
        "a membership revoke winning the workspace barrier blocks insertion with the old token",
        "ready uses canonical task data and executing actor, never the legacy create branch",
        "legacy retains the original judge/store path for the selected executor and no saved proof",
        "legacy drafts nothing when the selected executor is not usable, and never substitutes another assistant",
        "legacy activation during the judge rejects at canonical insertion without reauthoring",
        "ready downgrade during the judge rejects its proof without legacy fallback",
        "mode projection rejects a nonmember before assistant lookup or judge",
        "ready rechecks membership after mode projection before producing",
        "ready missing runtime proof does not fall back to the legacy store",
        "actual taskStore.onTaskCreate invokes the same adapter with current actor; dedup emits once at max:1",
        "ready without an assistant explicitly rejects before capabilities or judge"
      ],
      "minimum": 20
    },
    {
      "file": "packages/api/src/__tests__/brain-entry-mutation.test.ts",
      "component": "api/task-responsibility",
      "assertions": [
        "hides another user's personal visibility-double row from discovery/read",
        "hides rows above the acting viewer clearance",
        "checks workspace membership before reading or writing the target",
        "keeps temporary read reach useful without turning it into mutation authority",
        "returns not-found rather than stale when the bound row disappeared",
        "fails a stale confirmed preview before any writer runs",
        "applies an assistant-owned memory through the same non-redirecting path",
        "forwards the typed fields to the canonical update, which validates them",
        "rejects malformed values before writing",
        "returns a refused responsibility change as its typed status, not a 500"
      ],
      "minimum": 10
    },
    {
      "file": "packages/api/src/brain-mcp/__tests__/brain-mcp.test.ts",
      "component": "api/task-responsibility",
      "assertions": [
        "advertises native Association tools only for current app/set grants and credential scope",
        "rechecks Association permission in a direct MCP call after discovery",
        "gates managed delivery discovery on CRM read/write grants and credential scope",
        "discovers credential lifecycle only with authenticated parent evidence and all write grants",
        "keeps generic plan/event configuration behind configure plus CRM write and write scope",
        "a read_write key exposes every read tool plus every write tool",
        "a read key sees only the read tools — no write surface",
        "every tool carries a description and a non-empty input schema",
        "renames the bridged retrieval `search` to `searchBrain`",
        "keeps searchKnowledge as a deprecated alias but ingestToBrain is now a first-class extraction tool",
        "omits every file tool when no fileTools are wired (files-less deployment)",
        "a read key sees the file reads but never the file writes",
        "accepts a valid key and resolves its workspace + scope",
        "rejects a missing Authorization header",
        "acts as the key issuer, and refuses the key once the issuer has left the workspace",
        "rejects changed Brain-key context and admission evidence on retained authentication",
        "rejects a header without the Bearer scheme",
        "rejects an sk_live_ public-API key",
        "rejects a well-formed token the store never issued",
        "rejects a revoked key",
        "rejects a tampered secret",
        "attributes an OAuth token to the consenting user",
        "retains exact Home-app token and live-grant proof without trusting copied auth metadata",
        "the bridged saveMemory receives a UUID-shaped sessionId, not a \"brain-key:...\" label",
        "the bridged saveMemory context seeds the sensitivity accumulator at the effective clearance (primary capped by max_clearance)",
        "every bridged tool in one request shares the same UUID sessionId (resolver memoization)",
        "ingestToBrain falls back to a direct saveMemory (scope: \"team\") when no ingestor is wired",
        "ingestToBrain defaults to the Pipeline B ingestor when one is wired (smart decomposition)",
        "ingestToBrain with decompose:false uses the direct saveMemory path even when an ingestor is wired",
        "ingestToBrain routed mode delegates one message to the capture router without calling immediate ingest",
        "ingestToBrain routed mode fails before routing when eventId is missing",
        "a bridged file write receives the resolved workspace + programmatic context at the key clearance",
        "renders a schema failure as `path: message` lines, never the ZodError issues JSON",
        "a throw from execute() is caught and rendered through the same chokepoint (isError, no raw JSON)",
        "agent reads ride both scopes; agent writes need read_write + the configure gate",
        "without agentTools the surface is unchanged (data-plane only)",
        "filters hosted operator tools out of tools/list until the bound assistant has the grant",
        "effectiveBrainClearance: NULL cap = primary governs; a cap takes the min",
        "an uncapped key inherits the full primary authority: clearance, kind, capabilities",
        "a key capped below the primary reads and writes at the cap (no-silent-widening posture)",
        "readPage is exposed on a read key; editPage/deletePage/createPage are NOT",
        "editPage, deletePage and createPage appear only on a read_write key",
        "omits the whole page surface when no docTools are wired",
        "doc-page handlers run inside the agent-principal wrap (teamspace agent access)",
        "createPage mints a new page via createDraft and returns its id",
        "createPage rejects an empty title",
        "createPage without a parent files a top-level page (nestParentId null)",
        "createPage nests under a valid same-workspace parent",
        "createPage rejects a parentPageId the principal cannot see",
        "createPage refuses a parent in another workspace",
        "readPage by id returns the page as Markdown",
        "readPage by title returns content for a single match",
        "readPage by title lists matches (no content) when several pages match",
        "listPages is exposed on a read key",
        "listPages returns every page as a { pageId, title } row, newest first",
        "listPages filters by a case-insensitive titlePrefix",
        "listPages reports an empty result for a prefix that matches nothing",
        "editPage append confirms access then applies a CAS patch",
        "editPage writes Markdown tables through the live Yjs gateway instead of legacy CAS",
        "editPage never falls through to legacy CAS when the live gateway fails",
        "editPage surfaces a concurrent-edit conflict when applyPatch returns null",
        "editPage refuses a page the key cannot access (null read)",
        "deletePage confirms access then calls the RLS-scoped remove",
        "deletePage refuses (and never removes) a page the key cannot access",
        "listPageTemplates is a read tool; createPageFromTemplate is read_write only",
        "the template tools are omitted when no docTools are wired",
        "listPageTemplates returns the catalog with ids",
        "createPageFromTemplate seeds a page (with icon) via createDraft",
        "createPageFromTemplate honors a title override",
        "createPageFromTemplate rejects an unknown templateId without writing",
        "listPageTemplates appends workspace custom templates when the store is wired",
        "createPageFromTemplate resolves a custom template id via the store (fresh ids)",
        "createPageTemplate is omitted unless the pageTemplateStore is wired",
        "createPageTemplate is a write tool (absent on a read key)",
        "createPageTemplate persists a template via the store and returns its id",
        "createPageTemplate rejects an empty name without writing",
        "createPageTemplate rejects content that yields no blocks",
        "exposes getBrand on a read key and saveBrandDraft only on a write key",
        "renames the chat write tool rather than exposing a second one",
        "exposes no approve or activate tool on any scope",
        "says in the write tool description that it cannot approve",
        "omits the whole brand surface when the tools are not wired",
        "the uniform 401 names both accepted credential forms, the refresh path, and where a key comes from",
        "a revoked key gets the SAME 401 body as a malformed one — the remedy travels, the discrimination does not",
        "a transport failure returns 500 with the credential explicitly cleared and a bounded retry verdict",
        "exposes executor, follow-up, home and the guarded claim, and passes them to the same store command"
      ],
      "minimum": 86
    },
    {
      "file": "packages/api/src/briefs/__tests__/work.test.ts",
      "component": "api/brief-work",
      "assertions": [
        "sorts visible rows into one section each and counts exactly what it returns",
        "distinguishes an authoritative empty queue from an unavailable source",
        "reads only: every statement is a SELECT and nothing reaches a model",
        "treats a non-member as not found",
        "answers 503 work_unavailable when a source fails, never an empty queue",
        "validates the claim body and maps a taken task to 409",
        "notifies other tabs after a successful claim",
        "rejects an invalid owner kind as not found"
      ],
      "minimum": 8
    },
    {
      "file": "packages/api/src/briefs/__tests__/work.integration.test.ts",
      "component": "api/brief-work",
      "assertions": [
        "puts unassigned Department work in its owner queue only, with counts equal to rows",
        "lists a person their own work and raises an overdue item into Needs you",
        "gives the explicit human the assistant task, and its blocked Goal, while the assistant stays executor",
        "routes assistant-only work to the current Department owner and re-routes on an owner change",
        "uses Project ownership for assistant work in an independent shared Project",
        "discloses missing routing to the person who started unroutable assistant work",
        "drops a protected task from both rows and counts once the viewer loses clearance",
        "drops resolved work and never writes on read"
      ],
      "minimum": 8
    },
    {
      "file": "apps/app-web/src/components/briefs/__tests__/brief-work.test.tsx",
      "component": "app-web/brief-work",
      "assertions": [
        "renders each section with counts equal to its rows, and the reason, executor and follow-up of each card",
        "claims an owner-queue task for the viewer through the guarded command and removes the card at once",
        "assigns an owner-queue task to an assistant chosen from the roster, never an app assistant",
        "shows a typed error when someone else already took the task, and keeps the card",
        "lets the person who started unroutable assistant work follow up through the canonical adjust",
        "answers in Approvals and opens the real task; chat pickup is draft-only and only offered when wired",
        "keeps controls as real buttons and links with phone tap targets",
        "separates unavailable, stale and empty",
        "shows only the composer above it for an empty queue, and records the landing watermark",
        "fills the composer with a task-bound draft and links a picked scope to its Brief",
        "maps every dock attention kind to its canonical destination"
      ],
      "minimum": 11
    },
    {
      "file": "apps/app-web/src/lib/__tests__/suggested-landing.test.ts",
      "component": "app-web/brief-work",
      "assertions": [],
      "minimum": 1
    },
    {
      "file": "packages/core/src/goals/__tests__/execution.test.ts",
      "component": "goals/execution-qualification",
      "assertions": [
        "is ready only when every required operation and account is really present",
        "keeps missing input, sparse context, inaccessible sources and executor loss distinct",
        "waits on open, missing or cancelled prerequisites without calling them done",
        "accepts only a human assignment as trusted provenance",
        "requires new checked evidence for progress; a reworded or shrunken checkpoint is not progress",
        "stops a blocker immediately and caps no-progress at 3 and transient faults at 5",
        "counts outstanding reservations against headroom",
        "estimates from observed history, else a bounded default",
        "accepts a complete plan and rejects anything else"
      ],
      "minimum": 9
    },
    {
      "file": "packages/api/src/goals/__tests__/execution-qualification.test.ts",
      "component": "goals/execution-qualification",
      "assertions": [
        "R01: human or unassigned work is not qualified and never reaches a planner",
        "R01: plans for the selected assistant and surfaces an unusable executor without substitution",
        "R02: carries grounded sources and asks consequential intent instead of inventing scope",
        "R03: a missing operation, account or source blocks; a confident plan cannot pass on labels",
        "R03: an unclear outcome from the clarity gate becomes a question, not a pass",
        "R04: arms ready assigned work once through the canonical goal path for the assigning human",
        "R04: a duplicate event, missing provenance or prose mention never arms",
        "R04: work that is not ready is recorded with its smallest missing thing and stays unarmed",
        "R18: an authority capture failure blocks honestly instead of leasing fresh authority",
        "R13: carries the task-specific completion evidence into the goal brief"
      ],
      "minimum": 10
    },
    {
      "file": "packages/api/src/goals/__tests__/execution-checkpoint.integration.test.ts",
      "component": "goals/execution-checkpoint",
      "assertions": [
        "counts a completed run with no new evidence as no progress and stops at the limit",
        "stops immediately on a known blocker and keeps it through a continue",
        "treats a parked run as a real wait, not a stall",
        "recovers a crashed attempt from the ledger without a fresh allowance",
        "fences a stale write-back after Pause and keeps committed and uncertain effects",
        "completes only on checked evidence for every chosen criterion",
        "follows task supersession for native and external lanes",
        "retires on deletion and on reassignment without reviving the host or losing history",
        "hides a protected execution from rows, children and receipts under RLS"
      ],
      "minimum": 9
    },
    {
      "file": "packages/core/src/goals/__tests__/loop.test.ts",
      "component": "goals/execution-checkpoint",
      "assertions": [
        "BARRIER: blocks pre-iteration when metering is unavailable — never runs",
        "a monitor goal (no means) is exempt from the metering barrier and never runs an iteration",
        "done_when met -> finish done",
        "progress, not yet met -> running then active, re-arm now",
        "no progress, not met -> re-arm after backoff",
        "over budget (maxIterations) -> finish blocked with reason",
        "finishes blocked with the runtime reason unless done_when is met",
        "neither finishes nor re-arms a fenced iteration"
      ],
      "minimum": 8
    },
    {
      "file": "packages/api/src/db/__tests__/goals-notify.test.ts",
      "component": "goals/execution-checkpoint",
      "assertions": [
        "keeps legacy rows inert until a current authoring principal is captured",
        "createGoal emits create with the new row id and its workspace",
        "updateGoalSystem (amend / confirm) emits update",
        "setGoalStatusSystem emits update, and stays silent on a missing row",
        "transitionRunningGoalStatusSystem emits only when the guarded transition landed",
        "stampGoalCompletionSystem and narrowGoalContextSystem emit update",
        "the host-task cascade emits once per retired goal from the returned rows",
        "an injected transaction executor that returns no rows still retires the goals, silently",
        "the per-tick claim NEVER emits (it would be a heartbeat, not a change)"
      ],
      "minimum": 9
    },
    {
      "file": "packages/api/src/goals/__tests__/allowance-tree.integration.test.ts",
      "component": "goals/allowance-tree",
      "assertions": [
        "creates one pool per root and returns the existing pursuit to a duplicate entry",
        "serializes concurrent reservations so branches cannot each spend the remainder",
        "caps the spend reservation by what is left in the active segment",
        "derives a child idempotently into the root pool; a human-owned child waits",
        "reconciles actual metered spend by delta across ticks of one run",
        "never treats missing metering as zero spend",
        "renews once per distinct human intervention and keeps lifetime use",
        "reconciles late use to its originating segment after a renewal",
        "enforces human-only renewal, immutable receipts and monotonic revisions in the schema"
      ],
      "minimum": 9
    },
    {
      "file": "packages/api/src/tasks/__tests__/execution-control.integration.test.ts",
      "component": "api/task-execution-control",
      "assertions": [
        "lets roster members and the workspace owner (oversight) control shared Project work",
        "refuses a workspace member outside the Project, a revoked member, a non-member and a quarantined scope",
        "hides a private task execution from other members entirely",
        "renews once per human intervention; replays, stale revisions and forged origins renew nothing",
        "steers only the selected branch and keeps a paused sibling paused",
        "treats only an attended Brian turn as human intent",
        "a task without a shared Project keeps native member authority"
      ],
      "minimum": 7
    },
    {
      "file": "packages/api/src/tasks/__tests__/external-progress.integration.test.ts",
      "component": "api/task-external-progress",
      "assertions": [
        "binds idempotently, keeps sessions separate, and records claims as claims",
        "deduplicates by event id and only advances on a higher sequence",
        "never renews, completes, reassigns or arms native work",
        "follows task supersession and refuses a reporter that cannot read the task",
        "derives freshness from the last report",
        "takes the reporter identity from the authenticated MCP credential, not the payload"
      ],
      "minimum": 6
    },
    {
      "file": "packages/api/src/goals/__tests__/execution-journeys.integration.test.ts",
      "component": "goals/execution-journeys",
      "assertions": [
        "success: starts once on assignment, checks availability, books, and completes on the checked receipt",
        "known blocker: a missing booking operation is reported precisely and nothing is armed",
        "pause, uncertain submission and resume: no duplicate booking, renewal by the person only",
        "outcome unmet: a closed task without the booking receipt is not done",
        "budget pause keeps partial research; one human continue renews once and finishes in the same pool",
        "known blocker during the run stops immediately; a cosmetic replan is not progress",
        "waits on a human-owned document task and wakes only when it really completes",
        "a missing send account blocks before anything is drafted or sent",
        "a prepared draft with an uncertain send stays partial",
        "human-owned external work is tracked from reports and never pursued natively"
      ],
      "minimum": 10
    },
    {
      "file": "apps/app-web/src/components/chat-app/__tests__/task-execution-workbench.test.tsx",
      "component": "app-web/task-execution-workbench",
      "assertions": [
        "shows plan, sources, WIP, branches, allowance and external freshness without sending anything",
        "sends controls with the displayed revision and a fresh intervention id",
        "reloads on a stale receipt and reports a refusal or a denial",
        "is view-only for a reader who cannot control, and offers nothing on a finished execution",
        "revalidates on the event spine and replaces revoked data instead of keeping it",
        "distinguishes an unavailable read from an empty one"
      ],
      "minimum": 6
    },
    {
      "file": "packages/core/src/research/__tests__/contracts.test.ts",
      "component": "research/activity-contract",
      "assertions": [
        "accepts only structured canonical write results",
        "never turns errors, failed edits, wrong shapes or prose ids into receipts",
        "derives saved only from verified receipts",
        "keeps ambiguous and conflicting follow-ups uncertain",
        "maps labels to a quality vector whose unknowns stay null",
        "links exact selection and exact reply to the right activity",
        "keeps multiple outputs and unrecognized follow-ups unlinked",
        "links a single same-chat result as a continuation",
        "one inferred event only suggests",
        "three consistent events on two activities within 30 days activate a personal or Project habit",
        "replays, several labels on one output, uncertain, stale and old events never inflate support",
        "admits scope only when the evidence fits it",
        "refuses lessons that touch goals, budgets, authorization or release"
      ],
      "minimum": 13
    },
    {
      "file": "packages/api/src/research/__tests__/delivery.test.ts",
      "component": "api/research-delivery",
      "assertions": [
        "R01: authors one default Page through the canonical writer and links it only after inspection",
        "R02: an explicit native write is used instead of a new report; editing an existing page is a revision",
        "R03: a failed save keeps partial findings and gaps with a recovery reason, never saved",
        "R03: false ids, narration and error results never create saved delivery",
        "R03: an interrupted turn with nothing gathered fails honestly and writes no page",
        "R04: internal, external and browser reads inform one result; found links stay uninspected; workers cannot write",
        "R16: a confidential floor is passed to the writer, which may refuse",
        "titles a report from its request"
      ],
      "minimum": 8
    },
    {
      "file": "packages/api/src/research/__tests__/feedback.test.ts",
      "component": "api/research-feedback",
      "assertions": [
        "R05: links a single same-chat result with its output version and the max-of-sources floor",
        "R05: exact reply and explicit selection pick the right one of several outputs; otherwise nothing links",
        "R05: a hidden activity cannot be selected, and an unrelated message in a research chat stays unlinked",
        "R06: an explicit follow-up with no clear meaning is recorded as uncertain, not as a verdict",
        "R07: records once across replay; external principals, assistants and quoted text cannot speak for the member",
        "R07: replay records a missed member follow-up once and skips other speakers",
        "reads only text blocks and keys the output by its saved artifact version"
      ],
      "minimum": 7
    },
    {
      "file": "packages/api/src/research/__tests__/source-authority.integration.test.ts",
      "component": "api/research-source-authority",
      "assertions": [
        "R01: saves one canonical Project page, links it, and a fresh admitted chat can find and inspect it",
        "R08: list, count and detail admit the session audience and live Project members only",
        "R08: a follow-up stays private to its source message even when the activity is shared",
        "R08: a held or edited source message stops counting and disappears from views",
        "R08: deleting the page drops its link and the Project leg; a Department floor hides the activity",
        "R18: erasure and session deletion remove activities, links and follow-ups; trace cleanup does not",
        "R18: the app role cannot write research rows directly",
        "R18: every research table is flush-classified and a workspace flush removes research rows and lessons"
      ],
      "minimum": 8
    },
    {
      "file": "packages/api/src/research/__tests__/learning.integration.test.ts",
      "component": "api/research-learning",
      "assertions": [
        "R09: one inferred event suggests; three consistent events on distinct activities activate; replay cannot inflate",
        "R09: refuses uncited, uncertain, ineligible or prohibited proposals whole",
        "R10: a user lesson follows its user across assistants; others, external principals and non-research paths never see it",
        "R10: a Project lesson reaches only admitted research in that Project",
        "R11: a qualified company method stays proposed until a current workspace owner accepts it directly",
        "R12: retire stops application and suppresses re-proposal; a corrected or removed support withdraws it",
        "R12: erasing the supporting messages removes the lesson from every future turn",
        "R16: the daily worker reflects only new eligible evidence and converges on one rule"
      ],
      "minimum": 8
    },
    {
      "file": "packages/api/src/research/__tests__/commands.test.ts",
      "component": "api/research-commands",
      "assertions": [
        "R13: a correction goes through the same service on every surface; another member only disagrees",
        "R13: stale revisions and hidden targets fail the same way on every surface",
        "R13: lesson decisions carry the real actor: an unattended assistant and a key are never human",
        "R13: an assistant acting on its own cannot correct, nominate or record",
        "R14: nomination requires visible evidence and links native work; it records a pattern, not the evidence",
        "R14/R15: trace bundles are recomputed as locally verified; reports stay reported; an opaque pass is refused",
        "R13: artifact inspection reads through the viewer on REST, Brian and MCP alike"
      ],
      "minimum": 7
    },
    {
      "file": "packages/api/src/evals/research/__tests__/comparison.test.ts",
      "component": "evals/research-comparison",
      "assertions": [
        "R15: compares matching identities per split, keeps unknown apart and surfaces new hard failures",
        "R15: refuses mismatched dataset, judge, same-engine and unknown-case comparisons",
        "R15: keeps revisions of one report family out of both target and held-out splits",
        "R15: dry run and offline compare make zero model or network calls; cost stays unknown when undeclared",
        "R16: collection needs the preflight and an explicit confirmation, and refuses live cases by default",
        "R16: the configured-provider adapter runs the real loop with the deep budget, current tools and metering",
        "R14: a publishable case uses fabricated identities and data; real-looking values are refused"
      ],
      "minimum": 7
    },
    {
      "file": "apps/app-web/src/components/chat-app/__tests__/research-detail.test.tsx",
      "component": "app-web/research-detail",
      "assertions": [
        "R17: shows status, artifacts, read vs found sources, gaps, uncertain follow-ups and scoped lessons",
        "R17: correcting a label sends the shown version and refreshes; a stale version explains and reloads",
        "R17: company review needs the confirmation-free approve; retire and reject confirm first; forbidden is explained",
        "R17: a revoked or deleted result evicts what was shown",
        "R14/R17: nominating an improvement cites this result's follow-ups and activity",
        "R17: the card and every action keep phone tap targets; inputs keep a 16px phone font",
        "R17: chat replies pick up saved research across tabs through the research signal",
        "R17: a research change on another tab or device reaches this one through the workspace event spine",
        "R17: every locale carries the research copy without em dashes"
      ],
      "minimum": 9
    },
    {
      "file": "packages/core/src/approval-review/__tests__/contracts.test.ts",
      "component": "approval-review/contracts",
      "assertions": [
        "derives a workflow-step descriptor from frozen facts, executor identity when no account",
        "leaves a request without workflow identity, identity or action unresolved",
        "derives a browser-send descriptor per skill version, profile and target; drift/ceiling/legacy are unresolved",
        "classifies payments, transfers, account deletion, security and bulk destructive actions",
        "gives normally allowed actions no category (no extra gate)",
        "matches only the same workflow, step definition, identity, action and parameters",
        "accepts a varying field only within its explicit human rule",
        "never treats a recipient or attachment as free text, and keys lineages by policy",
        "qualifies on three distinct human chains",
        "ignores duplicates in one chain, AI decisions and withdrawn approvals",
        "a human denial contradicts, and only evidence after a revocation counts",
        "has no reviewer unless one was assigned",
        "prefers request over task over session over the workflow default",
        "ignores revoked assignments and assignments made by anyone but the approver",
        "prefers an available nonlocal route for always-on work, intended first within a class",
        "fences the lost route and only accepts same-account, permitted, available alternatives",
        "reconciles an uncertain effect instead of retrying, and needs a binding"
      ],
      "minimum": 17
    },
    {
      "file": "packages/api/src/approval-review/__tests__/assignment.integration.test.ts",
      "component": "api/approval-review-assignment",
      "assertions": [
        "A01: no reviewer by default, even for a configure-enabled primary assistant",
        "A01: an explicit workflow default applies to its owner-approved requests; a request override wins",
        "A13: only an authenticated human can assign; MCP and unattended callers cannot fabricate delegation",
        "A02: the reviewer must hold configure; granting configure never appoints a reviewer",
        "A02/A09: a reviewer outside the request Project or above its clearance is not admitted",
        "only the delegating human (the approver / owner) may delegate; others are refused without leaking existence",
        "replays an idempotency key, refuses a different payload under it, and keeps one active reviewer per scope",
        "changes are revision-checked and delegator-only; revocation is audited and stops the default",
        "A09: assignment reads follow the scope source (a private task assignment is invisible to others)",
        "A14: the request lane leaves normal human approval untouched",
        "REST: the authenticated user is the actor; body-asserted actors are refused",
        "Brian: only an attended human turn can assign; unattended, relayed or MCP callers are refused"
      ],
      "minimum": 12
    },
    {
      "file": "packages/api/src/approval-review/__tests__/patterns.integration.test.ts",
      "component": "api/approval-review-patterns",
      "assertions": [
        "A03: three distinct human-approved executions activate one lineage",
        "A03: approvals within one execution chain count once",
        "A03/A08: a human denial suspends the lineage; only revocation plus fresh evidence requalifies",
        "A04/A08: a changed step definition suspends the old lineage and starts a new one",
        "A04: different parameters, executor identity or approver policy build different lineages",
        "A05: human-only actions never become patterns",
        "A09: pattern inspection is source-filtered and revocation needs a human with standing"
      ],
      "minimum": 7
    },
    {
      "file": "packages/api/src/approval-review/__tests__/resolution.integration.test.ts",
      "component": "api/approval-review-resolution",
      "assertions": [
        "A06: resolves an exact active pattern with a delegated receipt and no forged human evidence",
        "A01/A04: no assignment, an unqualified pattern or a mismatch leaves the request pending with reasons",
        "A02: the reviewer must currently hold configure, and only the assigned reviewer may run its tool path",
        "A05: human-only actions stay human even with an assignment and an active pattern",
        "A07: one canonical decision wins any race; replays return the receipt; denials are never overwritten",
        "A08: no routine pattern expiry; revocation, changed definition, lost configure or lost access stop consumption",
        "A10: the workflow continuation uses the original executor, never the primary, and revalidates before the effect",
        "A10: a browser terminal send is approved for the runner only while its receipt validates",
        "lists waiting requests with their reviewer, clears on resolution, records decisions, and hides others",
        "surfaces an open route blocker until a route is selected, with no reminder or send"
      ],
      "minimum": 10
    },
    {
      "file": "packages/api/src/approval-review/__tests__/consumption.test.ts",
      "component": "api/approval-review-consumption",
      "assertions": [
        "runs the gated tool with the original executor and its own kind, never resolving the primary",
        "fails attributably without an original executor instead of borrowing the primary",
        "stops before the effect when current delegated authority no longer holds",
        "refuses anything that is not a delegated approval (no bare approved-status execution)",
        "never applies a staged write on a delegated decision",
        "reports a delegated browser send as approved only while its receipt validates"
      ],
      "minimum": 6
    },
    {
      "file": "packages/api/src/approval-review/__tests__/route-recovery.test.ts",
      "component": "api/operational-route-recovery",
      "assertions": [
        "binds only actual native identities, derives locality, and checks connector accounts",
        "local loss before the effect fences that path and continues on a sufficient admitted route",
        "an uncertain send reconciles before any retry; no route is probed",
        "a wrong account or no available alternative retains the work as a blocker",
        "a completed effect needs no route and records nothing"
      ],
      "minimum": 5
    },
    {
      "file": "apps/app-web/src/components/chat-app/__tests__/approval-review-chat.test.tsx",
      "component": "app-web/approval-review-chat",
      "assertions": [
        "badges unseen items, marks them seen on open and narrows the list to this chat's Project",
        "asks the assigned reviewer and reports the server's decision, never its own",
        "assigns a reviewer to exactly this request with a fresh idempotency key",
        "shows decisions made on the person's behalf and route blockers with links to the real work",
        "a failed load is an error with retry, never an empty list; the approval signal refreshes",
        "revokes a pattern only after confirmation, with its expected revision",
        "the workflow default is an explicit assignment; no reviewer by default",
        "removes an existing workflow reviewer through revocation",
        "carries the copy in all four locales, without em dashes, and maps unknown reasons"
      ],
      "minimum": 9
    },
    {
      "file": "packages/core/src/tasks/__tests__/routine-intake.test.ts",
      "component": "tasks/routine-intake",
      "assertions": [
        "keeps legacy definitions off and round-trips optional typed configuration",
        "keeps missing and inherited values missing",
        "rejects duplicate input keys",
        "keeps unresolved drafts separate from activation and never guesses a home/executor",
        "rejects a mismatched operating home",
        "includes all material fields but ignores presentation layout",
        "tracks confirmed partial work without changing its quality or ordinary extraction readiness",
        "refuses missing evidence, judge failure and an absent outcome",
        "retains deny, tombstone, strong and ambiguous duplicate gates",
        "does not let the specialized policy result turn unverified/non-work into a mandate"
      ],
      "minimum": 10
    },
    {
      "file": "packages/api/src/tasks/__tests__/routine-intake.integration.test.ts",
      "component": "api/routine-intake",
      "assertions": [
        "I01/I10: Project home and source floors survive intake independently of Department membership",
        "creates one canonical root with the configured home/executor and actual event basis",
        "tracks permitted partial inputs truthfully; stronger workspace tracking requirements still hold",
        "returns one receipt under concurrent/replayed signals and keeps different bound outcomes separate",
        "fences queued intake across disable/re-enable, while resolving an already committed receipt after disable",
        "rolls back the canonical Task if its receipt cannot commit, then safely retries",
        "retains current deny/tombstone/duplicate rules and rejects changed source input",
        "keeps receipts on canonical supersession and enforces their source floor in native metadata consumers",
        "rechecks the chosen assistant at write and never substitutes the authoring assistant",
        "keeps an explicitly selected person as ordinary tracking and refuses a person outside a private input",
        "rejects a real admitted event that does not match the accepted source predicate",
        "keeps legacy workflows off; an inactive exact draft becomes configured only through a live human session",
        "fences ordinary model/CRUD configuration writes, preserves layout edits and disable/re-enable",
        "rejects stale/racing exact drafts and changed idempotency payloads",
        "refuses fabricated model/tool human proof and a revoked human session",
        "I12: a missing native prerequisite fails the actual schema guard before any intake receipt can be written",
        "cannot manufacture engine receipts or routine approval rows through the non-bypass app role",
        "retains private source floors in proposals and accepted workflow readers, then removes them on revocation",
        "cannot make a manual run carry a client-fabricated routine context",
        "increments only the internal intake fence on disable/enable and participates in native flush"
      ],
      "minimum": 20
    },
    {
      "file": "packages/api/src/tasks/__tests__/routine-intake-execution.integration.test.ts",
      "component": "api/routine-intake-execution",
      "assertions": [
        "I07/I12: material executor edits never retarget an existing Task or refresh its original allowance",
        "I06/I12: reviewed disable/re-enable and event replay cannot clear a Task pause or renew its allowance",
        "I01/I09: ready entry arms the selected executor through canonical Goal writers and meters planning on one root pool",
        "I01/I12: ready access mode uses real inherited Goal means and tick writers, without a human-configuration fallback",
        "I03/I04/I06: one admitted waiting question, then an attributed answer continues after disable on the same pool",
        "I03/I04: no admitted chat is a visible routing blocker; human-owned work creates no AI pursuit",
        "I04/I10: source revocation hides the question, rejects continuation, and fences an already armed Goal lease",
        "I04: losing a required capability leaves an honest blocker without arming",
        "I09: a necessary child shares the root allowance and cannot multiply the limit",
        "I05/I06: replay recovers the initial handoff after Task commit, without reauthoring after disable",
        "I12: cancelling a Task-bound question pauses its native state without renewing or resuming a chat tool",
        "I03: an explicit continue replaces the stale question, while replay keeps one current pickup",
        "I12: questions, execution and the original allowance follow the canonical Task head",
        "I05/I12: a human pause fences an in-flight planner, including replay, while late usage stays in the original pool",
        "I03: the native runner consumes intake once and never also executes definition steps"
      ],
      "minimum": 15
    },
    {
      "file": "packages/api/src/tasks/__tests__/routine-proposals.integration.test.ts",
      "component": "api/routine-proposals",
      "assertions": [
        "I02/I07: human apply checks actual selected-assistant capability, registry and connected-account availability",
        "I07/I11: authenticated REST uses the exact same inactive proposal and live-human apply services",
        "I08/I10: origin Chat pickup uses the actual admitted session and preserves its personal/source floors",
        "I02/I11: Brian/agent raw tools cannot apply until actual human staged review, with no borrowed assistant grant",
        "I07/I11: attended Chat decisions require durable exact human approval and cannot reuse a changed input",
        "I08: actual Task reads accumulate distinct admitted cases into one inactive contextual proposal without scanning or activation",
        "I08: absence of current Configure authority keeps observed repetition conversational only",
        "I08: reserves one inactive proposal and creates no workflow, run, Task intake or allowance before human apply",
        "I01/I07: exact live human apply atomically creates the canonical workflow and records actual attribution once",
        "I07: a failed canonical insert rolls back the decision and can be retried without duplicate activation",
        "I08: rejection is an attributed idempotent decision and never materializes the proposed workflow",
        "I02: incomplete configuration remains a draft and a fabricated human/tool receipt cannot apply it",
        "I10: private support floors cover raw app-role counts/detail and source revocation hides and fences the proposal",
        "I02: non-bypass app writers cannot mint decision proof or a canonical transaction capability"
      ],
      "minimum": 14
    },
    {
      "file": "apps/app-web/src/components/workflow/__tests__/routine-intake.test.tsx",
      "component": "app-web/routine-intake",
      "assertions": [
        "I07/I11: applies only after an explicit click using the inspected revision and one idempotency key",
        "I08: rejection uses the same exact decision boundary",
        "I10: current source denial evicts private configuration and removes decisions",
        "I11: editor saves an inactive proposal using its saved baseline revision and explains disable",
        "I10/I11: origin Chat pickup requests only the admitted session projection",
        "I11: all four dictionaries have the same complete copy and no banned dash"
      ],
      "minimum": 6
    },
    {
      "file": "packages/api/src/db/__tests__/engineering-history-store.integration.test.ts",
      "component": "api/engineering-history",
      "assertions": [
        "EH01/EH02/EH05 publishes exact original once with stable native receipt and no extraction",
        "EH04/EH08 rejects publication-time key revocation without completed receipt",
        "EH08 retains pending original across blob failure and reconciles one File on replay",
        "EH05/EH08 lost commit acknowledgement reconciles the existing canonical original and receipt",
        "EH08 quota refusal stores no blob and preserves pending original for supported recovery",
        "EH01/EH04 disabled/unconfigured and lower-clearance captures fail without fallback or publication",
        "EH07 old extraction SQL cannot claim archives and profile edits hold pending purpose",
        "EH10 native deletion erases projection and keeps a non-content replay tombstone",
        "EH03 ordinary discovery, ingest, derivation and original mutation all refuse archives",
        "EH04 native admission permits collaborators and revokes reads immediately",
        "EH04 read-only writes fail before any source storage, including direct service calls",
        "EH10 a held original withholds the index without becoming operational on replay",
        "EH01/EH04 configured ready profiles publish through real key and saved Department admission",
        "EH04 key revocation withholds existing original bytes and index for admitted readers",
        "EH04 shared Project membership and owner oversight retain Department restrictions",
        "EH09/EH10 shared history preserves original export, annotations, versions and canonical erasure",
        "EH09 scoped cursors, original JSONL partial failure and read-only commands disclose only admitted events",
        "EH01 configuration inherits the selected assistant and fails readiness after key revocation",
        "EH09 HTTP authenticates real web users and registers static JSONL export before event ids",
        "EH04/EH10 HTTP recovery preserves queued bytes until the actual issuer confirms a strict idempotent command",
        "EH06 equal source sessions across keys/providers retain identity without borrowing another audience",
        "EH10 exclusion is versioned/idempotent and prevents source replay from restoring visibility",
        "EH04 native private File and source-user revocation withhold original search/read/export",
        "EH04 capture-assistant Department revocation blocks new capture and hides original history",
        "EH07/EH10 configuration cascade cannot erase WIP; actor-owned discard is isolated and idempotent",
        "EH10 completed originals keep replay identity after native batch cleanup",
        "EH08/EH10 issuer discard during blob I/O prevents canonical publication and replay resurrection",
        "EH07 enqueue sequence preserves navigation when publication completes out of order"
      ],
      "minimum": 28
    },
    {
      "file": "packages/core/src/workspace-files/__tests__/engineering-archive-isolation.test.ts",
      "component": "core/engineering-archive-isolation",
      "assertions": [
        "excludes archive paths, names and summaries even if a legacy adapter supplied them"
      ],
      "minimum": 1
    },
    {
      "file": "packages/core/src/crm/__tests__/delivery-oversight.test.ts",
      "component": "crm/delivery-oversight",
      "assertions": [
        "CO01/CO02 recognises an authenticated existing agreement without creating or requiring work",
        "CO02 refuses spoofed actors, absent acceptance and unresolved clients",
        "CO02/CO09 binds exact quote selectors and revision",
        "CO03 due dates, absent updates and a gap do not diagnose failure or recommend work",
        "CO04 preserves attributable, dated reported completion",
        "CO04 verified delivery requires actual outcome evidence",
        "CO05 narrow reported issue permits only one linked inspect action",
        "CO05 conflicts and candidate recognition suppress persuasive outcome/advice",
        "CO06 bounds evidence at 20 and discloses incomplete outcome coverage",
        "CO07 commands reject actors, clearance, verified flags and recipients",
        "CO03/CO05 dates and absent updates cannot be relabelled as supported delay",
        "CO04/CO05 newer outcome evidence supersedes dated issues and newer issues withhold old completion",
        "CO04 unrelated outcome evidence cannot verify this commitment",
        "CO10 archive descendants cannot match agreement evidence",
        "CO12 direct invocation and discovery share the CRM capability gate",
        "CO02/CO12 attended current input resolves native source, never a fabricated Episode",
        "CO07/CO12 recognition review uses exact attended approval metadata without converting the assistant into a human"
      ],
      "minimum": 17
    },
    {
      "file": "packages/api/src/crm-operations/__tests__/delivery-oversight.test.ts",
      "component": "api/crm-delivery-oversight",
      "assertions": [
        "CO07 read-only input cannot open a transaction or invoke prohibited writers",
        "CO07 transport actor spoofing and command execution fields fail before storage"
      ],
      "minimum": 2
    },
    {
      "file": "packages/api/src/db/__tests__/crm-delivery-oversight.integration.test.ts",
      "component": "api/crm-delivery-oversight",
      "assertions": [
        "CO01/CO02/CO07 records once without Task/Goal/terms/message side effects and binds receipts",
        "CO02 assistant drafts, suggestions, spoofed actors and missing client identity stay review candidates",
        "CO08 non-superuser RLS enforces Project/private/current source and shared audience before rows and counts",
        "CO04/CO09 human updates remain reports; review/withdraw/replay preserve versions and original evidence",
        "CO08 Department and clearance floors survive current source and direct app-role reads",
        "CO09 concurrent once-only recording and transaction failure do not leave partial projection/history",
        "CO10 excludes engineering Episode inputs before projection even for an authorized reader",
        "CO10 excludes operational descendants of a real admitted engineering archive without producing observations or advice",
        "CO06/CO07/CO09/CO12 real source processing freezes and applies recognition once without model replay or new work",
        "CO08 read-only/foreign actor and assistant missing turn authority cannot mutate",
        "CO01/CO03/CO04/CO05 preserves native work and bounded reported issues without treating closure as delivery",
        "CO06/CO08 lists at most 50 admitted records and 20 evidence references with honest cursors",
        "CO02/CO08 governed acceptance retains the accepted request audience as well as the native deal",
        "CO02/CO09/CO12 exact persisted attended approval permits human interpretation and rejects changed arguments",
        "CO08/CO09/CO12 real HTTP and authenticated MCP share source authority, strict schemas, receipts and key revocation",
        "CO04 admitted outcome receipt supports delivery, parent File revocation removes that claim",
        "CO09 changed native text invalidates old content and supersedes it once under the new revision"
      ],
      "minimum": 17
    },
    {
      "file": "apps/app-web/src/components/chat-app/__tests__/client-delivery-oversight.test.tsx",
      "component": "app-web/client-delivery-oversight",
      "assertions": [
        "CO03/CO11 elapsed date and unobserved work stay quiet; update is draft-only without a recipient",
        "CO04/CO05 renders attributable report time and partial coverage without verified delivery",
        "CO12 correction is versioned and never applied by autosaving text",
        "CO09 uncertain human retry preserves the exact command identity and payload",
        "CO09 cancel and repeated clicks cannot apply a pending human review",
        "CO08 pending review is aborted when its protected scope disappears",
        "CO08 delayed old-scope evidence cannot reappear after navigation",
        "CO08 scope navigation and viewer switches cannot retain protected detail",
        "CO08 current-content expiry removes quotes and update controls while offline",
        "CO12 refusal and empty remain distinct"
      ],
      "minimum": 10
    },
    {
      "file": "apps/app-web/src/lib/__tests__/surface-cache-invalidation.test.ts",
      "component": "app-web/brief-work",
      "assertions": [
        "marks the viewer-scoped module state on workspace configuration changes",
        "maps the brain primitives to the Tasks list, every CRM region and the graph",
        "marks the Knowledge sources list on a brain change (kb_chunk is a brain primitive)",
        "maps the orchestration primitives to their surfaces",
        "routes the session primitive to the Chat rail's two lists (the spine gap report E named)",
        "marks the Live roster on every signal that changes what is running or about to",
        "marks the Feed shell's record on a workspace rename and on an assistant change (report E's Feed gate row)",
        "every listened event has at least one prefix, and every prefix is workspace-first",
        "returns nothing for an event it does not know (a newer client vocabulary must not throw)",
        "an approval change marks the home dock (the Suggested badge, Home pane and workspace root read it)",
        "a task or approval change marks every work scope and the dock (resolved cards leave everywhere)",
        "an authority change evicts cached work instead of keeping protected cards painted",
        "a workspace_config change marks the Settings detail row (name, icon, purpose, roster)",
        "BRAIN_REFRESH_EVENT makes tasks:<wid> and crm:<wid>: stale and keeps their rows",
        "ignores an event that names a different workspace, applies the catch-up shape",
        "a catch-up identity refresh keeps access data painted; a real one purges",
        "GOAL_REFRESH_EVENT marks the board, the triage queue and every goal detail",
        "OFFICE_REFRESH_EVENT marks the Office list and the template library, never an open editor's snapshot",
        "a goal change keeps the board's rows while it revalidates, per status slot",
        "a custom-app change marks the app strip AND every open app's session (renderable state, entry URL)",
        "brain changes mark the entity / entry / blueprint detail keys; skill changes mark the skill editor's",
        "[COMP:app-web/surface-cache-invalidation] purges only the changed workspace media",
        "[COMP:app-web/surface-cache-invalidation] purges the bounded member directory on authority and profile signals",
        "[COMP:app-web/surface-cache-invalidation] purges only the changed workspace page directory on authority signals",
        "[COMP:app-web/surface-cache-invalidation] clears project counts on access changes while catch-up preserves the painted view"
      ],
      "minimum": 25
    },
    {
      "file": "packages/api/src/operations-readiness/__tests__/pilot-lanes.integration.test.ts",
      "component": "api/operations-v1-readiness",
      "assertions": [
        "V03 research saves a source receipt and Chat reference; a fresh chat binds follow-up and failed acquisition stays partial",
        "V04 administration requires native approval and produces exactly one fake provider effect receipt",
        "V04 V08 restart retains uncertain effect WIP and the original allowance without a duplicate write",
        "V05 scheduled calendar preparation saves grounded Brief and Task work; inaccessible sources stay unknown",
        "V06 native routine replay creates one Task but refuses unverified mailbox events without delivery or new work",
        "V07 app-role RLS refuses cross-workspace and revoked Project research disclosure",
        "V09 four fictional materializations validate current native definition and trigger schemas without activating anything",
        "V11 owned fixture execution makes zero remote calls or paid model calls and only fake effects"
      ],
      "minimum": 8
    },
    {
      "file": "packages/api/src/engineering-history/__tests__/service.test.ts",
      "component": "api/engineering-history",
      "assertions": [
        "does not normalize whitespace and canonicalizes metadata key order for identity",
        "requires native configuration without reaching any fallback"
      ],
      "minimum": 2
    },
    {
      "file": "packages/engineering-capture/src/__tests__/cli.test.ts",
      "component": "engineering-capture/collector",
      "assertions": [
        "EH05/EH12/EH13 concurrent initial hook processes retain every submission and neutral output without altering setup",
        "EH13 package-manager symlink entrypoints run inspect-only setup and neutral hooks",
        "EH13 missing configuration never blocks the coding application or leaks hook content",
        "EH12 keeps a real leased worker alive while a future scheduled receipt retains WIP"
      ],
      "minimum": 4
    },
    {
      "file": "packages/engineering-capture/src/__tests__/delivery.test.ts",
      "component": "engineering-capture/collector",
      "assertions": [
        "EH12 offline failure retains original id; restart delivers only a typed archived receipt",
        "EH08 rejects a prose success or incomplete archived receipt without deleting WIP",
        "EH12 keeps queued acknowledgement pending rather than counting it as archived",
        "EH12 permanent HTTP authentication denial suspends without logging provider text",
        "EH07 held receipts suspend replay and retain the original for configuration review",
        "EH06/EH12 changed credential/configuration suspends before replay until explicitly accepted",
        "EH12 retry exhaustion is visible suspension with original identity retained"
      ],
      "minimum": 7
    },
    {
      "file": "packages/engineering-capture/src/__tests__/providers.test.ts",
      "component": "engineering-capture/collector",
      "assertions": [
        "EH11 has honest missing final output, interruption and unknown schema diagnostics",
        "EH06 treats submitted author/origin claims as unverified and distinguishes documented source identity"
      ],
      "minimum": 2
    },
    {
      "file": "packages/engineering-capture/src/__tests__/setup.test.ts",
      "component": "engineering-capture/collector",
      "assertions": [
        "EH13 requires explicit scope and credential reference, rejects secret-bearing endpoint configuration"
      ],
      "minimum": 1
    },
    {
      "file": "packages/engineering-capture/src/__tests__/spool.test.ts",
      "component": "engineering-capture/collector",
      "assertions": [
        "EH05/EH12 survives restart, preserves ordering and distinguishes repeated submissions without source ids",
        "EH05 stable provider ids reconcile replay and conflict on changed selected payload",
        "EH12 leases are exclusive across processes/handles and expire after interrupted delivery",
        "EH12 bounds queue/payload, preserves WIP on failures and suspends permanent denial",
        "EH13 refuses repository-local state and never copies a credential into status"
      ],
      "minimum": 5
    }
  ],
  "cases": [
    {
      "id": "V01",
      "description": "Current dependency ledger"
    },
    {
      "id": "V02",
      "description": "Evidence integrity"
    },
    {
      "id": "V03",
      "description": "Research"
    },
    {
      "id": "V04",
      "description": "Administration"
    },
    {
      "id": "V05",
      "description": "Meeting preparation"
    },
    {
      "id": "V06",
      "description": "CoS email screening"
    },
    {
      "id": "V07",
      "description": "Plane and source isolation"
    },
    {
      "id": "V08",
      "description": "Continuity and spend"
    },
    {
      "id": "V09",
      "description": "Inactive configuration"
    },
    {
      "id": "V10",
      "description": "Release truth"
    },
    {
      "id": "V11",
      "description": "No production effects"
    },
    {
      "id": "V12",
      "description": "Integration boundaries"
    },
    {
      "id": "V13",
      "description": "Operator bundle"
    },
    {
      "id": "V14",
      "description": "Reproducibility"
    }
  ]
}

function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
freeze(CATALOGUE)
