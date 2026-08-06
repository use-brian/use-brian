import { describe, expect, it } from "vitest";
import {
  MAX_NATIVE_MESSAGE_BYTES,
  NativeMessageDecoder,
  encodeNativeMessage,
} from "../firefox-native-host.js";

describe("[COMP:ext/firefox-companion] native-message framing", () => {
  it("decodes fragmented and coalesced little-endian frames", () => {
    const first = encodeNativeMessage({ id: "1", type: "status" });
    const second = encodeNativeMessage({ id: "2", type: "stop" });
    const decoder = new NativeMessageDecoder();
    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
      { id: "1", type: "status" },
      { id: "2", type: "stop" },
    ]);
  });

  it("rejects oversized frames before allocating their body", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1);
    expect(() => new NativeMessageDecoder().push(header)).toThrow("native_message_too_large");
  });
});
