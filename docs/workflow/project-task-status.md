# Send a message when a Project task changes status

Brian’s **Task** event source is internal: a committed task write can start a
workflow without an HTTP request. The separate **Webhook** trigger is an
inbound, signed HTTP endpoint for events sent by another system. You do not
need to provision a webhook for Brian tasks. These subscriptions follow the
normal Brian task write path (for example, status edits in Brain), not raw SQL
or application record patches that bypass task lifecycle publishing.

1. In the workflow builder, select **Event**, add **Tasks** as a source, and
   select **Task status changed** under **Watch for**.
2. Under **Task home Projects (optional)**, add one or more shared Projects. The task must have one of those
   Projects as its explicit Home *after* the write. Tags, the workflow’s own
   Project, and task visibility scope do not substitute for Home. No selected
   Projects means any Home. Multiple choices within one filter are ORed;
   different filters on the same subscription are ANDed.
3. Add a **Tool call** step for `getTask` with `id` set to
   `{{input.event.taskId}}`. Turn on **Send output to a channel** for that
   step, select a fixed, connected destination, and set **Notification message** to:

   ```text
   {{input.event.title}}: {{input.event.previousStatus}} → {{input.event.status}}
   ```

   When the read succeeds, Brian renders the template and attempts delivery.
   There is no `assistant_call` step and no model call at runtime. Check the
   step’s delivery outcome in run history: a completed step alone does not
   mean the message was sent. The existing channel audience checks still
   apply; choose a destination (including a verified personal chat where
   supported) that is approved to receive the task data. Web is not a push
   destination.

The authoring shape for the trigger is:

```json
{
  "kind": "event",
  "event": {
    "sources": [{
      "source": { "type": "task" },
      "match": {
        "inChannels": ["status_changed"],
        "taskProjectIds": ["97cc10ca-74bb-4aa2-bfb7-619203cb1297"]
      }
    }]
  }
}
```

`status_changed` catches all actual transitions, including movement into
review or archive. Creation, a repeated status, and edits to other fields do
not count. Existing actions, including `completed`, `blocked`, `reopened`, and
`updated`, retain their meanings. `status_changed` appears in
`input.event.actions`; the primary `input.event.action` remains unchanged.
To include automated writes, opt in with `match.fromBots: true`; avoid doing
this when the workflow itself changes matching task statuses. Project filters
only select events and do not grant the workflow access to a task or bypass
channel delivery policy.
