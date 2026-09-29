# Workflow delivery feedback

Workflow run step rows show delivery outcomes separately from generation status.
Only a recognized `__delivery` record confirms delivery, skipping, or failure.
Missing delivery metadata makes no delivery claim; malformed or unknown records
show an unavailable status. Raw output remains available in a collapsed disclosure,
including on steps that are not completed.

`delivery_audience_unverified` gets a generic explanation and a workspace-scoped
Studio Channels link. The summary does not expose private reasons or infer which
person, source, or policy caused a refusal. Diagnostic fields remain in raw JSON.

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
