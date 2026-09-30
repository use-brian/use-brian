# Browser file transfers

Optional `BrowserProvider` methods use the existing profile-scoped relay:

- `listDownloads {}` → `{downloads:[{id,name,mime,size,state,error?,tabId?}]}`.
  State is `progressing|completed|cancelled|interrupted`; IDs are opaque.
- `readDownload {id,offset}` → `{data,offset,total}`. `offset` is the requested
  **byte** offset, not the next offset. Base64 decodes to at most 256 KiB.
  Only completed files are readable. The consumer validates canonical base64,
  forward progress, stable totals, and exact inventory size.
- `uploadFile {ref,name,data}` → `{}`. Canonical base64, at most 4 MiB decoded
  (5,592,408 base64 characters), below the relay's 8 MiB payload cap.

Download limits: 32 MiB/file, 20 entries, 128 MiB total. Desktop owns session
lifetime and cleanup on Stop. Backend transfer loops also cap at 1,024 chunks.
Older extensions explicitly reject unsupported operations; providers that omit
these optional methods yield clean unsupported errors, without fallbacks.

Tools:

- `browserDownloads`: bounded inventory.
- `browserReadDownload {id,offset?}`: always requires explicit interactive approval
  to share the download under workspace file permissions, potentially broader
  than a private browser profile (FilesApi has no owner-only scope). Refuses
  autonomous execution even when unattended browsing is enabled. Persist original bytes through FilesApi,
  then return file ID/path and up to 12,000 characters of PDF text-layer or UTF-8
  text. Here `offset` means **text characters**, starting at zero. Empty/scanned
  PDFs explicitly need OCR; failed extraction and other binary formats do not
  fabricate text. No base64 enters model results.
- `browserUploadFile {ref,fileId}`: UUID of a durable workspace file only, using
  the latest observed ref. Always asks for tool confirmation, even under allow
  policy, and refuses autonomous execution. Selection can send immediately.
  Desktop may additionally ask for native confirmation.

All tools use capability, policy, autonomous, protected-fill and cloud-fuse gates;
transfers reauthorize the active profile against user/workspace/assistant and
clearance. Upload invalidates observations. Files callbacks receive the complete
ToolContext. Boot preserves assistant identity/kind, member/assistant read ceiling,
compartment/project grants, independent mutation grants and write provenance.
Authenticated downloads conservatively inherit effective clearance plus the
turn's high-water sensitivity; no model-supplied sensitivity labels are accepted.

No transfer cache. Artifact paths under `/browser-downloads` hash context,
profile, opaque ID, content and write scope. Repeated pages re-fetch/re-extract;
existing artifacts are reused only after live authorization, provenance and
byte equality checks. Original files survive browser Stop, but reading further
text pages via the browser tool requires the desktop download to remain alive.
Durable IDs can still be delivered/attached/uploaded through workspace file tools.
PDF extraction is text-layer only, not OCR or visual interpretation.

Cancellation is checked after inventory/chunk reads, immediately before persistence,
and after persistence before extraction and before returning text. Cancellation during
an in-flight persistence may leave the approved workspace artifact saved, but no
contents are returned. Filenames are capped at 200 characters and sanitize Windows
invalid characters, trailing dots/spaces and reserved device basenames as well as paths.
