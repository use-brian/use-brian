# Browser extension consent

The browser extension controls only eligible pages in the browser profile where it is installed.
Every task normally opens an extension-owned Allow/Deny window before the first command, and an
approval remains live for the existing ten-minute idle window.

## Pre-approve tab control

The Chromium and Firefox extension popups expose a **Pre-approve tab control** toggle. It is off by
default and stored only in the extension's local storage. When enabled, the first command for a task
selects the active eligible tab without opening the extension-owned Allow/Deny window.

Pre-approval does not widen browser access:

- restricted, privileged, and incognito pages remain ineligible;
- the server-supplied `task_tabs` or `full_browser` profile policy still bounds available tabs;
- relay disconnect still revokes the active task;
- the popup Stop action still ends the active task and task-created tabs;
- after Stop, automatic approval is suppressed until the user manually allows a new task.
- cancelling the browser's own control indicator also requires a fresh manual Allow.

Turning pre-approval off revokes the current idle approval so the next command asks again. Pairing
credentials and the pre-approval preference are independent; disconnecting does not silently change
the user's preference.

## Accessibility refs and rendered controls

The local browser backend discovers controls through Chromium's accessibility tree and keeps each
ref bound to that accessibility node's DOM identity. Composite widgets may expose a hidden textbox
and a separate rendered combobox for one visible control. An interaction must try the referenced DOM
node first, then may fall back only to a rendered control structurally associated with that node,
such as its labelled control or a containing combobox. It must not search globally by accessible name,
because duplicate labels could redirect an approved action to an unrelated control.

A missing box model does not by itself prove that the user-visible composite control is absent. Click
and type failures therefore report that the referenced accessibility node has no usable rendered or
editable target after structural resolution; they do not claim that the control is not visible on the
page. Native option refs continue to act through their owning rendered select because Chromium's
native option popup nodes do not have independent page-layout boxes.

## Snapshot modes

`browserSnapshot` defaults to an `interactive` accessibility view: actionable controls receive refs
and static page text is omitted to keep action loops concise. For read-oriented work the caller may
request `full`, which adds headings, table semantics, labels, and static accessibility text. Static
nodes never receive refs and therefore cannot be passed to click or type. Full snapshots remain
read-only and use the same offset pagination with a maximum of 150 returned nodes per call.

The full view is a curated accessibility snapshot, not a raw protocol dump or screenshot. Ignored
nodes and empty structural noise stay excluded, and Chromium `InlineTextBox` fragments are omitted
when their `StaticText` representation carries the readable content. Visual-only canvas, image, and
CSS-generated content may still require the watched browser view.
