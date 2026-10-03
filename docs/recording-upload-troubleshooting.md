# Recording upload failures

## Upload admission is not a network failure

`recording_intake_provenance_required` means the API attempted to create a recording without an admitted canonical file parent. It happens before the storage PUT. A good network connection cannot fix it, and the provenance guard must not be bypassed.

The supported upload flow is:

1. `/api/recordings/upload-url` receives the file metadata and `sizeBytes`, then starts the existing canonical chunked-file upload service.
2. The client uploads the exact signed parts directly to storage, retaining progress and storage-specific headers.
3. `/api/recordings/complete-upload` checks/completes the owned file upload and adopts that admitted file as a recording with its current provenance. Retrying completion reuses the same recording. The requested meeting/memo kind is applied after adoption.
4. Only then does the client estimate and queue recording processing.

Live-window assembly also writes a canonical file before adopting it. Failed publication/adoption leaves source windows available for recovery. No caller-supplied scope or fabricated parent metadata is accepted.

Deploy the API and web client together and reload the client: the upload preparation response now contains a chunk plan, not a pre-created recording and one signed URL. No new migration or provider key is required by this repair; the existing canonical file-upload and recording-admission migrations must already be applied.

## Missing media tools

`spawn ffmpeg ENOENT` means the API process cannot find `ffmpeg` in its PATH. `ffprobe` is also required for duration checks. This is a server prerequisite, not a browser connectivity error.

On Debian/Raspberry Pi OS, install the `ffmpeg` package (which also supplies `ffprobe`). On NixOS, include ffmpeg in the API service's package PATH; a user's interactive shell installation alone does not change a systemd service's PATH. Containers must include both binaries in their image.

Verify `ffmpeg -version` and `ffprobe -version` under the service's user and environment, then restart the Brian API. Installing these tools fixes the prerequisite only; it does not repair an old upload route missing canonical admission.

The UI distinguishes preparation/admission failures, storage-transfer failures, completion failures, and unavailable media tools. Capture audio remains available in recorder recovery after failed processing. Do not discard it; use Save again after the updated server and media tools are ready.
