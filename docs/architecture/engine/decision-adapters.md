# Native decision adapters

Domain operations own their versioned state, questions, result policy and fresh
source checks. `DecisionRuntime` owns permitted model selection, adapter
registration and attempt accounting. Hydra owns the bounded cascade. Adding a
backend must not move these responsibilities into a vendor-specific classifier.

## Reviewed backends

| Catalog selector | Adapter | Wire model | Transport |
| --- | --- | --- | --- |
| `typesafe-jev-1.13` | `typesafe` | `jev-1.13.0` | TypeSafe System One |
| `openai-decisions-gpt-6-luna` | `openai-decisions` | `gpt-6-luna` | OpenAI `POST https://api.openai.com/v1/decisions` |

Both are decision-only catalog rows, excluded from chat menus, chat defaults,
provider chat-model lists and chat outage fallbacks. The OpenAI row is not the
Codex subscription row with the same wire name. No model/account discovery or
inference happens when an adapter is registered.

## Configuration and selection

Jev uses `TYPESAFE_API_KEY`. OpenAI uses the dedicated
`OPENAI_DECISIONS_API_KEY`, containing an ordinary OpenAI API key. It never
implicitly borrows `OPENAI_API_KEY`, a workspace chat credential, an
OpenAI-compatible endpoint credential or a Codex/ChatGPT login. The adapter uses
the fixed public native Decisions endpoint, not Responses or Chat Completions.
There is no vendor-to-vendor fallback between Jev and OpenAI.

Registering either or both adapters does not activate or change decision
routing. Existing Jev selections remain Jev.

### OpenAI setup and shadow comparison

1. Create an OpenAI API key in a project with billing and access to the Decisions
   API/model. ChatGPT/Codex subscription sign-in does not supply this credential.
2. Set `OPENAI_DECISIONS_API_KEY` in the API server's environment and restart the
   API. Do not commit the key. No custom endpoint or chat-model change is needed.
3. Apply the normal API database migrations, including migration 8264 for the
   persisted workspace shadow sample rate.
4. As a workspace owner/admin, open Settings → Models → Decision routing and
   choose **GPT-6 Luna Decisions - Shadow 10%** or **Shadow 100%**.

Both shadow options keep the LLM authoritative. The selected native classifier
runs for 10% or 100% of eligible typed decisions respectively, subject to the
existing capability, input-authority, deadline and capacity checks. Work that
requires generated text remains on the LLM; shadow results never replace its
answer. Generation-only operations are not added to the native endpoint.
100% shadowing adds classifier calls alongside the existing LLM work; it does
not eliminate LLM classification cost.

The setting is workspace- and model-specific. Existing selections and omitted
sample rates remain 10%. The API accepts only `0.1` and `1` for shadow mode:

```http
PUT /api/workspaces/<workspace-id>/decision-routing
Content-Type: application/json

{"mode":"shadow","modelAlias":"openai-decisions-gpt-6-luna","shadowSampleRate":1}
```

Use `0.1` for the 10% option, or select `typesafe-jev-1.13` with its separate
`TYPESAFE_API_KEY` for Jev. No `DECISION_DEFAULT_*` settings or approved hybrid
profiles are required to select shadow mode. An explicit shadow preference
remains non-authoritative even with a matching classifier-first deployment grant.

### Classifier-first execution (separate opt-in)

After applying migration **8265**, a workspace owner/admin can select
**<decision model> - Classifier first (100%)** in Settings → Models → Decision
routing. Choose either Jev or OpenAI from the configured model options. This
persists `mode: classifier_first` and the exact selected model; it needs no
`DECISION_DEFAULT_*` deployment grant and never substitutes a different vendor.

```http
PUT /api/workspaces/<workspace-id>/decision-routing
Content-Type: application/json

{"mode":"classifier_first","modelAlias":"openai-decisions-gpt-6-luna"}
```

The native classifier replaces LLM classification for eligible execution
operations. A successful native decision returns directly without the ordinary
LLM classification call. Version-2 topic classification allocates host-owned
identities without generating names. The LLM remains for generated task prompts,
explicit uncertainty review and permitted bounded operational fallback. Legacy
LLM-only/shadow topic naming is retained only without opaque topic history. Main
chat generation is unchanged; observation-only operations stay non-authoritative
100% shadow comparisons. Existing legacy operations without a decision-runtime
route are not automatically migrated by this setting.

This explicit owner/admin override is **not approved quality evidence**. It is
recorded through the existing updater identity/timestamp and translated to exact
operation/model/version override metadata with `workspace_admin_override`
authority. The client cannot submit profile or authority flags. Existing
shadow/hybrid choices retain their semantics; selecting a key alone grants no
execution authority. Input admission, final authority checks, capability limits
and deadlines still apply.

The separate approved-profile workflow and legacy deployment-operator default
remain available. For a deployment default rather than an explicit workspace
selection:

```dotenv
# Optional alternative; do not change an existing Jev selection implicitly.
OPENAI_DECISIONS_API_KEY=<your OpenAI API key>
DECISION_DEFAULT_MODE=classifier_first
DECISION_DEFAULT_MODEL=openai-decisions-gpt-6-luna
```

Explicit workspace selections take precedence over the deployment default.
`DECISION_DEFAULT_OPERATIONS` narrows that deployment grant, not a separate
workspace-admin selection. Legacy deployment-granted hybrid selections retain
their exact model/scope rules. The UI distinguishes both kinds of override from
approved quality evidence.
See [Classifier preparation](classifier-preparation.md#explicit-100-classifier-first-routing).

## OpenAI wire mapping

This adapter implements the native API rather than generating JSON through a
chat model. It preserves complete state using `input: JSON.stringify(state)`;
objects, arrays and primitives round-trip without truncation. State strings
that resemble roles, image URLs or tool calls remain evidence text, never
executable input items or additional outbound fetches.

| Brian primitive | Native question | Native answer |
| --- | --- | --- |
| `boolean` | `predicate`, with both supplied criteria preserved in instructions | native probability → `pTrue`; threshold 0.5 |
| `choice` | ordered `choices` with exact string values/descriptions | selected string and complete native distribution |
| `score` | ordered `levels` with zero-based numeric labels | native probability-weighted score and complete distribution |

Native rubric scores may be fractional; they are not rounded or replaced with
a most-likely level. Predicate probabilities do not invent a separate confidence
or distribution. Choice/score confidence is retained only from the native
response, never manufactured from a selected label.

Responses must match the pinned model and the exact question count, order,
names and primitive types. Distributions must cover the declared domain without
duplicates, coercion or unknown entries, with finite in-range probabilities and
a valid sum. Malformed usage is rejected. Any native refusal denies the whole
call as `policy_denied`; partial answers cannot become a verdict and hybrid
execution does not retry a refusal through an LLM.

The reviewed wire limits are 400 questions, 255 choices per question and ten
rubric levels. This initial text-only adapter deliberately retains conservative
**host** admission bounds of 64,000 total and 32,000 per-question estimated input
tokens. These are not claims about OpenAI's maximum model context. It exposes no
image, file, tool, prompt-cache-control or arbitrary-endpoint feature.

## Authority, deadlines and failures

The production fetch adapter uses the existing private transport ownership and
budget machinery. It performs fresh input admission at physical dispatch and
fresh response authority after acquisition. The primary transport budget ends
before final proof; the total invocation deadline and cancellation remain live.
A timeout does not manufacture permission or reuse an earlier allow result.
Custom transports or capability overrides cannot claim canonical input-capacity
ownership. Logging is not added; error messages contain fixed categories, not
remote bodies, prompts, refusal text, credentials or arbitrary transport errors.

The adapter performs no retries. Hydra retains its existing at-most-two-attempt
cascade, with an allowed configured LLM completion for generation, uncertainty
review or bounded operational recovery. There is no fallback to a different
native vendor. Source-authority refusal/cancellation still propagates. Main
assistant routing, full fresh Memory retrieval, worker launch, executor checks
and publication boundaries are unchanged. Eligible Standard speculative split
preparation now passes its selected runtime and workspace scope to the existing
`research.split` operation: a native no-split verdict avoids the LLM, while
positive/uncertain decisions retain bounded LLM generation/review. The historic
LLM model, fresh consumption proof and single-charge accounting are preserved.
Other late legacy splitter paths remain unchanged.

## Usage and model identity

`DecisionResponse.model` and attempt metadata retain both the real wire ID and
catalog selector. Domain result attribution uses `decisionUsageModelId()`:
only a decision row with `recordAlias` records its catalog alias. Existing Jev,
chat and unknown-fixture attribution is unchanged.

OpenAI Decisions records `openai-decisions-gpt-6-luna`, not the free subscription
`gpt-6-luna` selector. This keeps pricing, classification and caller-side
metering deduplication distinct. A successful native attempt is recorded once by
the central decision meter; legacy caller overhead helpers skip that decision
alias, but continue to meter ordinary Codex/LLM calls normally.

OpenAI's reported input total includes cache reads and writes. Normalize it to
Brian's fresh-input convention by subtracting reported cached and cache-write
tokens, retain the separate counters, and reject impossible totals. Cache-write
rates replace the ordinary input rate; they are not additive. No cache receipt
is used for admission or retrieval, and no custom cache state is retained.

Reviewed list rates are $0.10/M fresh input, $0.01/M cache read, $0.125/M cache
write and no output charge. The 64k host input cap keeps this adapter below the
long-context pricing threshold. Actual organization terms may differ. Rates
live in the shared catalog, not in the adapter. Native usage and its separated
cache counters flow through the existing usage ledger without schema changes.

## Adding another backend

1. Implement `DecisionProvider.evaluate()` against the backend's real native
   protocol; do not assume OpenAI and TypeSafe envelopes are interchangeable.
2. Publish honest primitive, batch, domain, context and uncertainty capabilities.
   Keep the reviewed default metadata frozen. Do not claim native probabilities
   from self-reported JSON, labels or token logprobs.
3. Add a unique decision-only shared catalog row with reviewed wire identity,
   endpoint-specific rates and explicit alias recording if the wire name collides.
4. Register a configured adapter factory through `DecisionAdapterRegistry` /
   `configureDecisionAdapters`. Registration is availability, not activation.
5. Select that exact model through normal approved evidence, explicit
   workspace-admin classifier-first selection or a scoped deployment grant.
   Profiles for another model/version are not transferable.
6. Test all primitives, refusals, malformed responses, native usage, capability
   limits, physical/final authority, cancellation, transport/total budgets,
   credential isolation and one-record accounting with synthetic transports.

The same domain operations and canonical executors must continue to work with
Jev, OpenAI and future adapters. No live provider validation, performance
benchmark or quality approval is implied by the synthetic transport tests.

## Public API references

Reviewed 2026-11-11:

- [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
- [Native create-decision reference](https://developers.openai.com/api/reference/resources/decisions/methods/create)
- [GPT-6 Luna pricing](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Non-additive prompt-cache accounting](https://developers.openai.com/api/docs/guides/prompt-caching)
