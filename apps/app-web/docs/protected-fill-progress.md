# Protected fill UI handoff

UI implementation notes. See the [feature plan](../../../docs/plans/protected-browser-fill.md) for deployment limits and consolidated verification.

## Implemented

- Local task view protected-fill panel, authenticated existing CRM contact directory selection and seven allowlisted scalar fields.
- Four dictionaries, themed checkbox/searchable select, explicit sharing consent and controlled/full-browser tab cleanup disclosure before approval.
- Strict metadata-only creation SDK; fixed errors, no response-body echo, no resolution API client, no logging or analytics. Response reconstructed to drop extra data.
- Fresh task revalidation before issue, task/profile/origin keyed consent reset, two-minute expiry, bounded metadata validation.
- Minimum handoff: copy opaque reference IDs plus static field keys to the original task's assistant chat. No automatic chat submission, guessed session, record name, record ID or CRM values in clipboard payload. Target refs come from pre-fill snapshot. Human submits and completes in extension, never unlocks here.

## Backend integration

GET /api/computer/tasks/:sessionId now supplies `destinationOrigin` when protected fill is enabled and unlocked. The UI consumes only that canonical exact HTTPS origin with a connected local profile. It never promotes injectedSite hostnames to HTTPS. Local polling now refreshes task scope even when frames arrive, and preserves origin/profile/task/status changes instead of discarding them when connection state is unchanged. Consent and pending references reset with the task binding.

Creation endpoint POST /api/protected-browser-fill/references, scoped request properties, 201 response, 43-character base64url reference IDs, epoch-ms expiry, and all seven source fields match the implemented backend. A test exercises the real protected-fill service and CRM adapter for all seven fields (including company relation and job_title mapping). The test uses a mocked HTTP transport, not a running server.

No normal-user status endpoint exists, so UI does not claim confirmed fill success or clear a lock. It shows human completion instructions, not fabricated runtime status. Feature enablement requires the backend single-instance opt-in and extension-origin allowlist. Live extension/browser end-to-end verification remains outstanding.

## Verification

The preceding integration run passed 30 UI computer/protected SDK/panel/CRM adapter tests. Coverage includes stale task/origin/profile/workspace rejection, consent reset, expiry, unmount during validation, and raw sentinel exclusion. Full app-web typecheck remains blocked by missing workspace dependencies/types (including @use-brian/chat-ui) and downstream implicit-any errors. ESLint cannot start: existing config produces a circular-JSON error. No browser visual pass performed. See the feature plan for consolidated verification results.

Component registered in the root workflow component map:

| Component | Implementation | Tests |
| --- | --- | --- |
| [COMP:app-web/protected-fill] | src/components/computer/protected-fill-panel.tsx; src/lib/api/protected-browser-fill.ts | src/components/computer/__tests__/protected-fill-panel.test.tsx; src/lib/api/__tests__/protected-browser-fill.test.ts |

Next: verify paired extension end-to-end, run the phone visual pass, and restore workspace dependencies for full typecheck/lint.
