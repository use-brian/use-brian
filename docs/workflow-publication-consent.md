# Workflow prepared-output publication consent

The workflow detail page has a separate publication-consent panel beside its steps. Consent is never part of editable workflow JSON and is never granted by save, run, or destination selection. The panel uses the saved definition, not the draft. Unsaved changes and in-flight saves block grants.

GET `/api/workflows/:id/publication-consents` supplies `canManage`, `workflowUpdatedAt`, `consentVersion` (a nonempty numeric string), `eligibleStepIds`, and consent metadata. Only the creator who remains a workspace owner/admin can grant consent. The API returns only the viewer's own consent; revocation remains available after role demotion, saved-version mismatch, or unsaved edits. The server determines eligibility: an unmanaged, non-external-client workflow's assistant_call step without question/questionResponse, with a fixed Telegram negative numeric chat (optional topic) and explicit integration, never replyToTrigger.

POST `/api/workflows/:id/steps/:stepId/publication-consent` sends only `{ acknowledged: true, workflowUpdatedAt, consentVersion }` after explicit confirmation. DELETE at the same path revokes. Both return the GET shape. Approval uses the consent generation captured by GET before confirmation, preventing an older dialog from regranting consent after revocation. Server errors are shown as safe localized guidance, never arbitrary response text.

Confirmation identifies the saved step and exact integration/destination and warns that prepared output can disclose the creator's private information. This does not give subscribers memory access or guarantee secrecy. Other users' private sources remain forbidden; destination clearance and Team/Project restrictions remain enforced. Consent expires after 30 days, every workflow update invalidates it, and reapproval applies only to new runs.

The viewer/workspace/workflow-scoped surface cache holds only consent metadata. Workflow refresh signals, saved version changes, and returning to a visible tab refresh it. Failed or refreshing reads block actions. Confirmation is cancelled if the saved version, draft state, or authority read changes. No private source excerpts, generated output, or server diagnostics are rendered.

All copy is localized in English, Japanese, Traditional Chinese, and Simplified Chinese. Controls remain visible and touch-sized.

## Delivery enforcement

Keep the destination's audience approval accurate (not “Only me” when there are other subscribers). Publication consent separately permits prepared text to use the approving creator's private sources; it does not change the destination's sensitivity limit or source permissions.

The engine supplies the run and step identities. Both consult preflight and final Telegram dispatch check the saved workflow revision, current creator/admin authority, current integration and audience, run start time, and original provenance with current source restrictions. Questions, failure notifications, interactive consults, arbitrary tool sends, and external clients cannot use this consent. Consent-backed delivery retains the result and original source evidence in the workflow and persists the approval ID in the successful step outcome and audit event. It deliberately creates no extra delivery-session transcript: mixed-source provenance must not be dropped to manufacture an independently readable copy. Ordinary non-publication delivery persistence is unchanged.

Migration `616_workflow_publication_consents.sql` adds server-only RLS tables for consent history and generation checks. PostgreSQL advisory locks serialize grants/revocations against dispatch; stale confirmations return HTTP 409. Publication requires `PG_POOL_MAX >= 2` (the default is 4), reserving a connection for live authority checks while dispatch holds its lock. Apply the migration before deploying the API.

## Component map (scoped task)

| COMP tag | Doc | Source | Tests |
| --- | --- | --- | --- |
| app-web/workflow-publication-consent | docs/workflow-publication-consent.md | apps/app-web/src/components/workflow/publication-consent.tsx; apps/app-web/src/lib/api/workflow-publication-consent.ts | apps/app-web/src/components/workflow/__tests__/publication-consent.test.tsx; apps/app-web/src/lib/__tests__/workflow-publication-consent.test.ts |
| workflow/publication-consent | docs/workflow-publication-consent.md | packages/api/src/workflow/publication-consent.ts; packages/api/src/workflow/channel-delivery.ts | packages/api/src/workflow/__tests__/publication-consent.test.ts; packages/api/src/workflow/__tests__/publication-consent.integration.test.ts; packages/api/src/workflow/__tests__/channel-delivery.test.ts |
| api/workflow-publication | docs/workflow-publication-consent.md | packages/api/src/routes/workflow-publication.ts | packages/api/src/routes/__tests__/workflow-publication.test.ts |

A publishing dispatch already in progress may finish before revocation completes. After revoke returns, no future send can use the revoked consent.
