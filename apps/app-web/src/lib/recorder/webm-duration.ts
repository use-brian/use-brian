/**
 * WebM duration patch for live captures (docs/architecture/media/live-capture.md
 * → "The duration gotcha").
 *
 * MediaRecorder streams its webm out chunk by chunk, so the container it
 * writes carries an unknown-size Segment and NO `Duration` element in the
 * `Info` header — `ffprobe -show_entries format=duration` reads `N/A`
 * (verified against a streamed ffmpeg webm). The server estimate route bills
 * off exactly that probe (`recordings/ffprobe-duration.ts`) and rejects an
 * unreadable duration (`could_not_read_duration`), so an unpatched live
 * capture could never enter the recording pipeline.
 *
 * The recorder ran the clock, so it KNOWS the duration. This module writes
 * it into the header before upload: parse just enough EBML to find
 * `Segment → Info`, then either patch an existing `Duration` float in place
 * or rebuild `Info` with one appended. Appending grows `Info`, which is only
 * safe because a streamed Segment declares UNKNOWN size — when a Segment
 * declares a known size we bail to `null` rather than corrupt the offsets
 * (the caller uploads unpatched and the server's honest
 * `could_not_read_duration` path takes over).
 *
 * Note the server remains the billing authority: it ffprobes the uploaded
 * bytes. This patch makes the container tell the truth; it does not replace
 * the server's read.
 *
 * Verified end-to-end (2026-07-22) against an ffmpeg-streamed webm:
 * `format=duration` went from `N/A` to the patched value and the file still
 * fully decodes. One known cosmetic: a file carrying a SeekHead has its
 * byte offsets go stale when Info grows (ffprobe logs an EBML-length
 * warning and recovers) — Chrome's MediaRecorder writes NO SeekHead in
 * live mode, so real captures are unaffected.
 *
 * Pure byte-level functions — unit-tested in node against synthetic EBML.
 *
 * [COMP:app-web/recorder-gesture]
 */

// EBML element ids (as written in the stream, marker bits included).
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMESTAMP_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

/** Matroska default when `Info` carries no TimestampScale: 1,000,000 ns = 1 ms. */
const DEFAULT_TIMESTAMP_SCALE = 1_000_000;

/** How much of the blob head we parse. The MediaRecorder header (EBML + SeekHead + Info) sits well inside this. */
const WEBM_HEAD_BYTES = 256 * 1024;

type Vint = { value: number; length: number; unknown: boolean };

/** Read an EBML element ID at `off` (marker bits kept, as compared against the ID constants). */
function readId(bytes: Uint8Array, off: number): Vint | null {
  if (off >= bytes.length) return null;
  const first = bytes[off];
  if (first === 0) return null;
  let length = 1;
  for (let mask = 0x80; (first & mask) === 0; mask >>= 1) length++;
  if (length > 4 || off + length > bytes.length) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[off + i];
  return { value, length, unknown: false };
}

/** Read an EBML size vint at `off` (marker bit stripped). `unknown` = all value bits set. */
function readSize(bytes: Uint8Array, off: number): Vint | null {
  if (off >= bytes.length) return null;
  const first = bytes[off];
  if (first === 0) return null;
  let length = 1;
  for (let mask = 0x80; (first & mask) === 0; mask >>= 1) length++;
  if (length > 8 || off + length > bytes.length) return null;
  let value = first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[off + i];
    if (bytes[off + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

/** Minimal-length EBML size vint for `value`. */
function encodeSize(value: number): Uint8Array {
  for (let length = 1; length <= 8; length++) {
    const max = Math.pow(2, 7 * length) - 2; // all-ones is reserved for "unknown"
    if (value <= max) {
      const out = new Uint8Array(length);
      let v = value;
      for (let i = length - 1; i >= 0; i--) {
        out[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      out[0] |= 0x80 >> (length - 1);
      return out;
    }
  }
  throw new Error("size too large for an EBML vint");
}

function readUint(bytes: Uint8Array, off: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + bytes[off + i];
  return v;
}

type Located = { idOff: number; bodyOff: number; bodyEnd: number };

/**
 * Locate `Segment → Info` in the head bytes. Returns the Info element's
 * offsets plus whether the enclosing Segment declared an unknown size (the
 * precondition for growing Info).
 */
function locateInfo(bytes: Uint8Array): (Located & { segmentUnknownSize: boolean }) | null {
  let off = 0;
  // Top level: skip elements until Segment.
  while (off < bytes.length) {
    const id = readId(bytes, off);
    if (!id) return null;
    const size = readSize(bytes, off + id.length);
    if (!size) return null;
    const bodyOff = off + id.length + size.length;
    if (id.value === ID_SEGMENT) {
      // Walk Segment children until Info.
      let child = bodyOff;
      const segEnd = size.unknown ? bytes.length : Math.min(bytes.length, bodyOff + size.value);
      while (child < segEnd) {
        const cid = readId(bytes, child);
        if (!cid) return null;
        const csize = readSize(bytes, child + cid.length);
        if (!csize || csize.unknown) return null;
        const cbody = child + cid.length + csize.length;
        if (cid.value === ID_INFO) {
          if (cbody + csize.value > bytes.length) return null; // Info truncated by the head slice
          return {
            idOff: child,
            bodyOff: cbody,
            bodyEnd: cbody + csize.value,
            segmentUnknownSize: size.unknown,
          };
        }
        child = cbody + csize.value;
      }
      return null;
    }
    if (size.unknown) return null; // unknown-size non-Segment at top level — malformed
    off = bodyOff + size.value;
  }
  return null;
}

/**
 * Patch `durationMs` into the webm header bytes. Returns the new head bytes,
 * or `null` when the container cannot be safely patched (no Info in the
 * slice, a known-size Segment that an insert would corrupt, a truncated
 * head). In-place when a Duration element already exists; otherwise rebuilds
 * Info with a float64 Duration appended.
 */
export function patchWebmDurationBytes(head: Uint8Array, durationMs: number): Uint8Array | null {
  if (!(durationMs > 0)) return null;
  const info = locateInfo(head);
  if (!info) return null;

  // Scan Info's children for TimestampScale + Duration.
  let scale = DEFAULT_TIMESTAMP_SCALE;
  let durationEl: { off: number; size: number; bodyOff: number } | null = null;
  let child = info.bodyOff;
  while (child < info.bodyEnd) {
    const cid = readId(head, child);
    if (!cid) return null;
    const csize = readSize(head, child + cid.length);
    if (!csize || csize.unknown) return null;
    const cbody = child + cid.length + csize.length;
    if (cid.value === ID_TIMESTAMP_SCALE) scale = readUint(head, cbody, csize.value);
    if (cid.value === ID_DURATION) durationEl = { off: child, size: csize.value, bodyOff: cbody };
    child = cbody + csize.value;
  }
  if (!(scale > 0)) return null;
  // Duration is expressed in TimestampScale units (scale = ns per unit).
  const durationUnits = (durationMs * 1_000_000) / scale;

  if (durationEl) {
    // Patch the existing float in place — same length, no offsets move.
    if (durationEl.size !== 4 && durationEl.size !== 8) return null;
    const out = head.slice();
    const view = new DataView(out.buffer, out.byteOffset + durationEl.bodyOff, durationEl.size);
    if (durationEl.size === 4) view.setFloat32(0, durationUnits);
    else view.setFloat64(0, durationUnits);
    return out;
  }

  // No Duration element (the MediaRecorder case): append one to Info. Only
  // safe under an unknown-size Segment — a known size would now be wrong.
  if (!info.segmentUnknownSize) return null;
  const durBody = new Uint8Array(8);
  new DataView(durBody.buffer).setFloat64(0, durationUnits);
  const durEl = new Uint8Array(2 + 1 + 8);
  durEl[0] = 0x44;
  durEl[1] = 0x89;
  durEl[2] = 0x88; // size vint: 8
  durEl.set(durBody, 3);

  const oldBody = head.subarray(info.bodyOff, info.bodyEnd);
  const newSize = encodeSize(oldBody.length + durEl.length);
  const idBytes = head.subarray(info.idOff, info.idOff + 4); // Info id is 4 bytes
  const out = new Uint8Array(
    info.idOff + idBytes.length + newSize.length + oldBody.length + durEl.length + (head.length - info.bodyEnd),
  );
  out.set(head.subarray(0, info.idOff), 0);
  let w = info.idOff;
  out.set(idBytes, w);
  w += idBytes.length;
  out.set(newSize, w);
  w += newSize.length;
  out.set(oldBody, w);
  w += oldBody.length;
  out.set(durEl, w);
  w += durEl.length;
  out.set(head.subarray(info.bodyEnd), w);
  return out;
}

/**
 * Patch a captured Blob's webm header with the recorder-measured duration.
 * Non-webm blobs and unpatchable containers return the ORIGINAL blob — the
 * degradation is the server's honest `could_not_read_duration` path, never a
 * corrupted upload. The tail past the parsed head rides as a lazy blob slice
 * (no full copy of the audio through memory).
 */
export async function patchRecordingBlob(blob: Blob, durationMs: number): Promise<Blob> {
  if (!blob.type.includes("webm")) return blob;
  try {
    const headLen = Math.min(blob.size, WEBM_HEAD_BYTES);
    const head = new Uint8Array(await blob.slice(0, headLen).arrayBuffer());
    const patched = patchWebmDurationBytes(head, durationMs);
    if (!patched) return blob;
    // `patched` is always a fresh, exact-size array — its buffer is safe to
    // hand to Blob (the cast bridges TS's ArrayBufferLike widening).
    return new Blob([patched.buffer as ArrayBuffer, blob.slice(headLen)], { type: blob.type });
  } catch {
    return blob;
  }
}
