/**
 * The window Event the Inbox view dispatches after it loads (and marks
 * mentions read), so the sidebar Inbox badge can refresh its unread count
 * without a prop drill. Mirrors the `doc:comments-changed` pattern.
 * See `docs/architecture/features/doc-inbox.md`.
 */
export const INBOX_CHANGED_EVENT = "doc:inbox-changed";
