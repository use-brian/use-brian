# Frontend design-system consistency audit (original baseline)

Baseline: develop `43a70a8e3608ffc53d76207af4aba85cfb37ea76`.
**This report preserves the before-state findings and screenshots. F01–F07 now have
fixes in the accompanying conventional commits.** Read [implementation and whole-page review](implementation.md) and the
[after gallery](screenshots/after/index.html) for current status, verification and remaining
page-level conflicts. F08–F12 remain open. The original audit itself made no product changes.

Read the [common system](README.md), [coverage and limits](coverage.md), and
[screenshot index](screenshots/README.md) together. Source links below resolve to current
files, which may now be fixed; use `git show 43a70a8e3:path/to/file` for exact original code.

## How to read the evidence

- **Page capture:** a real public route, loaded locally with no account cookies.
- **Component capture:** an unchanged production component mounted in a documentation-only
  fixture with real app CSS. These are **not authenticated page screenshots**.
- **Source only:** implementation evidence; final rendering, reachability, clipping, and
  accessibility still need a populated workspace/native-client pass.
- **P1:** shared-control or interaction-contract issue; address before broad visual polish.
- **P2:** feature-level inconsistency or an intentional treatment needing an explicit exception decision.

Color alone is not a defect. The baseline deliberately separates neutral **action/interaction**
from primary-colored links, authored content, statuses, and data visualization.
The priorities below are recommendations, not an approved redesign backlog.

## Findings at a glance

| ID | Surface | Conflict / review item | Priority | Evidence |
| --- | --- | --- | --- | --- |
| F01 | Authentication portal | Permanent navy/cyan identity, colored CTA and focus halo | P2, design decision | Full page, desktop + 360px |
| F02 | Rendered views | Accent-filled action differs from neutral app Button; separate native checkbox family | P1 | Real-component comparison, light + dark |
| F03 | Workflow builder | Accent selection for trigger cards beside neutral hover/actions | P2 | Real component, light + dark |
| F04 | Association | Choice-card selection and event-editor selection use accent chrome | P2 | ChoiceCards component, light + dark; event editor source only |
| F05 | Shopify | Analysis/campaign choices use accent selection/hover | P2 | AnalyseTab component, light + dark; campaign source only |
| F06 | Document icon picker | Forced-light third-party picker inside dark popover | P2 | Real picker component, dark |
| F07 | Shared controls | Phone contract and primitive target sizes disagree, including 640–767px | P1 | Real primitives at 360px and 700px, measured |
| F08 | Studio assistants | Hand-built enabled toggles and selected tabs bypass neutral primitives | P1 | Source only |
| F09 | Settings / Privacy | Custom blue toggle with fixed-white thumb and incomplete switch semantics | P1 | Source only |
| F10 | Extension / standalone chat | Focus-token policy differs from app-web neutral override | P2, cross-client decision | Source only |
| F11 | Dialogs / searchable choice | Inconsistent phone input sizes and short-viewport containment | P1 verification | Source only |
| F12 | Trial gate / native recovery | Promotional gradient/glass treatment; trial gate short-window risk | P2 / P1 containment verification | Source only |

## F01. Authentication is a separate visual identity

**Reach:** main app `/accounts` → configured auth primary `/login`.

[App light reference](screenshots/reference-accounts-light-desktop.png) ·
[App dark reference](screenshots/reference-accounts-dark-desktop.png) ·
[Portal desktop](screenshots/f01-auth-login-desktop.png) ·
[Portal phone](screenshots/f01-auth-login-phone.png)

The portal fixes `color-scheme: dark`, navy `#081018`, cyan `#55d6e8`, a radial-gradient
background, 24px-radius glass-like card, strong shadow, and cyan filled submit/focus halo.
App account entry instead uses theme tokens, neutral filled actions, and quiet borders.
This difference persists when the main app is dark, so it is not just a light/dark comparison.
The portal correctly enlarges text entry to 16px and language/recovery targets on phones;
those should not be lost in a consistency change.

**Source:** [auth globals.css:3–45](../../apps/auth-web/src/app/globals.css#L3-L45),
[AccountEntry:104–126](../../apps/app-web/src/components/account-entry.tsx#L104-L126).

**Recommendation:** decide whether the portal is an approved branded exception. If not,
share foundational token/action/focus rules without coupling authentication to workspace state.
No sign-in email was sent during capture.

## F02. Rendered-view actions use a second primitive family

[Light comparison](screenshots/f02-renderers-light-desktop.png) ·
[Dark comparison](screenshots/f02-renderers-dark-desktop.png)

**Look at:** left neutral app Button versus right accent-filled renderer Button.
Both are actual production implementations with identical example labels; no expected-state
mockup is substituted. The lower reference row also uses production app primitives.

The renderer action uses `bg-primary text-primary-foreground`; the app Button uses
`bg-action text-action-foreground`. The renderer API accepts an action/text, not an authored
color choice, so this is interaction chrome, not customer content.
The native checkbox property is another control family; the pictured cell is **disabled**,
so its dimmed appearance alone is not evidence of an enabled-state color failure.
The enabled editor's `accent-primary` remains a source-level migration item.

**Source:** [renderer Button:9–23](../../packages/views-renderer/src/widgets/Button.tsx#L9-L23),
[checkbox Cell/Editor:40–92](../../packages/views-renderer/src/properties/checkbox.tsx#L40-L92),
[file attachment action:414](../../packages/views-renderer/src/properties/files.tsx#L414),
[app Button:6–36](../../apps/app-web/src/components/ui/button.tsx#L6-L36).

**Recommendation:** align renderer-owned action/boolean/file-control states with the common
semantic policy. Preserve the renderer's host/action separation; it need not import app-web.
Do not report its focus classes as a demonstrated blue app outline: global important focus
rules can override them.

## F03. Workflow trigger selection mixes interaction languages

**Reach:** `/w/{workspaceId}/workflow/{id}` → edit trigger.

[Light](screenshots/f03-workflow-light-desktop.png) ·
[Dark](screenshots/f03-workflow-dark-desktop.png)

**Look at:** selected “Manual only” border, wash, and icon versus the neutral reference controls.
Unselected cards use `hover:border-interaction/40`; selected ones switch to `border-primary`,
`bg-primary/5`, and an accent ring/icon. These states indicate selection, not execution status.

**Source:** [TriggerEditor:91–129](../../apps/app-web/src/components/workflow/trigger-editor.tsx#L91-L129).

**Recommendation:** adopt one neutral selected-card recipe. Keep distinct workflow-node or
execution-status colors where they encode actual meaning. The preview uses the manual panel
and a synthetic workflow ID; it never runs a workflow.

## F04. Association selection is still accent-driven

**Reach:** `/w/{workspaceId}/association` forms; Events → event → Event page editor.

[ChoiceCards light](screenshots/f04-association-light-desktop.png) ·
[ChoiceCards dark](screenshots/f04-association-dark-desktop.png)

**Look at:** selected radio-card border/dot versus the already-neutral shared switch and buttons.
The card labels are synthetic fixture input, not a claim about a specific production form.
The event editor separately uses `border-primary`/`ring-primary` for selected and dragged sections.
These are staff/editor controls, not the public event website's authored colors.

**Source:** [ChoiceCards:85–105](../../apps/app-web/src/components/association/ui.tsx#L85-L105),
[event section:137–149](../../apps/app-web/src/components/association/events/event-page-editor.tsx#L137-L149).

**Recommendation:** consolidate selection/drag feedback while retaining status-pill semantics,
keyboard arrow navigation, touch affordances, and public website styling.

## F05. Shopify choices retain colored selection and hover

**Reach:** `/w/{workspaceId}/shopify` → Analyse; campaign configuration choices.

[Analyse light](screenshots/f05-shopify-light-desktop.png) ·
[Analyse dark](screenshots/f05-shopify-dark-desktop.png)

**Look at:** the first selected analysis card versus neutral “Run it” and reference controls.
Analysis cards use `border-primary bg-primary/5` and accent hover borders; campaign choices
repeat this pattern. These are operator choices, not storefront or campaign-authored content.
The capture stops before querying a store or invoking an assistant.

**Source:** [AnalyseTab:220–235](../../apps/app-web/src/components/shopify/analyse-tab.tsx#L220-L235),
[campaign choiceClass:126–130](../../apps/app-web/src/components/shopify/campaign-tab.tsx#L126-L130).

**Recommendation:** reuse the same neutral selected-choice recipe as Workflow and Association.

## F06. Emoji picker does not follow dark mode

**Reach:** document page icon → choose icon.

[Dark picker](screenshots/f06-emoji-dark-desktop.png)

**Look at:** the dark app popover header and surrounding page versus the white inner picker.
`EmojiMart` initializes the third-party picker with `theme: "light"`; the wrapper follows
`bg-popover`. This is a concrete theme boundary, not authored document color.

**Source:** [EmojiMart:140–165](../../apps/app-web/src/components/ui/emoji-picker.tsx#L140-L165).

**Recommendation:** bridge the resolved app mode into the third-party picker and validate
mode changes after opening. Also review custom palette, focus, and phone popup bounds.
**Capture limitation:** this minimal Linux environment lacks an emoji font, so emoji glyph
cells are blank. That is an environment artifact, not an additional product defect; the
white inner surface and forced-light source configuration are the evidence here.

## F07. Primitive defaults do not enforce the phone interaction contract

[360px](screenshots/f07-controls-light-360.png) ·
[700px](screenshots/f07-controls-light-700.png) ·
[computed measurements](screenshots/manifest.json)

The available app contract defines phones as below `md`/768px and asks for 44px targets.
Button's floor uses `max-sm`/640px instead; icon sizes and several other controls do not
inherit a phone floor. In the deliberately unenlarged fixture:

| Control | At 360px | At 700px |
| --- | --- | --- |
| Default text Button | 44px high | 32px high |
| Default icon Button | 32 × 32px | 32 × 32px |
| Default Select trigger | 32px high | 32px high |
| Switch visible/root box | 36 × 20px | 36 × 20px |

These are primitive measurements, **not a claim that every composed use fails**. Labels,
wrappers, pseudo-elements, or caller classes may provide a larger effective target.

**Source:** [Button:24–36](../../apps/app-web/src/components/ui/button.tsx#L24-L36),
[Select:23–48](../../apps/app-web/src/components/ui/select.tsx#L23-L48),
[Switch:24–47](../../apps/app-web/src/components/ui/switch.tsx#L24-L47),
[responsive contract](../../apps/app-web/AGENTS.md).

**Recommendation:** define a shared phone/coarse-pointer hit-area policy, test 639/640 and
767/768 boundaries, and verify real composed forms. Avoid enlarging dense document glyphs
without considering adjacent hit-area overlap.

## Source-only follow-ups

### F08. Studio assistant tabs and switches

**Reach:** `/w/{workspaceId}/studio/assistants` → assistant → Tools / Skills / Connectors.

[assistant-detail:416–431](../../apps/app-web/src/components/studio/assistant-detail.tsx#L416-L431)
uses primary for selected tabs; [1822–1829](../../apps/app-web/src/components/studio/assistant-detail.tsx#L1822-L1829)
and [1921](../../apps/app-web/src/components/studio/assistant-detail.tsx#L1921) use primary-filled custom toggles.
Replace duplicated toggle treatment with shared Switch where semantics permit. Confirm the
actual enabled/disabled state and keyboard labels in an authenticated fixture before closing.

### F09. Privacy custom toggle

**Reach:** workspace Settings modal → Privacy. There is no invented `/settings` route here.

[privacy-section:677–720](../../apps/app-web/src/components/settings-modal/sections/privacy-section.tsx#L677-L720)
implements a blue `bg-primary` toggle with `bg-white` thumb. Unlike the shared Switch it is a
plain button without its own switch role, checked state, or accessible-name association in
this local helper. Review the caller and semantics as well as the colors.

### F10. Cross-client focus policy

[Extension popup:12–45,75–77](../../apps/browser-extension/static/popup.html#L12-L77),
[sidepanel.css:7](../../apps/browser-extension/static/sidepanel.css#L7), and
[shared theme:119–121](../../packages/chat-ui/src/theme.css#L119-L121) retain accent ring/focus
values. App-web deliberately overrides its rings and focus rendering to neutral.
Extension primary actions are already neutral; do not call the whole extension off-theme.
Choose whether neutral focus is a product-wide policy, then share it at the appropriate
package boundary. Native extension/Firefox captures remain pending.

### F11. Phone input fonts and overlay containment

[Prompt fields:185,202](../../apps/app-web/src/components/ui/prompt-dialog.tsx#L185-L202)
and [combobox search:184–186](../../apps/app-web/src/components/ui/searchable-select.tsx#L184-L186)
use `text-sm`, without a phone 16px floor. No global input-font floor compensates for them.
The iOS viewport patch is not the same as satisfying the font-size contract.

[Confirm:108–115](../../apps/app-web/src/components/ui/confirm-dialog.tsx#L108-L115),
[prompt:143–151](../../apps/app-web/src/components/ui/prompt-dialog.tsx#L143-L151), and
[dropdown:65](../../apps/app-web/src/components/ui/dropdown-menu.tsx#L65) do not express the same
height/scroll safeguards as the shared Popover. This is a **short-viewport/long-content risk**,
not a reproduced clipping defect. Test a long localized dialog with an on-screen keyboard.

### F12. Branded promotional and native recovery surfaces

The trial gate's [module CSS:11–17,74–89,332–352](../../apps/app-web/src/components/chrome/plan-gate.module.css#L11-L352)
uses cyan/violet gradients, a glass card/glow, and a fixed gradient CTA. Its centered,
overflow-hidden backdrop/card has no general viewport-height cap; scrolling is added only
under its [760px media query:492–500](../../apps/app-web/src/components/chrome/plan-gate.module.css#L492-L500).
Verify wide/short windows and enlarged text. Treat branded presentation as an explicit
exception decision, separately from containment correctness.

The native [offline landing](../../apps/app-desktop/src/offline.html) independently follows
OS light/dark and retains a cyan promotional action, rather than the SPA's selected palette.
Capture actual offline/native startup before deciding whether to migrate that recovery UI.

## Not defects by themselves / rejected false positives

- **Explicit focus-primary utilities in app text fields:** global important focus rules remove
  halos and set border-ring. In particular, Knowledge Add source's old focus-ring classes
  alone do not prove a visible blue halo. Do not create a screenshot finding from grep alone.
- **Ordinary document links:** intentionally neutral underlined prose; chat links/timecodes may
  use primary. Different content contexts are not automatically inconsistent.
- **Statuses, Brain entities/graph, authored block colors and Office paper:** semantic/content
  domains, not generic interaction chrome. Office paper intentionally stays light and reflows
  on phone; do not recolor exported documents to the app theme.
- **Comments:** deliberate warm-yellow anchors; find results use neutral highlighting.
- **Rail tooltips/workspace status labels:** explicit fixed-dark tooltip treatments, not
  unthemed generic popovers. The app rail has narrow default-light neutral overrides only.
- **Embedded desktop browser fallback tokens:** preload synchronizes the real theme;
  fallback light literals are not proof it is permanently light.
- **Brain ingestion cards:** intentionally multihue guidance, distinct from entity visualization.
  Review as an exception before flattening their colored CTA borders.
- **Legacy DocSidebarRow menu:** conflicting old implementation appears referenced only by
  tests; it is not established as a live production sidebar defect.

## Suggested implementation order and closure evidence

1. **Shared foundations:** F02/F07/F11. Add effective-style/target-size and overlay regression checks.
2. **Reusable interaction recipes:** F08/F09, then F03/F04/F05. Consolidate toggles and selected cards.
3. **Theme bridges:** F06; decide package/client policy for F10.
4. **Exception decisions:** F01/F12 and Brain guidance. Record intentional owners and boundaries.
5. Capture full authenticated pages with synthetic populated data in light/dark/custom palettes,
   phone/coarse-pointer and short-window states; include keyboard focus and all four locales.

A finding closes only when the actual reachable surface is checked. These screenshots are
an audit baseline, not visual-regression goldens or accessibility certification.
