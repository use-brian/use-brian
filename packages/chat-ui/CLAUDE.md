# @sidanclaw/chat-ui

Shared, headless chat UI primitives consumed by `apps/web` and `apps/feed-web`. Owns no business logic — wires into a host app via `authFetch` injection and prop callbacks.

**Read this first when entering this package.** Project-wide rules in the root `CLAUDE.md`. The architecture spec for the new operator app is at `docs/architecture/feed/operator-app.md`.

## Scope (v0.1)

The narrow surface required by `apps/feed-web`:

- **`useChatSession`** — pure state machine. Holds `sessionId`, `messages`, `pendingConfirmations`, `isStreaming`, `replyTo`. Exported alongside `chatReducer` so the reducer can be unit-tested without React.
- **`useMessageStream`** — owns the fetch + SSE loop. Caller injects an `authFetch`-shaped function; the hook handles `parseSSEStream`, dispatches reducer actions, manages abort.
- **`Markdown`** — wraps `react-markdown` with the `normalizeBullets` pre-processor so model output renders consistently.
- **Types** — `Message`, `MessageAttachment`, `ToolUsed`, `PendingConfirmation`, `Citation`, `ReplyTo`, `Session`.

View primitives (`MessageList`, `ChatComposer`, `ToolConfirmationCard`) land in commit 2.

## Out of scope

These belong in the host app, not the package:

- Drive picker, voice recorder
- Sidebar cache / session list rendering
- User-profile dropdown, plan badges
- File upload mechanics (`/api/files/upload`)
- Drag-drop attachments

The composer accepts slot props (`slotPreInput`, `slotPostInput`) so hosts re-inject these where needed.

`ChatComposer` **auto-grows its textarea** to fit content (the Notion composer feel — the box expands line-by-line as you type; Shift+Enter inserts a newline). Growth is capped by whatever `max-height` the host passes via `textareaClassName` (e.g. `max-h-[160px]`); past the cap the overflow scrolls. This lives in the component (a `useLayoutEffect` keyed on `value` + a width-only `ResizeObserver`), so hosts get it for free and must **not** re-implement auto-resize themselves — just set a `max-height` and an overflow class.

## Auth seam

The package never imports `auth-fetch.ts`. The consumer passes a `(input, init?) => Promise<Response>` function. This keeps the package free of `apps/web`-specific auth state and gives consumers control over refresh, headers, and error handling.

## Testing

- Pure functions (`chatReducer`, `parseSSEStream`, `normalizeBullets`) are tested with vitest unit tests, no DOM.
- Hooks are tested when `@testing-library/react` is added at the workspace level — for now we test the underlying reducer/parser instead and trust the hook plumbing.
