import { describe, expect, it } from "vitest";
import { buildSignatureHeaders, buildStandardWebhookHeaders, decodeStandardSecret, hmacSha256Hex, timingSafeEqual, verifySignature } from "../../src/shared/signing";

describe("signing", () => {
  it("matches a known HMAC-SHA256 vector", async () => {
    // echo -n "1700000000.{}" | openssl dgst -sha256 -hmac "secret"
    expect(await hmacSha256Hex("secret", "1700000000.{}")).toBe("b8569b78799ff9e3cbff0fc2d63a33a2b57f3282abd07c37ae5e8e7d79a5f163");
  });
  it("round-trips through verifySignature", async () => {
    const body = JSON.stringify({ a: 1 });
    const ts = 1_700_000_000;
    const h = await buildSignatureHeaders("s3cret", body, ts);
    expect(h["X-LWE-Timestamp"]).toBe("1700000000");
    expect(h["X-LWE-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifySignature("s3cret", body, ts, h["X-LWE-Signature"], 300, ts + 10)).toEqual({ ok: true, reason: null });
  });
  it("rejects tampered body, wrong secret and stale timestamps", async () => {
    const body = "{}";
    const ts = 1_700_000_000;
    const h = await buildSignatureHeaders("s3cret", body, ts);
    expect((await verifySignature("s3cret", "{ }", ts, h["X-LWE-Signature"], 300, ts)).reason).toBe("signature_mismatch");
    expect((await verifySignature("other", body, ts, h["X-LWE-Signature"], 300, ts)).reason).toBe("signature_mismatch");
    expect((await verifySignature("s3cret", body, ts, h["X-LWE-Signature"], 300, ts + 301)).reason).toBe("timestamp_out_of_window");
    expect((await verifySignature("s3cret", body, NaN, h["X-LWE-Signature"], 300, ts)).reason).toBe("bad_timestamp");
  });
  it("Standard Webhooks: decodes whsec_ base64 secrets and falls back to raw passphrases", async () => {
    expect(Buffer.from(decodeStandardSecret("whsec_" + Buffer.from("abc").toString("base64"))).toString()).toBe("abc");
    expect(Buffer.from(decodeStandardSecret("plain passphrase!")).toString()).toBe("plain passphrase!");
    const h = await buildStandardWebhookHeaders("whsec_" + Buffer.from("k").toString("base64"), '{"x":1}', "msg_1", 1_700_000_000);
    const { createHmac } = await import("node:crypto");
    expect(h).toEqual({ "webhook-id": "msg_1", "webhook-timestamp": "1700000000", "webhook-signature": "v1," + createHmac("sha256", "k").update('msg_1.1700000000.{"x":1}').digest("base64") });
    await expect(buildStandardWebhookHeaders("s", "{}", "has.dot", 1)).rejects.toThrow(/must not contain/);
  });
  it("timingSafeEqual", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
});
