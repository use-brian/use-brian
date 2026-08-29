-- Original bytes for structured-document chat uploads (docx/pptx/xlsx/csv/...),
-- stored as a base64 data URL beside the parsed text so the attachment can be
-- rendered as a PDF preview on demand. Deliberately in the transient cache
-- (7-day TTL, swept with the row) rather than promoted to workspace_files:
-- promotion would put every chat attachment permanently on the workspace
-- storage quota and into the brain's file listings, which a preview must not
-- do. `content` keeps carrying the parsed text, so the prompt-injection path
-- (`isTextLike` in routes/chat.ts) is untouched. Inline media (images, PDFs,
-- audio) already store their bytes in `content` and leave this NULL.
BEGIN;

ALTER TABLE file_cache ADD COLUMN IF NOT EXISTS original_content text;

COMMIT;
