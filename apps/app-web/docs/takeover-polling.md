# Takeover API polling

`createTakeoverPoller` in `src/lib/computer-takeover.ts` drives the local viewer and cloud API fallback only. WS/SSE still use their existing streaming paths.

- Idle frame delay: 1,200ms after completion.
- Successfully delivered HTTP input requests a refresh immediately (subject to a 180ms minimum between request starts), then enables a 180ms completion-based cadence for two seconds after the latest delivery. This covers pointer clicks/drags, typing, paste/IME text, scrolling and navigation through the shared input door. Failed input and socket-only hover do not trigger it.
- Each clock has at most one request in flight. Input during a request coalesces into one follow-up; it never cancels/restarts a slow frame. Effective frame rate therefore still depends on relay latency.
- Hidden tabs use a 5,000ms delay, discard the burst and ignore input nudges. Returning to the tab requests a fresh frame and task summary.
- Task metadata has an independent 1,200ms completion-based clock, not a request per fast frame. It refreshes even when frames succeed or hang, preserving local origin/connection/status binding updates for protected fill. The panel's authoritative pre-issue validation and consent-reset key are unchanged.
- Task identity/backend, route or transport changes dispose both clocks, abort requests and ignore late results. Metadata-only changes do not restart the frame clock. Pending input captures its current clock so late delivery cannot accelerate a replacement viewer.

The takeover viewer creates and disposes its frame gate in the same effect. On a development Strict Mode effect replay, the replacement gate accepts frames while late decodes from the disposed gate cannot repaint.

The Chat preview probes for an authorized live task at browser-tool start and again on the matching tool result if the start probe came back before task admission. Native desktop tabs still use the desktop pane rather than the polled preview.

Coverage: `takeover-page.test.tsx` (Strict Mode frame rendering); `chat-browser-preview.test.ts` (admission race and desktop routing); `computer-takeover-polling.test.ts` (cadence, coalescing, rate bound, visibility, cancellation, failures and independent metadata); `api/__tests__/computer.test.ts` (abort propagation). Existing geometry, typing and protected-fill tests remain regression coverage.
