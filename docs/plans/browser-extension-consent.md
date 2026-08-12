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
