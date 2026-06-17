/**
 * Unit tests for the offline connectivity classifier (pure).
 * [COMP:app-web/offline-connectivity]
 */

import { describe, expect, it } from "vitest";
import {
  classifyConnectivity,
  isEffectivelyOffline,
  shouldFlushQueue,
} from "../connectivity";

describe("[COMP:app-web/offline-connectivity] classifyConnectivity", () => {
  it("is online only when the network is up and collab is connected", () => {
    expect(classifyConnectivity({ navigatorOnline: true, collabConnected: true })).toBe("online");
  });

  it("is degraded when the network is up but collab is down", () => {
    expect(classifyConnectivity({ navigatorOnline: true, collabConnected: false })).toBe("degraded");
  });

  it("is offline whenever the network is down, regardless of collab", () => {
    expect(classifyConnectivity({ navigatorOnline: false, collabConnected: false })).toBe("offline");
    expect(classifyConnectivity({ navigatorOnline: false, collabConnected: true })).toBe("offline");
  });
});

describe("[COMP:app-web/offline-connectivity] isEffectivelyOffline", () => {
  it("treats degraded and offline as offline; only online is not", () => {
    expect(isEffectivelyOffline("online")).toBe(false);
    expect(isEffectivelyOffline("degraded")).toBe(true);
    expect(isEffectivelyOffline("offline")).toBe(true);
  });
});

describe("[COMP:app-web/offline-connectivity] shouldFlushQueue", () => {
  it("flushes on the rising edge into full online health", () => {
    expect(shouldFlushQueue("offline", "online")).toBe(true);
    expect(shouldFlushQueue("degraded", "online")).toBe(true);
  });

  it("does not flush when already online or when not reaching online", () => {
    expect(shouldFlushQueue("online", "online")).toBe(false);
    expect(shouldFlushQueue("offline", "degraded")).toBe(false);
    expect(shouldFlushQueue("online", "degraded")).toBe(false);
  });
});
