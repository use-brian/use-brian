import { afterEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-fetch", () => ({ authFetch }));

import {
  approveFeedDraft,
  createFeedDraftSession,
  createFeedVoiceMemory,
  deleteFeedDraftSession,
  deleteFeedPublishedPost,
  deleteFeedVoiceMemory,
  disconnectFeedProfile,
  fetchFeedApprovalsCount,
  fetchFeedAssistantApprovals,
  fetchFeedAssistantEvents,
  fetchFeedAssistantProfiles,
  fetchFeedDraftSessions,
  fetchFeedCloudLink,
  fetchFeedExternalPost,
  fetchFeedInsights,
  fetchFeedInspiration,
  fetchFeedMentions,
  fetchFeedQuotes,
  fetchFeedSavedDrafts,
  fetchFeedSessionIdByChannel,
  fetchFeedTeamProfiles,
  fetchFeedVoiceMemories,
  fetchFeedWorkspaceMembers,
  rejectFeedDraft,
  removeFeedSavedDraftRecord,
  runFeedInspirationScan,
  saveFeedInspirationConfig,
  saveFeedSessionDraft,
  startFeedCloudLink,
  sendFeedDraftTypingPing,
  updateFeedMemberDraftPermission,
  updateFeedProfilePolicy,
  updateFeedVoiceMemory,
} from "@/lib/api/feed";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  authFetch.mockReset();
});

describe("[COMP:app-web/feed-sdk] feed SDK", () => {
  describe("[COMP:app-web/feed-cloud-link] Cloud Link", () => {
    it("reads and starts the paid OSS Feed Cloud Link", async () => {
      authFetch
        .mockResolvedValueOnce(jsonResponse({ state: "unlinked" }))
        .mockResolvedValueOnce(jsonResponse({
          state: "pending",
          userCode: "ABCD-EFGH",
          verificationUrl: "https://app.example/cloud-link?code=ABCD-EFGH",
        }, true, 201));
      await expect(fetchFeedCloudLink("ws-1")).resolves.toEqual({ state: "unlinked" });
      await expect(startFeedCloudLink("ws-1", "a-1")).resolves.toMatchObject({
        state: "pending",
        userCode: "ABCD-EFGH",
      });
      expect(authFetch).toHaveBeenLastCalledWith(
        expect.stringContaining("/api/self-host-feed/ws-1/start"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ assistantId: "a-1" }),
        }),
      );
    });
  });

  it("fetches and maps the workspace's connected profiles", async () => {
    authFetch.mockResolvedValueOnce(
      jsonResponse({
        profiles: [
          {
            assistantId: "a-1",
            platform: "threads",
            platformHandle: "acme",
            profilePictureUrl: null,
            enabled: true,
            assistant: {
              id: "a-1",
              name: "Acme Feed",
              kind: "app",
              appType: "distribution",
              iconSeed: null,
            },
          },
        ],
      }),
    );
    const profiles = await fetchFeedTeamProfiles("ws-1");
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/distribution/team/ws-1/profiles"),
    );
    expect(profiles).toEqual([
      {
        assistantId: "a-1",
        platform: "threads",
        platformHandle: "acme",
        profilePictureUrl: null,
        enabled: true,
        // A pre-iconSeed row maps to the stable 0 seed.
        assistant: { id: "a-1", name: "Acme Feed", iconSeed: 0 },
      },
    ]);
  });

  it("returns an empty list when the backend answers with no profiles", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(fetchFeedTeamProfiles("ws-1")).resolves.toEqual([]);
  });

  it("throws on a non-OK response so availability probes can degrade", async () => {
    // An OSS/creds-less backend 404s the whole /api/distribution family.
    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 404));
    await expect(fetchFeedTeamProfiles("ws-1")).rejects.toThrow("feed API 404");
  });

  it("sums pending approvals across assistants, deduped by caller", async () => {
    authFetch
      .mockResolvedValueOnce(jsonResponse({ approvals: [{}, {}] }))
      .mockResolvedValueOnce(jsonResponse({ approvals: [{}] }));
    await expect(fetchFeedApprovalsCount(["a-1", "a-2"])).resolves.toBe(3);
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/distribution/a-1/approvals?limit=200"),
    );
  });

  it("fetches assistant events with limit + eventTypes params", async () => {
    const row = {
      id: "e-1",
      platform: "threads",
      eventType: "drafted",
      metadata: { text: "hello", sessionId: "s-1" },
      createdAt: "2026-07-07T00:00:00.000Z",
    };
    authFetch.mockResolvedValueOnce(jsonResponse({ events: [row] }));
    const events = await fetchFeedAssistantEvents("a-1", {
      limit: 20,
      eventTypes: ["drafted", "posted-reply"],
    });
    expect(events).toEqual([row]);
    const url = authFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/distribution/a-1/events");
    expect(url).toContain("limit=20");
    expect(url).toContain(encodeURIComponent("drafted,posted-reply"));
  });

  it("dashboard degrade contract: events and approvals return [] on a non-OK response", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 404));
    await expect(fetchFeedAssistantEvents("a-1")).resolves.toEqual([]);

    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    await expect(fetchFeedAssistantApprovals("a-1")).resolves.toEqual([]);
  });

  it("fetches an assistant's pending approval rows", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({ approvals: [{ id: "ap-1" }] }));
    const approvals = await fetchFeedAssistantApprovals("a-1", { limit: 200 });
    expect(approvals).toEqual([{ id: "ap-1" }]);
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/distribution/a-1/approvals?limit=200"),
    );
  });

  it("approve: posts the approver's edited text to the approve endpoint", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await approveFeedDraft("a-1", "ev-1", { text: "edited" });
    expect(result).toEqual({ ok: true });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/distribution/a-1/approvals/ev-1/approve");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "edited" });
  });

  it("approve: no edit means an empty body (the saved draft posts verbatim); failures surface error + code", async () => {
    authFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "This draft has already been posted or rejected.",
          code: "DRAFT_NOT_PENDING",
        },
        false,
        409,
      ),
    );
    const result = await approveFeedDraft("a-1", "ev-1");
    const [, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({});
    expect(result).toEqual({
      ok: false,
      error: "This draft has already been posted or rejected.",
      code: "DRAFT_NOT_PENDING",
    });
  });

  it("approve: preserves a managed-delivery warning after local approval succeeds", async () => {
    authFetch.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        status: "ready",
        error: "The provider could not confirm delivery.",
      }),
    );
    await expect(approveFeedDraft("a-1", "ev-1")).resolves.toEqual({
      ok: true,
      status: "ready",
      error: "The provider could not confirm delivery.",
    });
  });

  it("reject: posts the dismissal reason (the inbox's dismiss action)", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await rejectFeedDraft("a-1", "ev-1", {
      reason: "dismissed-from-inbox",
    });
    expect(result).toEqual({ ok: true });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/distribution/a-1/approvals/ev-1/reject");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      reason: "dismissed-from-inbox",
    });
  });

  it("reject: a bodyless failure yields null error/code so callers pick their own copy", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    await expect(rejectFeedDraft("a-1", "ev-1")).resolves.toEqual({
      ok: false,
      error: null,
      code: null,
    });
  });

  it("external-post: builds the permalink + platform query and returns the cached data", async () => {
    const data = {
      permalink: "https://www.threads.com/@someone/post/abc",
      authorHandle: "someone",
      authorProfilePictureUrl: null,
      text: "hello",
      spoilerRanges: null,
      mediaUrl: null,
      mediaType: "TEXT",
      timestamp: "2026-07-07T00:00:00.000Z",
      likes: 3,
      replies: 1,
      reposts: 0,
      quotes: 0,
    };
    authFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, data, fromCache: true }),
    );
    await expect(
      fetchFeedExternalPost("a-1", {
        permalink: "https://www.threads.com/@someone/post/abc",
        platform: "threads",
      }),
    ).resolves.toEqual(data);
    const url = authFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/distribution/a-1/external-post");
    expect(url).toContain(
      `permalink=${encodeURIComponent("https://www.threads.com/@someone/post/abc")}`,
    );
    expect(url).toContain("platform=threads");
  });

  it("external-post degrade contract: throws the server reason, or the HTTP status fallback", async () => {
    authFetch.mockResolvedValueOnce(
      jsonResponse(
        { error: "X previews are not configured on this server." },
        false,
        409,
      ),
    );
    await expect(
      fetchFeedExternalPost("a-1", {
        permalink: "https://www.x.com/s/status/1",
        platform: "twitter",
      }),
    ).rejects.toThrow("X previews are not configured on this server.");

    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 502));
    await expect(
      fetchFeedExternalPost("a-1", {
        permalink: "https://www.x.com/s/status/1",
        platform: "twitter",
      }),
    ).rejects.toThrow("HTTP 502");
  });

  it("badge contract: zero on empty input and zero on errors", async () => {
    await expect(fetchFeedApprovalsCount([])).resolves.toBe(0);
    expect(authFetch).not.toHaveBeenCalled();

    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    await expect(fetchFeedApprovalsCount(["a-1"])).resolves.toBe(0);

    authFetch.mockRejectedValueOnce(new Error("network"));
    await expect(fetchFeedApprovalsCount(["a-1"])).resolves.toBe(0);
  });

  // ── Voice (team-scope memories) — feed-web-consolidation §7.3 ──────────

  it("voice: fetches the team memories with the limit param", async () => {
    const memory = {
      id: "m-1",
      type: "voice",
      summary: "Sign off with the team.",
      detail: null,
      tags: ["tone"],
      sensitivity: "internal",
      updatedAt: "2026-07-07T00:00:00.000Z",
    };
    authFetch.mockResolvedValueOnce(
      jsonResponse({ memories: [memory], total: 1 }),
    );
    await expect(
      fetchFeedVoiceMemories("a-1", { limit: 100 }),
    ).resolves.toEqual({ memories: [memory], total: 1 });
    const url = authFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/assistants/a-1/memories/team");
    expect(url).toContain("limit=100");
  });

  it("voice: the list throws on a non-OK response (load-failed banner)", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    await expect(fetchFeedVoiceMemories("a-1")).rejects.toThrow(
      "memories API 500",
    );
  });

  it("voice: create POSTs the form fields; failures surface the server error", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const input = {
      summary: "Always sign off with the team.",
      detail: undefined,
      type: "voice",
      tags: ["tone", "sign-off"],
      sensitivity: "internal",
    };
    await expect(createFeedVoiceMemory("a-1", input)).resolves.toEqual({
      ok: true,
    });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/assistants/a-1/memories/team");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      summary: "Always sign off with the team.",
      type: "voice",
      tags: ["tone", "sign-off"],
      sensitivity: "internal",
    });

    authFetch.mockResolvedValueOnce(
      jsonResponse({ error: "Summary too long" }, false, 400),
    );
    await expect(createFeedVoiceMemory("a-1", input)).resolves.toEqual({
      ok: false,
      error: "Summary too long",
    });
  });

  it("voice: update PATCHes the rule WITHOUT a type field (feed-web parity)", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(
      updateFeedVoiceMemory("a-1", "m-1", {
        summary: "Sharper rule",
        detail: "Context",
        tags: [],
        sensitivity: "public",
      }),
    ).resolves.toEqual({ ok: true });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/assistants/a-1/memories/m-1");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      summary: "Sharper rule",
      detail: "Context",
      tags: [],
      sensitivity: "public",
    });
    expect("type" in body).toBe(false);
  });

  it("voice: delete is fire-and-forget — a non-OK response does not throw", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    await expect(deleteFeedVoiceMemory("a-1", "m-1")).resolves.toBeUndefined();
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/assistants/a-1/memories/m-1");
    expect(init.method).toBe("DELETE");
  });

  it("tuning session: resolves the by-channel session id; 404 and network errors degrade to null", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({ id: "s-1" }));
    await expect(
      fetchFeedSessionIdByChannel("a-1", "tuning"),
    ).resolves.toBe("s-1");
    const url = authFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/sessions/by-channel");
    expect(url).toContain("assistantId=a-1");
    expect(url).toContain("channelId=tuning");

    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 404));
    await expect(
      fetchFeedSessionIdByChannel("a-1", "tuning"),
    ).resolves.toBeNull();

    authFetch.mockRejectedValueOnce(new Error("network"));
    await expect(
      fetchFeedSessionIdByChannel("a-1", "tuning"),
    ).resolves.toBeNull();
  });

  // ── Draft sessions (Phase 5 — docs/plans/feed-web-consolidation.md §7.4) ──

  it("draft sessions: lists the platform's sessions; throws on non-OK (load banner)", async () => {
    const row = { id: "s-1", platform: "threads", title: "T" };
    authFetch.mockResolvedValueOnce(jsonResponse({ sessions: [row] }));
    await expect(fetchFeedDraftSessions("a-1", "threads")).resolves.toEqual([
      row,
    ]);
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining(
        "/api/distribution/a-1/draft-sessions?platform=threads",
      ),
    );

    // Missing key degrades to [].
    authFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(fetchFeedDraftSessions("a-1", "twitter")).resolves.toEqual([]);

    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    await expect(fetchFeedDraftSessions("a-1", "threads")).rejects.toThrow(
      "draft sessions API 500",
    );
  });

  it("draft sessions: create POSTs platform + explicit seed; omits seed when absent", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({ session: { id: "s-9" } }));
    const seed = {
      kind: "freeform-reply" as const,
      candidate: {
        platform: "threads" as const,
        externalId: "DX4FjS5Gl5x",
        authorHandle: "acme",
        text: "",
        permalink: "https://www.threads.com/@acme/post/DX4FjS5Gl5x",
      },
    };
    const created = await createFeedDraftSession("a-1", {
      platform: "threads",
      seed,
      title: "Launch lesson",
    });
    expect(created).toEqual({ ok: true, session: { id: "s-9" } });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/distribution/a-1/draft-sessions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      platform: "threads",
      seed,
      title: "Launch lesson",
    });

    authFetch.mockResolvedValueOnce(jsonResponse({ session: { id: "s-10" } }));
    await createFeedDraftSession("a-1", { platform: "twitter" });
    const [, init2] = authFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init2.body as string)).toEqual({ platform: "twitter" });

    // Failure surfaces the server's error for the caller's copy.
    authFetch.mockResolvedValueOnce(
      jsonResponse({ error: "nope" }, false, 403),
    );
    await expect(
      createFeedDraftSession("a-1", { platform: "threads" }),
    ).resolves.toEqual({ ok: false, error: "nope" });
  });

  it("draft sessions: discard DELETEs the session; bodyless failure yields null error", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(deleteFeedDraftSession("a-1", "s-1")).resolves.toEqual({
      ok: true,
    });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/distribution/a-1/draft-sessions/s-1");
    expect(init.method).toBe("DELETE");

    authFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("no body");
      },
    } as unknown as Response);
    await expect(deleteFeedDraftSession("a-1", "s-1")).resolves.toEqual({
      ok: false,
      error: null,
    });
  });

  it("saved drafts: fetch returns the rows; non-OK degrades to null (panel stays stale)", async () => {
    const draft = { id: "e-1", status: "pending" };
    authFetch.mockResolvedValueOnce(jsonResponse({ drafts: [draft] }));
    await expect(fetchFeedSavedDrafts("a-1", "s-1")).resolves.toEqual([draft]);
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining(
        "/api/distribution/a-1/draft-sessions/s-1/saved-drafts",
      ),
    );

    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    await expect(fetchFeedSavedDrafts("a-1", "s-1")).resolves.toBeNull();
  });

  it("save-draft: POSTs text/platform/topicTag/reply verbatim and surfaces the resolver outcome", async () => {
    authFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, reply: { resolved: false, reason: "invalid_shortcode" } }),
    );
    const body = {
      text: "Hello",
      platform: "threads" as const,
      topicTag: "hongkong",
      reply: {
        externalId: "DX4FjS5Gl5x",
        authorHandle: "acme",
        text: "parent",
        permalink: "https://www.threads.com/@acme/post/DX4FjS5Gl5x",
      },
    };
    await expect(saveFeedSessionDraft("a-1", "s-1", body)).resolves.toEqual({
      ok: true,
      reply: { resolved: false, reason: "invalid_shortcode" },
    });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      "/api/distribution/a-1/draft-sessions/s-1/save-draft",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(body);

    authFetch.mockResolvedValueOnce(
      jsonResponse({ error: "text too long" }, false, 400),
    );
    await expect(
      saveFeedSessionDraft("a-1", "s-1", { text: "x", platform: "threads" }),
    ).resolves.toEqual({ ok: false, error: "text too long" });
  });

  it("delete-published: DELETEs the platform media id; failure surfaces the server error", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(deleteFeedPublishedPost("a-1", "m-77")).resolves.toEqual({
      ok: true,
    });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/distribution/a-1/posts/m-77");
    expect(init.method).toBe("DELETE");

    authFetch.mockResolvedValueOnce(
      jsonResponse({ error: "already gone" }, false, 404),
    );
    await expect(deleteFeedPublishedPost("a-1", "m-77")).resolves.toEqual({
      ok: false,
      error: "already gone",
    });
  });

  it("saved-draft remove: POSTs the record-only removal with an empty JSON body", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(removeFeedSavedDraftRecord("a-1", "e-5")).resolves.toEqual({
      ok: true,
    });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/distribution/a-1/saved-drafts/e-5/remove");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");

    authFetch.mockResolvedValueOnce(
      jsonResponse({ error: "not posted" }, false, 400),
    );
    await expect(removeFeedSavedDraftRecord("a-1", "e-5")).resolves.toEqual({
      ok: false,
      error: "not posted",
    });
  });

  it("typing ping: fire-and-forget — network failure never throws", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(
      sendFeedDraftTypingPing("a-1", "s-1", true),
    ).resolves.toBeUndefined();
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      "/api/distribution/a-1/draft-sessions/s-1/typing",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ isTyping: true });

    authFetch.mockRejectedValueOnce(new Error("network"));
    await expect(
      sendFeedDraftTypingPing("a-1", "s-1", false),
    ).resolves.toBeUndefined();
  });

  // ── Insights + inspiration (Phase 6 — docs/plans/feed-web-consolidation.md §7.5) ──

  it("insights: fetches the range dashboard; non-OK surfaces the server reason (banner contract)", async () => {
    const body = {
      handle: "acme",
      range: { since: "2026-07-01", until: "2026-07-08" },
      priorRange: null,
      profile: { views: 10 },
      priorProfile: null,
      trends: [],
      posts: [],
    };
    authFetch.mockResolvedValueOnce(jsonResponse(body));
    await expect(
      fetchFeedInsights("a-1", "threads", {
        since: "2026-07-01T00:00:00.000Z",
        until: "2026-07-08T00:00:00.000Z",
      }),
    ).resolves.toEqual(body);
    const url = authFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/distribution/a-1/threads/insights?");
    expect(url).toContain(encodeURIComponent("2026-07-01T00:00:00.000Z"));
    expect(url).toContain(`until=${encodeURIComponent("2026-07-08T00:00:00.000Z")}`);

    authFetch.mockResolvedValueOnce(
      jsonResponse({ error: "insights disabled" }, false, 400),
    );
    await expect(
      fetchFeedInsights("a-1", "twitter", { since: "s", until: "u" }),
    ).rejects.toThrow("insights disabled");

    // Bodyless failure falls back to the HTTP status.
    authFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("no body");
      },
    } as unknown as Response);
    await expect(
      fetchFeedInsights("a-1", "threads", { since: "s", until: "u" }),
    ).rejects.toThrow("HTTP 502");
  });

  it("insights: mentions and quotes carry days+limit and degrade to [] on non-OK", async () => {
    const mention = { id: "m-1", text: "hi", username: "bob", timestamp: null };
    authFetch.mockResolvedValueOnce(jsonResponse({ mentions: [mention] }));
    await expect(
      fetchFeedMentions("a-1", "threads", { days: 7, limit: 20 }),
    ).resolves.toEqual([mention]);
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining(
        "/api/distribution/a-1/threads/mentions?days=7&limit=20",
      ),
    );

    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    await expect(
      fetchFeedMentions("a-1", "twitter", { days: 30, limit: 20 }),
    ).resolves.toEqual([]);

    // Quotes are twitter-scoped — no platform segment argument.
    authFetch.mockResolvedValueOnce(jsonResponse({ quotes: [mention] }));
    await expect(
      fetchFeedQuotes("a-1", { days: 90, limit: 20 }),
    ).resolves.toEqual([mention]);
    expect(authFetch).toHaveBeenLastCalledWith(
      expect.stringContaining(
        "/api/distribution/a-1/twitter/quotes?days=90&limit=20",
      ),
    );

    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 404));
    await expect(
      fetchFeedQuotes("a-1", { days: 7, limit: 20 }),
    ).resolves.toEqual([]);
  });

  it("inspiration: GET returns config + connection; non-OK throws for the caller's degrade", async () => {
    const config = { keywords: ["ai"], resultCount: 5 };
    const connection = {
      connected: true,
      handle: "acme",
      scope: "tweet.read",
      hasListReadScope: false,
    };
    authFetch.mockResolvedValueOnce(jsonResponse({ config, connection }));
    await expect(fetchFeedInspiration("a-1", "twitter")).resolves.toEqual({
      config,
      connection,
    });
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/distribution/a-1/twitter/inspiration"),
    );

    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 404));
    await expect(fetchFeedInspiration("a-1", "threads")).rejects.toThrow(
      "inspiration API 404",
    );
  });

  it("inspiration: PUT sends the config verbatim and returns the server echo; non-OK throws", async () => {
    const config = { keywords: ["ai", "agents"], resultCount: 8 };
    authFetch.mockResolvedValueOnce(jsonResponse({ config }));
    await expect(
      saveFeedInspirationConfig("a-1", "threads", config),
    ).resolves.toEqual(config);
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/distribution/a-1/threads/inspiration");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual(config);

    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 403));
    await expect(
      saveFeedInspirationConfig("a-1", "twitter", config),
    ).rejects.toThrow("inspiration API 403");
  });

  it("inspiration: scan POSTs and maps candidates + per-keyword errors; failure surfaces the server error", async () => {
    const candidate = {
      platform: "twitter",
      externalId: "123",
      text: "hello",
      author: { handle: "bob" },
      publishedAt: "2026-07-07T00:00:00.000Z",
      engagement: { likes: 2 },
      source: "keyword:ai",
    };
    authFetch.mockResolvedValueOnce(
      jsonResponse({
        candidates: [candidate],
        errors: [{ keyword: "ai", message: "rate limited" }],
      }),
    );
    await expect(runFeedInspirationScan("a-1", "twitter")).resolves.toEqual({
      ok: true,
      candidates: [candidate],
      warnings: [{ keyword: "ai", message: "rate limited" }],
    });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/distribution/a-1/twitter/inspiration/scan");
    expect(init.method).toBe("POST");

    // Missing keys degrade to empty lists.
    authFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(runFeedInspirationScan("a-1", "threads")).resolves.toEqual({
      ok: true,
      candidates: [],
      warnings: [],
    });

    authFetch.mockResolvedValueOnce(
      jsonResponse({ error: "X is not connected on this assistant" }, false, 400),
    );
    await expect(runFeedInspirationScan("a-1", "twitter")).resolves.toEqual({
      ok: false,
      error: "X is not connected on this assistant",
    });
  });

  it("draft sessions: create passes an inspiration seed through verbatim (no permalink)", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({ session: { id: "s-11" } }));
    const seed = {
      kind: "inspiration-reply" as const,
      candidate: {
        platform: "twitter" as const,
        externalId: "1234567890",
        authorHandle: "bob",
        text: "worth replying to",
      },
    };
    const created = await createFeedDraftSession("a-1", {
      platform: "twitter",
      seed,
    });
    expect(created).toEqual({ ok: true, session: { id: "s-11" } });
    const [, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      platform: "twitter",
      seed,
    });
  });

  it("profile detail: GET /:assistantId returns the policy-bearing profiles; non-OK throws for the page banner", async () => {
    const profiles = [
      {
        assistantId: "a-1",
        platform: "threads",
        platformHandle: "acme",
        enabled: true,
        autoReplyMode: "draft-only",
        replyPolicy: { whitelistHandles: ["bob"], blockedTopics: [] },
      },
    ];
    authFetch.mockResolvedValueOnce(jsonResponse({ profiles }));
    await expect(fetchFeedAssistantProfiles("a-1")).resolves.toEqual(profiles);
    const url = authFetch.mock.calls[0][0] as string;
    expect(url).toMatch(/\/api\/distribution\/a-1$/);

    // Missing key degrades to an empty list.
    authFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(fetchFeedAssistantProfiles("a-1")).resolves.toEqual([]);

    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    await expect(fetchFeedAssistantProfiles("a-1")).rejects.toThrow(
      "profile API 500",
    );
  });

  it("policy update: PATCHes mode + replyPolicy verbatim; failure surfaces the server error", async () => {
    const body = {
      autoReplyMode: "auto-whitelisted" as const,
      replyPolicy: { whitelistHandles: ["bob"], blockedTopics: ["pricing"] },
    };
    authFetch.mockResolvedValueOnce(jsonResponse({ profile: {} }));
    await expect(
      updateFeedProfilePolicy("a-1", "threads", body),
    ).resolves.toEqual({ ok: true });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/distribution/a-1/threads");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual(body);

    authFetch.mockResolvedValueOnce(
      jsonResponse({ error: "Profile not found for this platform" }, false, 404),
    );
    await expect(
      updateFeedProfilePolicy("a-1", "twitter", body),
    ).resolves.toEqual({
      ok: false,
      error: "Profile not found for this platform",
    });
  });

  it("disconnect: DELETEs the platform profile; failure surfaces the server error (null fallback)", async () => {
    authFetch.mockResolvedValueOnce(
      jsonResponse({ disconnected: true, platform: "threads" }),
    );
    await expect(disconnectFeedProfile("a-1", "threads")).resolves.toEqual({
      ok: true,
    });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/distribution/a-1/threads");
    expect(init.method).toBe("DELETE");

    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    await expect(disconnectFeedProfile("a-1", "twitter")).resolves.toEqual({
      ok: false,
      error: null,
    });
  });

  it("workspace members: GET returns the detail's members list; non-OK throws for the page banner", async () => {
    const members = [
      {
        userId: "u-1",
        email: "a@b.c",
        userName: "Ada",
        avatarUrl: null,
        role: "owner",
        canDraft: true,
      },
    ];
    authFetch.mockResolvedValueOnce(jsonResponse({ id: "ws-1", members }));
    await expect(fetchFeedWorkspaceMembers("ws-1")).resolves.toEqual(members);
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/workspaces/ws-1"),
    );

    // Missing key degrades to an empty list.
    authFetch.mockResolvedValueOnce(jsonResponse({ id: "ws-1" }));
    await expect(fetchFeedWorkspaceMembers("ws-1")).resolves.toEqual([]);

    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 403));
    await expect(fetchFeedWorkspaceMembers("ws-1")).rejects.toThrow(
      "workspace API 403",
    );
  });

  it("member permission: PATCHes { canDraft }; failure surfaces the server error", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({ ok: true, canDraft: true }));
    await expect(
      updateFeedMemberDraftPermission("ws-1", "u-2", true),
    ).resolves.toEqual({ ok: true });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/workspaces/ws-1/members/u-2/permissions");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ canDraft: true });

    authFetch.mockResolvedValueOnce(
      jsonResponse(
        { error: "Admins and owners always have draft permission." },
        false,
        400,
      ),
    );
    await expect(
      updateFeedMemberDraftPermission("ws-1", "u-3", false),
    ).resolves.toEqual({
      ok: false,
      error: "Admins and owners always have draft permission.",
    });
  });
});

/**
 * Regression: `NEXT_PUBLIC_API_URL` is deliberately `""` in development
 * (`next.config.ts` routes the browser through the `/api` rewrite), so every
 * SDK call has to survive a RELATIVE base. Four functions used
 * `new URL(`${API_URL}/api/…`)`, which throws `Invalid URL` with no base -
 * before any fetch fired, so the caller's catch showed a bare "failed to load"
 * with no request in the network tab at all. That is exactly how the Voice
 * surface broke in local dev (2026-07-29).
 *
 * These assert the query-carrying calls still reach `authFetch` (i.e. do not
 * throw) and keep their params. `API_URL` is baked at import time, and the
 * suite's default is the absolute fallback, so the throw itself is pinned by
 * the explicit relative-base construction below.
 */
describe("[COMP:app-web/feed-sdk] relative API base (dev rewrite)", () => {
  it("never builds a request URL with `new URL` on a relative base", () => {
    // The construction the SDK must avoid: this is what threw in dev.
    expect(() => new URL("/api/assistants/a-1/memories/team")).toThrow();
    // The construction it uses instead: a plain string, valid either way.
    const query = new URLSearchParams({ limit: "100" }).toString();
    expect(`${""}/api/assistants/a-1/memories/team?${query}`).toBe(
      "/api/assistants/a-1/memories/team?limit=100",
    );
  });

  it("sends query params on the calls that carry them", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({ memories: [], total: 0 }));
    await fetchFeedVoiceMemories("a-1", { limit: 100 });
    expect(authFetch.mock.calls[0][0]).toContain(
      "/api/assistants/a-1/memories/team?limit=100",
    );

    authFetch.mockResolvedValueOnce(jsonResponse({ events: [] }));
    await fetchFeedAssistantEvents("a-1", {
      limit: 20,
      eventTypes: ["drafted", "post-created"],
    });
    const eventsUrl = authFetch.mock.calls[1][0] as string;
    expect(eventsUrl).toContain("limit=20");
    expect(eventsUrl).toContain("eventTypes=drafted%2Cpost-created");

    authFetch.mockResolvedValueOnce(jsonResponse({ approvals: [] }));
    await fetchFeedAssistantApprovals("a-1", { limit: 200 });
    expect(authFetch.mock.calls[2][0]).toContain("limit=200");
  });

  it("omits the query string entirely when no params are supplied", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({ events: [] }));
    await fetchFeedAssistantEvents("a-1");
    expect(authFetch.mock.calls[0][0]).not.toContain("?");
  });
});
