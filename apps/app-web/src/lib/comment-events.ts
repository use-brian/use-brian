/**
 * The window CustomEvent the floating chat dispatches when the AI posts or
 * resolves a comment (on a `comment_posted` / `comment_resolved` SSE event),
 * and the collab editor listens for to refetch threads + repaint the gutter.
 * Mirrors the `doc:draft-created` pattern. See doc-comments.md.
 */
export const DOC_COMMENTS_CHANGED_EVENT = "doc:comments-changed";
