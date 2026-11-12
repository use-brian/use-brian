# Foreground classifiers and Standard split preparation

Classifier failures are not evidence of an empty main assistant generation.
The changes here repair classifier schemas and bounded preparation; they do not
claim to fix empty main assistant responses.

## Shadow comparison: 10% or 100%

Settings → Models → Decision routing offers separate **Shadow (10%)** and
**Shadow (100%)** choices for each configured Jev/OpenAI decision model. Both
keep the LLM authoritative; only the number of eligible native comparison calls
changes. Existing workspace selections default to 10%. The selected sample rate
is persisted per workspace and requires no approved hybrid profile or deployment
execution grant. Text generation remains on the LLM. See
[Decision adapters](decision-adapters.md#openai-setup-and-shadow-comparison) for
configuration and the API request.

## Explicit 100% classifier-first routing

`TYPESAFE_API_KEY` registers the Jev transport. The separate
`OPENAI_DECISIONS_API_KEY` registers the native OpenAI Decisions transport;
neither key alone enables classifier authority. After migration **8265**, a
workspace owner/admin can select **<model> - Classifier first (100%)** in
Settings → Models → Decision routing. This persists `classifier_first` with the
selected model and authorizes native execution without deployment environment
changes. Jev/OpenAI selection follows that workspace option, not a hard-coded
provider. It is an explicit admin override, **not approved quality evidence**.

The existing updater identity/timestamp records the selection. Runtime creates
exact operation/model/version override metadata with
`policy.authority=workspace_admin_override`; clients cannot supply that metadata.
All capability, capacity, admission, cancellation and final authority checks
remain in place. There is no automatic promotion from shadow to execution.

### Legacy deployment defaults

To authorize a deployment default instead of an explicit workspace selection,
set:

```dotenv
DECISION_DEFAULT_MODE=classifier_first
DECISION_DEFAULT_MODEL=typesafe-jev-1.13
```

To explicitly select OpenAI instead, use
`DECISION_DEFAULT_MODEL=openai-decisions-gpt-6-luna` with its dedicated key.
Registering that adapter does not replace an existing Jev selection or reuse
Codex login. See [Decision adapters](decision-adapters.md) for the native wire
contract, separate recording identity, usage normalization and extension seam.

This is a deployment-operator override, **not approved quality evidence**. It
reuses the existing exact-version `operator_override` profiles and Hydra
cascade, rather than weakening approval validation or introducing another
classifier pipeline. The legacy deployment mechanism itself is unchanged;
workspace-admin classifier-first selection is the separate persisted mode added
by migration 8265.

The policy applies to workspaces without an explicit decision-routing row and
to saved `hybrid` selections for the exact configured model. Explicit `llm_only`
and `shadow` rows remain opt-outs. A workspace's explicit `classifier_first`
selection instead uses its saved model, independently of deployment model or
scope. The legacy deployment-granted hybrid option retains its existing gate;
no deployment grant is needed for the separate owner/admin classifier-first
option. Both require a configured adapter. A key or a client-supplied authority
flag cannot grant execution.

Optional `DECISION_DEFAULT_OPERATIONS=research.intent,memory.topic,chat.tool-selection`
limits the override to those exact operation IDs; blank/unset means every
eligible operation. Outside this scope, a saved hybrid row still needs its
ordinary exact approved profile or degrades to 10% shadow. Other models retain
the ordinary approval gate. The legacy `operator_hybrid` deployment mode keeps
its no-workspace-row-only behavior.

100% means no execution sampling for eligible typed operations already using
`DecisionRuntime`. A successful native decision completes directly, without an
LLM classification. Observation-only consumers remain shadow-only, with full
sampling for workspace-admin selections or inside the deployment override
scope; they gain no execution
authority. Each adapter retains its capability, context-capacity, cancellation
and one-second primary transport bounds. The shared invocation/profile limits
and pending/final authority checks are unchanged. Unsupported-capacity inputs
retain the existing owned fallback, without truncating state or options.

Native decision endpoints cannot generate new topic labels or worker task prompts. Generation,
uncertainty review and allowed operational recovery can still need a bounded
LLM follow-up. The main chat model is unchanged. Eligible Standard split
preparation now uses the selected decision runtime for `research.split`;
other late legacy splitter paths are unchanged.
Fresh Memory, source/recipient admission, event/final output validation, worker
launch and publication boundaries remain unchanged.

The menu offers the explicit workspace-admin classifier-first option for every
configured decision model. It also reports legacy deployment grants separately
as `classifierFirst` metadata with operation scope; neither override fabricates
approved entries in `hybridOperations`. Scoped routes are labeled as operator
overrides, including
when matching hybrid routing has already been saved. Tests use mocked stores
and a fictional Jev transport; they do not establish live latency or quality.

## Strict decision schemas

The common LLM decision adapter emits closed objects with every property in
`required`. Confidence is required but nullable; boolean answers additionally
have required nullable `pTrue`. Null means unavailable, never a fabricated
confidence or probability. Choice and score answers do not request `pTrue`.
Existing value validation, typed decoding, question ordering and decision
profiles remain authoritative.

Identical ordered choice domains share deterministic local leaf `$defs`/`$ref`
entries. Seven combined intent/tool-ranking questions over 357 tools previously
repeated 1,082 enum values; the wire schema now contains 364 without removing or
reordering choices. OpenAI/Codex target admission checks enum, string-vocabulary
and property budgets before dispatch, including known models behind the routing
provider. Other providers do not inherit these target-specific caps. Cyclic
state is rejected before serialization.

Classifier LLM calls prefer low reasoning only when the provider explicitly
advertises it for the serving model. Codex obtains this descriptive metadata
from its already authenticated, reviewed catalog; capability queries never
start a process, refresh accounts, resolve credentials or acquire leases.
Routing honors the call's exact/Auto mode, exact bindings pin their model, and
fallback wrappers conservatively intersect supported levels. Missing, unknown
or ordinary broken metadata retains the existing default; authority refusals
still propagate. The registry's generic thinking bit is not proof of a specific
effort level. Existing Gemini low/shared-token behavior and answer-token caps
are unchanged. Main assistant reasoning is not lowered by this classifier
policy.

## Lossless prompt compaction

Repeated choice-option arrays share a deterministic prompt-local `choiceOptions`
table. Each affected question references the complete ordered array with a JSON
Pointer; fixed host instructions explain expansion. Equality includes all option
metadata, not just values. Different ordering, descriptions or metadata do not
merge. State, question wording/order/IDs and response-schema constraints remain
unchanged, and the original representation is retained unless sharing is
smaller. Dispatch and input-ownership qualification use the same message builder.
There is no cross-request prompt or permission cache.

A fictional 357-tool fixture including the complete tool catalog and seven
questions shrinks from 87,649 to 51,142 prompt characters (41.7%). This is a
serialized-character measurement, not a production token count or latency
promise. Tests expand the references back to the exact original state/questions.

An offline integration test uses the pinned Codex runtime, production inference
hardening, isolated temporary home/cwd, no credentials and a loopback fake
Responses API enforcing strict schema requirements. It verifies the **source**
adapter's actual wire request, not a repaired or stale compiled schema. It does
not establish that a historical live failure had this exact upstream rejection.

## Topic deadline

The default generation budget remains 2 seconds. Known Codex routes receive an
8-second generation budget, including registry-resolved models behind the
routing provider. The known Standard OpenAI-compatible background fallback also
receives this bound. Unknown/custom routing entries remain conservative. A host absolute
`deadlineAt` can only narrow this budget; caller, lifecycle and decision-profile
limits still apply. Low topic reasoning, sticky source refusal, fresh final
validation and fallback behavior remain intact.

These are generation deadlines, not permission-proof timeouts. Returning a
fallback must still join pending authority checks and validate current access.
A stalled authority proof can therefore extend total wall time beyond the
model-generation deadline. Timeout never manufactures permission.

## Deferred tools versus classifier data

The main answer already opts into deferred registration. A verified
native-deferred driver registers the full admitted catalog while keeping only
foundation/selected tools eager; native discovery loads others on demand.
Dynamic and eager routes retain their existing behavior and canonical executor.

The research classifier's tool names/descriptions and ranking choices are plain
prompt data, not executable tool registrations. Marking that JSON `deferLoading`
would not defer it. This change shares repeated data without dropping tools or
silently omitting advisory ranking. In particular, the background classifier's
provider does not prove the final answer provider: budget, research promotion,
workspace custom/BYO and media routing occur later. Skipping preparation would
require a separately verified final-route/recovery design; existing preselected
results are still consumed as before. Classifier calls gain no executable tools.

## Parallel preparation, not early worker execution

Only an invariant Standard legacy preflight route may prepare its splitter
classification alongside research and topic assessment. Eligibility requires a
primary non-doc surface, no explicit research/site mode, a sufficiently long
message, no custom or active metered model selection, and Standard resolution
under both ordinary and downgraded budget states. Other routes retain their
late canonical classifier. `research: false` is **not** interpreted as no split.

The splitter reads the same admitted authored message and complete source
cohort, with a separate accumulator and privately bound authority. Mixed or
transformed input stays on the late path. Preparation passes the captured
workspace-selected decision runtime, workspace identity and a split-specific
run ID through the existing `research.split` operation. A native no-split result
can complete without LLM classification; a positive split still needs the LLM
to generate task prompts. The historical provider/default LLM model is retained
for generation and permitted recovery. LLM-only/shadow opt-outs and hybrid
approval/deployment scope gates remain unchanged. Its generation is cancellable
and bounded to 8 seconds. A positive research/site assessment cancels
unnecessary speculative classification.

Every sibling settles before admission continues or fails, and accumulated
source evidence is merged. Successful preparation usage is recorded once even
when another assessment refuses or a later research/budget verdict discards it.
No completed result is charged again on reuse. Interrupted calls without a
completed result do not fabricate usage.

Preparation contains data, not a permission receipt. At the original preflight
boundary, exact message bytes, provider and decision-runtime identities must
match. Consumption is
one-shot and requires a new current source proof, captured root/fork identity
checks and cancellation checks. Worker spawning, plan seeding, events and other
preflight effects remain at the original late boundary. Fresh Memory retrieval,
per-event/final output authority and publication checks are unchanged.

Overlap removes an avoidable serial classification window; a native no-split
verdict additionally avoids an unnecessary LLM call. Neither change promises
production latency percentiles or equates native wait with pure inference time.

## Valid insufficient-signal topic decisions

The topic question explicitly offers `__uncategorized__` for insufficient
signal. With `continue` or `resume`, this is a valid terminal safe result:
`(uncategorized) / continue / 0`, retaining native usage/model attribution. It
must not be mislabeled as a provider `invalid_response`. Explicit low-confidence
review policy still takes precedence; new topics, shifts and cross-topic
payloads retain their generation path. Missing/wrong-kind answers and source
authority refusals are unchanged.
