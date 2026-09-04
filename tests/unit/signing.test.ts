import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { buildSignatureHeaders, buildStandardWebhookHeaders, decodeStandardSecret, hmacSha256Hex, isValidEventId, isValidTimestamp, standardSecretKey, timingSafeEqual, verifySignature, verifyStandardWebhook } from "../../src/shared/signing";

describe("LWE scheme", () => {
  it("matches a known HMAC-SHA256 vector", async () => {
    expect(await hmacSha256Hex("secret", "1700000000.{}")).toBe(createHmac("sha256", "secret").update("1700000000.{}").digest("hex"));
  });
  it("round-trips through verifySignature", async () => {
    const body = JSON.stringify({ a: 1, emoji: "🚀", quotes: '"' });
    const ts = 1_700_000_000;
    const h = await buildSignatureHeaders("s3cret", body, ts);
    expect(h["X-LWE-Timestamp"]).toBe("1700000000");
    expect(h["X-LWE-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifySignature("s3cret", body, ts, h["X-LWE-Signature"], 300, ts + 10)).toEqual({ ok: true, reason: null });
  });
  it("rejects tampered body, wrong secret, stale, fractional, negative, huge and malformed timestamps", async () => {
    const body = "{}";
    const ts = 1_700_000_000;
    const h = await buildSignatureHeaders("s3cret", body, ts);
    expect((await verifySignature("s3cret", "{ }", ts, h["X-LWE-Signature"], 300, ts)).reason).toBe("signature_mismatch");
    expect((await verifySignature("other", body, ts, h["X-LWE-Signature"], 300, ts)).reason).toBe("signature_mismatch");
    expect((await verifySignature("s3cret", body, ts, h["X-LWE-Signature"], 300, ts + 301)).reason).toBe("timestamp_out_of_window");
    expect((await verifySignature("s3cret", body, NaN, h["X-LWE-Signature"], 300, ts)).reason).toBe("bad_timestamp");
    expect((await verifySignature("s3cret", body, 1700000000.5, h["X-LWE-Signature"], 300, ts)).reason).toBe("bad_timestamp");
    expect((await verifySignature("s3cret", body, -5, h["X-LWE-Signature"], 300, ts)).reason).toBe("bad_timestamp");
    expect((await verifySignature("s3cret", body, 1e18, h["X-LWE-Signature"], 300, ts)).reason).toBe("bad_timestamp");
    expect((await verifySignature("s3cret", body, ts, "sha256=zz", 300, ts)).reason).toBe("bad_signature_format");
    expect((await verifySignature("s3cret", body, ts, "", 300, ts)).reason).toBe("bad_signature_format");
    await expect(buildSignatureHeaders("s", "{}", 1.5)).rejects.toThrow(/integer/);
  });
  it("timingSafeEqual", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
  it("event id and timestamp grammars", () => {
    expect(isValidEventId(crypto.randomUUID())).toBe(true);
    expect(isValidEventId("has.dot-xxxxxxx")).toBe(false);
    expect(isValidEventId("short")).toBe(false);
    expect(isValidEventId("x".repeat(65))).toBe(false);
    expect(isValidEventId(42)).toBe(false);
    expect(isValidTimestamp(0)).toBe(true);
    expect(isValidTimestamp(253402300799)).toBe(true);
    expect(isValidTimestamp(253402300800)).toBe(false);
    expect(isValidTimestamp("1700000000")).toBe(false);
  });
});

describe("Standard Webhooks scheme", () => {
  const rawKey = Buffer.from("k-bytes-🚀");
  const secret = "whsec_" + rawKey.toString("base64");
  it("decodes whsec_ base64 and base64url secrets; rejects malformed whsec_; accepts raw passphrases", () => {
    expect(Buffer.from(decodeStandardSecret(secret)!)).toEqual(rawKey);
    expect(Buffer.from(decodeStandardSecret("whsec_" + rawKey.toString("base64url"))!)).toEqual(rawKey);
    expect(Buffer.from(decodeStandardSecret(rawKey.toString("base64").replace(/=+$/, ""))!)).toEqual(rawKey); // unpadded
    expect(decodeStandardSecret("whsec_!!!notbase64")).toBeNull();
    expect(() => standardSecretKey("whsec_!!!notbase64")).toThrow(/base64/);
    expect(Buffer.from(standardSecretKey("plain passphrase!")).toString()).toBe("plain passphrase!");
    expect(decodeStandardSecret("")).toBeNull();
  });
  it("builds and verifies v1 signatures, incl. multi-signature headers", async () => {
    const body = '{"x":1,"é":"ü"}';
    const h = await buildStandardWebhookHeaders(secret, body, "msg_12345678", 1_700_000_000);
    expect(h).toEqual({ "webhook-id": "msg_12345678", "webhook-timestamp": "1700000000", "webhook-signature": "v1," + createHmac("sha256", rawKey).update("msg_12345678.1700000000." + body).digest("base64") });
    expect(await verifyStandardWebhook(secret, body, "msg_12345678", "1700000000", h["webhook-signature"], 300, 1_700_000_100)).toEqual({ ok: true, reason: null });
    expect(await verifyStandardWebhook(secret, body, "msg_12345678", "1700000000", "v1,AAAA " + h["webhook-signature"], 300, 1_700_000_100)).toEqual({ ok: true, reason: null });
  });
  it("rejects bad ids, timestamps, formats and mismatches", async () => {
    const body = "{}";
    const h = await buildStandardWebhookHeaders(secret, body, "msg_12345678", 1_700_000_000);
    expect((await verifyStandardWebhook(secret, body, "has.dot-xxxx", "1700000000", h["webhook-signature"], 300, 1_700_000_000)).reason).toBe("bad_event_id");
    expect((await verifyStandardWebhook(secret, body, "msg_12345678", "1700000000.5", h["webhook-signature"], 300, 1_700_000_000)).reason).toBe("bad_timestamp");
    expect((await verifyStandardWebhook(secret, body, "msg_12345678", "99999999999999", h["webhook-signature"], 300, 1_700_000_000)).reason).toBe("bad_timestamp");
    expect((await verifyStandardWebhook(secret, body, "msg_12345678", "1700000000", h["webhook-signature"], 300, 1_700_001_000)).reason).toBe("timestamp_out_of_window");
    expect((await verifyStandardWebhook(secret, body, "msg_12345678", "1700000000", "v2,abc", 300, 1_700_000_000)).reason).toBe("bad_signature_format");
    expect((await verifyStandardWebhook("whsec_" + Buffer.from("other").toString("base64"), body, "msg_12345678", "1700000000", h["webhook-signature"], 300, 1_700_000_000)).reason).toBe("signature_mismatch");
    await expect(buildStandardWebhookHeaders(secret, "{}", "has.dot", 1)).rejects.toThrow(/webhook-id/);
    await expect(buildStandardWebhookHeaders(secret, "{}", "msg_12345678", 1.5)).rejects.toThrow(/integer/);
  });
});
