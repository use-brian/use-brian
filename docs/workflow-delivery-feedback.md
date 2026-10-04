# Workflow delivery feedback

Workflow run step rows show delivery outcomes separately from generation status.
Only a recognized `__delivery` record confirms delivery, skipping, or failure.
Missing delivery metadata makes no delivery claim; malformed or unknown records
show an unavailable status. Raw output remains available in a collapsed disclosure,
including on steps that are not completed.

`delivery_audience_unverified` preserves the authorizer's optional coarse `detail`
in the step outcome, audit event and workflow log. The summary maps only these
known codes to localized guidance, with a workspace-scoped Studio Channels link:

- `unbound`: no audience approval covers the destination for restricted output.
- `personal_group_unverified`: Brian could not prove the approved personal
  recipient is the destination's only human; check linked accounts, membership
  and bot permissions, or use a verified personal DM.
- `evidence_exceeds_audience`: the workflow context exceeds the destination's
  approval. Public approval permits only unrestricted public output, independently
  of integration clearance. Review destination clearance and Team/Project grants;
  personal context still requires a verified personal recipient.

Missing details (including older runs) and unknown details retain the generic
explanation. Arbitrary detail strings are never rendered in the summary. No
source names, Team/Project identifiers or private evidence are added to outcomes,
and authorization behavior is unchanged.

Enabled step delivery, failure delivery (the same field), trigger replies, and
schedule delivery show audience guidance. Links use the route workspace only
when it is a single string; standalone editors without route context still show
guidance and do not manufacture a workspace URL.

Web is not offered for new targets. A saved web target remains visible with a
warning and its saved identifier, without a misleading custom destination editor.
Users can explicitly disable delivery or change platforms. Rendering never mutates
the saved target.

Verification: workflow component and route Vitest suites, plus app-web TypeScript
checking. Focused tests live in `delivery-feedback.test.tsx` and the run-detail
`page.test.tsx`, with `[COMP:app-web/workflow-delivery-feedback]` coverage for the
shared authoring/feedback component and existing workflow run-page coverage.
