import { describe, expect, it } from "vitest";
import { sendBody } from "../../src/background/sender";
import { verifySignature } from "../../src/shared/signing";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

const settings = { ...DEFAULT_SETTINGS, webhookUrl: "https://example.com/hook", signingSecret: "topsecret", authHeaderName: "Authorization", authHeaderValue: "Bearer abc" };

describe("sendBody", () => {
  it("POSTs JSON with signature, timestamp, event id and auth header", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const body = JSON.stringify({ hello: "world" });
    const r = await sendBody(settings, body, "evt-1", { version: "0.1.0", fetchImpl, now: () => 1_700_000_000_000 });
    expect(r).toEqual({ ok: true, status: 200, retryable: false, error: null });
    const h = captured!.init.headers as Record<string, string>;
    expect(captured!.url).toBe(settings.webhookUrl);
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
    await sendBody({ ...settings, signatureScheme: "standard", signingSecret: secret, mappingPreset: "deepline" }, "{}", "evt-9", { version: "x", fetchImpl, now: () => 1_700_000_000_000, dedupeKey: "https://www.linkedin.com/in/jane" });
    expect(h["webhook-id"]).toBe("evt-9");
    expect(h["webhook-timestamp"]).toBe("1700000000");
    const { createHmac } = await import("node:crypto");
    expect(h["webhook-signature"]).toBe("v1," + createHmac("sha256", "raw-key-bytes").update("evt-9.1700000000.{}").digest("base64"));
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
    await sendBody({ ...settings, signingSecret: "", authHeaderName: "", authHeaderValue: "" }, "{}", "e", { version: "x", fetchImpl });
    expect(h["X-LWE-Signature"]).toBeUndefined();
    expect(h["Authorization"]).toBeUndefined();
  });
  it("classifies HTTP failures and includes response text", async () => {
    const fetchImpl = (async () => new Response("bad signature", { status: 401 })) as unknown as typeof fetch;
    const r = await sendBody(settings, "{}", "e", { version: "x", fetchImpl });
    expect(r).toEqual({ ok: false, status: 401, retryable: false, error: "HTTP 401: bad signature" });
    const r5 = await sendBody(settings, "{}", "e", { version: "x", fetchImpl: (async () => new Response("", { status: 502 })) as unknown as typeof fetch });
    expect(r5.retryable).toBe(true);
  });
  it("treats network errors and timeouts as retryable", async () => {
    const r = await sendBody(settings, "{}", "e", { version: "x", fetchImpl: (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch });
    expect(r).toEqual({ ok: false, status: null, retryable: true, error: "Failed to fetch" });
    const slow = ((_: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    const t = await sendBody(settings, "{}", "e", { version: "x", fetchImpl: slow, timeoutMs: 10 });
    expect(t).toEqual({ ok: false, status: null, retryable: true, error: "timeout" });
  });
});
