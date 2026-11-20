# Fictional CRM workflow recipes

`scripts/crm/fixtures/association-workflows.json` provides five disabled
workflow definitions with sample inputs and fake read results. Use the normal
workflow editor/API to review a copy, bind catalog IDs and select permissions.
The file never installs itself or enables sending. Sample IDs, people, addresses
and channels are fictional. `sampleVars` are test evidence, never inputs to a
live workflow: live reads populate those variables.

| Recipe | Binding and behavior |
|---|---|
| Submission notification | Subscribe to committed `crm.submission.received`; bind an approved operator-notice purpose, mailbox and operator address. One frozen notice uses the domain-event UUID as its delivery id and requires review. Add an intake-definition tag filter when only one form should notify. |
| Event registration | Manual typed `recordCrmParticipation` with a stable registration source id. Use an unconstrained event. Ticketed or capacity-limited events reject this generic mutation. |
| Membership onboarding | Subscribe to `crm.entitlement.changed`, re-read current effective access for the contact/plan, then create a normal task only when the active event still has effective membership. The task carries `crm_contact_id` and entitlement attribution. No paid status is inferred from the event text. |
| Weekly deal digest | Bind a deal segment and operator channel. The optional prose step may use only CRM segment reads, follows every page and reports incomplete reads. It cannot change deals or authorize outreach. |
| Managed outreach | Manual contact, recipient, stable delivery UUID and frozen subject/body; preview sendability, then require review. The shared delivery service rechecks every recipient at dispatch, including after approval. A preview or audience snapshot is not continuing permission. |

Every recipe needs the relevant assistant CRM read/write and Tasks grants;
mailbox access is separate from CRM write authority. The normal tool registry
and workspace policy decide whether each tool is available. Review missing
permissions in the owner interface; a workflow cannot grant them to itself.
Association is retired. These recipes use the independent generic CRM operations;
Association commerce commands are no longer available.

Workflow start replay is keyed by the committed CRM domain-event identity. Keep
that identity through retries. A lost delivery response must reuse the same
frozen delivery id and inspect the receipt. Do not retry an uncertain task step
as a fresh workflow to force another task; inspect the existing workflow run and
task admission result. A genuinely separate message needs a distinct stable
id established before the first attempt. Never mutate a receipt's envelope to
reuse an id for a different recipient or message.

The local fixture checks definition/trigger shape, actual typed tool arguments,
effective-access and sendability branch behavior, source identity and privacy
attribution. Tool-registry integration and the full fake workflow/channel run
are separate acceptance checks. No model call, live mail, installed workflow or
staff acceptance is claimed by schema tests. Bind real accounts/policies and
perform the controlled staff/outage exercises only in the operator's approved
QA workspace.
