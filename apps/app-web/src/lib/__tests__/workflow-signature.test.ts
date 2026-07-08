/**
 * HMAC SHA-256 signature helper tests for the workflow webhook test
 * pane. Component tag: [COMP:app-web/workflow] (ported from apps/web at the helper-copy deletion).
 *
 * The fixture is reproducible via openssl:
 *   echo -n '{"hello":"world"}' | openssl dgst -sha256 -hmac 'test-secret'
 *
 * Spec: docs/plans/company-brain/workflow-builder.md → Webhook UI polish.
 */

import { describe, expect, it } from "vitest"
import {
  computeWebhookSignature,
  curlSnippet,
  hmacSha256Hex,
  nodeSnippet,
  pythonSnippet,
} from "../workflow-signature"

describe("[COMP:app-web/workflow] webhook signature", () => {
  it("matches the openssl-derived fixture", async () => {
    const fixture =
      "84cc33df716ed0b0598f07437c94069ace3730358778a592bd6bbd1423d111f3"
    const hex = await hmacSha256Hex("test-secret", '{"hello":"world"}')
    expect(hex).toBe(fixture)
  })

  it("formats the header value with the sha256= prefix", async () => {
    const header = await computeWebhookSignature(
      "test-secret",
      '{"hello":"world"}',
    )
    expect(header.startsWith("sha256=")).toBe(true)
    expect(header.slice("sha256=".length)).toMatch(/^[a-f0-9]{64}$/)
  })

  it("produces a deterministic digest for the same input", async () => {
    const a = await hmacSha256Hex("secret", "body")
    const b = await hmacSha256Hex("secret", "body")
    expect(a).toBe(b)
  })

  it("changes the digest when the body differs by one byte", async () => {
    const a = await hmacSha256Hex("secret", "body")
    const b = await hmacSha256Hex("secret", "bodY")
    expect(a).not.toBe(b)
  })

  it("renders snippets that mention the right header", () => {
    expect(curlSnippet("https://example.com", "secret", "{}")).toContain(
      "X-Workflow-Signature",
    )
    expect(nodeSnippet("https://example.com", "secret")).toContain(
      "X-Workflow-Signature",
    )
    expect(pythonSnippet("https://example.com", "secret")).toContain(
      "X-Workflow-Signature",
    )
  })
})
