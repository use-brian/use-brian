import { describe, expect, it } from "vitest";
import { patchWebmDurationBytes } from "../webm-duration";

/**
 * Synthetic EBML builders — the shapes MediaRecorder actually writes:
 * an EBML header, then an UNKNOWN-size Segment whose Info carries a
 * TimestampScale but (in the streamed case) no Duration.
 */

function bytes(...parts: Array<number[] | Uint8Array>): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p instanceof Uint8Array ? p : Uint8Array.from(p), off);
    off += p.length;
  }
  return out;
}

/** 1-byte size vint (values under 127). */
const size1 = (n: number) => [0x80 | n];

const EBML_HEADER = bytes([0x1a, 0x45, 0xdf, 0xa3], size1(4), [0, 0, 0, 0]);
/** TimestampScale 1,000,000 (ns per unit → 1 ms). */
const TIMESTAMP_SCALE = bytes([0x2a, 0xd7, 0xb1], size1(3), [0x0f, 0x42, 0x40]);
const SEGMENT_ID = [0x18, 0x53, 0x80, 0x67];
const UNKNOWN_SIZE = [0xff];
const INFO_ID = [0x15, 0x49, 0xa9, 0x66];
/** Fake cluster tail — must survive the patch byte-for-byte. */
const TAIL = bytes([0x1f, 0x43, 0xb6, 0x75], size1(4), [9, 9, 9, 9]);

function findDuration(head: Uint8Array): { value: number; size: number } | null {
  for (let i = 0; i < head.length - 2; i++) {
    if (head[i] === 0x44 && head[i + 1] === 0x89) {
      const sizeByte = head[i + 2];
      const size = sizeByte & 0x7f;
      const view = new DataView(head.buffer, head.byteOffset + i + 3, size);
      return { value: size === 4 ? view.getFloat32(0) : view.getFloat64(0), size };
    }
  }
  return null;
}

describe("[COMP:app-web/recorder-gesture] WebM duration patch", () => {
  it("appends a Duration to a streamed (unknown-size Segment) header and keeps the tail", () => {
    const info = bytes(INFO_ID, size1(TIMESTAMP_SCALE.length), TIMESTAMP_SCALE);
    const head = bytes(EBML_HEADER, SEGMENT_ID, UNKNOWN_SIZE, info, TAIL);
    const patched = patchWebmDurationBytes(head, 754_000);
    expect(patched).not.toBeNull();
    const dur = findDuration(patched!);
    // TimestampScale 1e6 → Duration units == ms.
    expect(dur?.value).toBe(754_000);
    expect(dur?.size).toBe(8);
    // The cluster tail is preserved byte-for-byte after the grown Info.
    expect([...patched!.slice(patched!.length - TAIL.length)]).toEqual([...TAIL]);
  });

  it("defaults TimestampScale to 1e6 when Info omits it", () => {
    const info = bytes(INFO_ID, size1(0));
    const head = bytes(EBML_HEADER, SEGMENT_ID, UNKNOWN_SIZE, info, TAIL);
    const patched = patchWebmDurationBytes(head, 12_345);
    expect(findDuration(patched!)?.value).toBe(12_345);
  });

  it("patches an existing Duration in place (same length, offsets untouched)", () => {
    const oldDuration = bytes([0x44, 0x89], [0x88], [0, 0, 0, 0, 0, 0, 0, 0]);
    const infoBody = bytes(TIMESTAMP_SCALE, oldDuration);
    const info = bytes(INFO_ID, size1(infoBody.length), infoBody);
    const head = bytes(EBML_HEADER, SEGMENT_ID, UNKNOWN_SIZE, info, TAIL);
    const patched = patchWebmDurationBytes(head, 90_000);
    expect(patched).not.toBeNull();
    expect(patched!.length).toBe(head.length);
    expect(findDuration(patched!)?.value).toBe(90_000);
  });

  it("bails (null) on a KNOWN-size Segment that an insert would corrupt", () => {
    const info = bytes(INFO_ID, size1(TIMESTAMP_SCALE.length), TIMESTAMP_SCALE);
    const head = bytes(EBML_HEADER, SEGMENT_ID, size1(info.length), info);
    expect(patchWebmDurationBytes(head, 60_000)).toBeNull();
  });

  it("but patches in place inside a known-size Segment when Duration already exists", () => {
    const oldDuration = bytes([0x44, 0x89], [0x88], [0, 0, 0, 0, 0, 0, 0, 0]);
    const infoBody = bytes(TIMESTAMP_SCALE, oldDuration);
    const info = bytes(INFO_ID, size1(infoBody.length), infoBody);
    const head = bytes(EBML_HEADER, SEGMENT_ID, size1(info.length), info);
    const patched = patchWebmDurationBytes(head, 42_000);
    expect(patched).not.toBeNull();
    expect(findDuration(patched!)?.value).toBe(42_000);
  });

  it("bails on garbage, a missing Info, and a non-positive duration", () => {
    expect(patchWebmDurationBytes(Uint8Array.from([1, 2, 3]), 1000)).toBeNull();
    const noInfo = bytes(EBML_HEADER, SEGMENT_ID, UNKNOWN_SIZE, TAIL);
    expect(patchWebmDurationBytes(noInfo, 1000)).toBeNull();
    const info = bytes(INFO_ID, size1(0));
    const head = bytes(EBML_HEADER, SEGMENT_ID, UNKNOWN_SIZE, info);
    expect(patchWebmDurationBytes(head, 0)).toBeNull();
  });
});
