# Recording upload failures

## Upload admission is not a network failure

`recording_intake_provenance_required` means the API attempted to create a recording without an admitted canonical file parent. It happens before the storage PUT. A good network connection cannot fix it, and the provenance guard must not be bypassed.

The supported upload flow is:

1. `/api/recordings/upload-url` receives the file metadata and `sizeBytes`, then starts the existing canonical chunked-file upload service.
2. The client uploads the exact signed parts directly to storage, retaining progress and storage-specific headers.
3. `/api/recordings/complete-upload` checks/completes the owned file upload and adopts that admitted file as a recording with its current provenance. Retrying completion reuses the same recording. The requested meeting/memo kind is set inside canonical publication, before the initial lineage is recorded. Omitted kind preserves an existing recording; a conflicting explicit retry returns HTTP 409 rather than mutating its provenance.
4. Only then does the client estimate and queue recording processing.

Live-window assembly also writes a canonical file before adopting it. Failed publication/adoption leaves source windows available for recovery. No caller-supplied scope or fabricated parent metadata is accepted.

Deploy the API and web client together and reload the client: the upload preparation response now contains a chunk plan, not a pre-created recording and one signed URL. For the recording-kind lineage fix, apply migration `658_recording_kind_at_publication.sql` and deploy the updated API together. Avoid accepting uploads on the old API during rollout: it still patches kind after publication. No new provider key is required.

## `recording_intake_source_changed` after meeting upload

The old upload adapter published a `memo` recording and then patched it to `meeting`. Kind is semantic metadata: that update advanced the recording to version 2 but left lineage at version 1. Reopening or retrying the stored file then correctly failed the current-lineage guard. The new publication overload sets kind in the initial INSERT. It keeps all source-version, access, hold and lineage checks; the two-argument SQL entry point remains compatible.

This prevention does **not** automatically repair already-broken recordings. Version 2 with a missing lineage entry is not enough historical evidence to prove that only kind changed. Do not reset versions, clear holds, delete parent bindings or manufacture lineage rows.

Safe recovery after the fix is deployed:

1. Preserve the old recordings and their source audio.
2. Obtain the original audio from recorder recovery, or download the stored source file through the normal authorized file UI.
3. Upload it again as a **new file/upload**, not a retry of the old recording or completion token. This creates a fresh canonical file, recording and lineage.
4. Verify processing succeeds before discarding any local recovery copy. Existing pages/links still refer to the old recording; new uploads do not silently rewrite that history.

If the source download itself is refused, stop and investigate its current access/source state. Do not bypass access controls to recover it. In-place historical repair requires separately verified evidence and is not provided by this migration.

## Missing media tools

`spawn ffmpeg ENOENT` means the API process cannot find `ffmpeg` in its PATH. `ffprobe` is also required for duration checks. This is a server prerequisite, not a browser connectivity error.

On Debian/Raspberry Pi OS, install the `ffmpeg` package (which also supplies `ffprobe`). On NixOS, include ffmpeg in the API service's package PATH; a user's interactive shell installation alone does not change a systemd service's PATH. Containers must include both binaries in their image.

Verify `ffmpeg -version` and `ffprobe -version` under the service's user and environment, then restart the Brian API. Installing these tools fixes the prerequisite only; it does not repair an old upload route missing canonical admission.

The UI distinguishes preparation/admission failures, storage-transfer failures, completion failures, and unavailable media tools. Capture audio remains available in recorder recovery after failed processing. Do not discard it; use Save again after the updated server and media tools are ready.
