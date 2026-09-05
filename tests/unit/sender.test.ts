import { describe, expect, it } from "vitest";
import { playRunBody, sendBody } from "../../src/background/sender";
import { verifySignature } from "../../src/shared/signing";
import type { PlayDestination, WebhookDestination } from "../../src/shared/types";

const dest: WebhookDestination = { id: "w1", kind: "webhook", name: "hook", favorite: false, url: "https://example.com/hook", signingSecret: "topsecret", signatureScheme: "lwe", authHeaderName: "Authorization", authHeaderValue: "Bearer abc", mappingPreset: "generic", sendMode: "single" };
const play: PlayDestination = { id: "p1", kind: "deepline_play", name: "Warm intro", favorite: true, baseUrl: "https://code.deepline.com", apiKey: "dl_key", playKey: "warm-intro", playName: "Warm intro", input: { mode: "mapped", fields: ["linkedin_url"], required: ["linkedin_url"], acceptsSearch: false, acceptsLeads: true } };

describe("sendBody (webhook)", () => {
  it("POSTs JSON with signature, timestamp, event id and auth header", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const body = JSON.stringify({ hello: "world" });
    const r = await sendBody(dest, body, "evt-1", { version: "0.1.0", fetchImpl, now: () => 1_700_000_000_000 });
    expect(r).toMatchObject({ ok: true, status: 200, retryable: false, error: null });
    const h = captured!.init.headers as Record<string, string>;
    expect(captured!.url).toBe(dest.url);
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.body).toBe(body);
    expect(captured!.init.credentials).toBe("omit");
    expect(captured!.init.redirect).toBe("error");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["X-LWE-Event-Id"]).toBe("evt-1");
    expect(h["X-LWE-Version"]).toBe("0.1.0");
    expect(h["Authorization"]).toBe("Bearer abc");
    expect(h["X-LWE-Timestamp"]).toBe("1700000000");
    expect(h["Idempotency-Key"]).toBe("evt-1");
    expect(h["x-deepline-dedupe-key"]).toBeUndefined();
    expect((await verifySignature("topsecret", body, 1_700_000_000, h["X-LWE-Signature"], 300, 1_700_000_000)).ok).toBe(true);
  });
  it("standard scheme emits Standard Webhooks headers and Deepline dedupe key", async () => {
    let h: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      h = init.headers as Record<string, string>;
      return new Response("", { status: 202 });
    }) as unknown as typeof fetch;
    const secret = "whsec_" + Buffer.from("raw-key-bytes").toString("base64");
    await sendBody({ ...dest, signatureScheme: "standard", signingSecret: secret, mappingPreset: "deepline" }, "{}", "evt-9-xxxxxxxx", { version: "x", fetchImpl, now: () => 1_700_000_000_000, dedupeKey: "https://www.linkedin.com/in/jane" });
    expect(h["webhook-id"]).toBe("evt-9-xxxxxxxx");
    expect(h["webhook-timestamp"]).toBe("1700000000");
    const { createHmac } = await import("node:crypto");
    expect(h["webhook-signature"]).toBe("v1," + createHmac("sha256", "raw-key-bytes").update("evt-9-xxxxxxxx.1700000000.{}").digest("base64"));
    expect(h["X-LWE-Signature"]).toBeUndefined();
    expect(h["x-deepline-dedupe-key"]).toBe("https://www.linkedin.com/in/jane");
    expect(h["Idempotency-Key"]).toBe("https://www.linkedin.com/in/jane");
  });
  it("omits signature headers when no secret is set", async () => {
    let h: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      h = init.headers as Record<string, string>;
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;
    await sendBody({ ...dest, signingSecret: "", authHeaderName: "", authHeaderValue: "" }, "{}", "e", { version: "x", fetchImpl });
    expect(h["X-LWE-Signature"]).toBeUndefined();
    expect(h["Authorization"]).toBeUndefined();
  });
  it("classifies HTTP failures and includes response text", async () => {
    const fetchImpl = (async () => new Response("bad signature", { status: 401 })) as unknown as typeof fetch;
    const r = await sendBody(dest, "{}", "e", { version: "x", fetchImpl });
    expect(r).toMatchObject({ ok: false, status: 401, retryable: false, error: "HTTP 401: bad signature" });
    const r5 = await sendBody(dest, "{}", "e", { version: "x", fetchImpl: (async () => new Response("", { status: 502 })) as unknown as typeof fetch });
    expect(r5.retryable).toBe(true);
  });
  it("treats network errors and timeouts as retryable", async () => {
    const r = await sendBody(dest, "{}", "e", { version: "x", fetchImpl: (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, status: null, retryable: true, error: "Failed to fetch" });
    const slow = ((_: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    const t = await sendBody(dest, "{}", "e", { version: "x", fetchImpl: slow, timeoutMs: 10 });
    expect(t).toMatchObject({ ok: false, status: null, retryable: true, error: "timeout" });
  });
});

describe("sendBody (Deepline play)", () => {
  it("POSTs the run request to /api/v2/plays/run with the API key and returns the run id", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ workflowId: "wf_123" }), { status: 202 });
    }) as unknown as typeof fetch;
    const body = playRunBody(play, { linkedin_url: "https://www.linkedin.com/in/jane" });
    expect(JSON.parse(body)).toEqual({ name: "warm-intro", input: { linkedin_url: "https://www.linkedin.com/in/jane" } });
    const r = await sendBody(play, body, "evt-2", { version: "0.2.0", fetchImpl, dedupeKey: "https://www.linkedin.com/in/jane" });
    expect(r).toMatchObject({ ok: true, status: 202, runId: "wf_123" });
    expect(captured!.url).toBe("https://code.deepline.com/api/v2/plays/run");
    const h = captured!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer dl_key");
    expect(h["Idempotency-Key"]).toBe("https://www.linkedin.com/in/jane");
    expect(h["x-deepline-dedupe-key"]).toBe("https://www.linkedin.com/in/jane");
    expect(h["X-LWE-Signature"]).toBeUndefined();
    expect(captured!.init.credentials).toBe("omit");
  });
  it("a rejected API key is not retried", async () => {
    const r = await sendBody(play, "{}", "e", { version: "x", fetchImpl: (async () => new Response('{"error":"unauthorized"}', { status: 401 })) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, status: 401, retryable: false });
  });
  it("only https or localhost base URLs are used", () => {
    expect(() => playRunBody({ ...play, baseUrl: "http://evil.example" }, {})).not.toThrow();
    expect(() => sendBody({ ...play, baseUrl: "http://evil.example" }, "{}", "e", { version: "x" })).rejects.toThrow(/https/);
  });
});
