/** HMAC-SHA256 request signing using WebCrypto (works in service workers and Node 20+).
 *
 *  Verification here proves AUTHENTICITY and FRESHNESS (timestamp within a
 *  window). It does not prove uniqueness: a receiver must keep its own
 *  event-id store (see receiver/server.mjs and `isValidEventId`). */

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return toHex(sig);
}

export const SIGNATURE_HEADER = "X-LWE-Signature";
export const TIMESTAMP_HEADER = "X-LWE-Timestamp";
export const EVENT_ID_HEADER = "X-LWE-Event-Id";
export const VERSION_HEADER = "X-LWE-Version";

/** Event ids are UUIDs (or a conservative token grammar): no dots, bounded. */
export const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export function isValidEventId(id: unknown): id is string {
  return typeof id === "string" && EVENT_ID_RE.test(id);
}

/** Unix seconds must be a non-negative integer that fits comfortably in 2^53. */
export function isValidTimestamp(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isInteger(ts) && ts >= 0 && ts <= 253402300799; // 9999-12-31
}

/** The signed string is `${timestamp}.${body}` so replays with an old timestamp are detectable. */
export function signedMessage(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

export async function buildSignatureHeaders(secret: string, body: string, timestamp: number): Promise<Record<string, string>> {
  if (!isValidTimestamp(timestamp)) throw new Error("timestamp must be integer unix seconds");
  const sig = await hmacSha256Hex(secret, signedMessage(timestamp, body));
  return { [SIGNATURE_HEADER]: `sha256=${sig}`, [TIMESTAMP_HEADER]: String(timestamp) };
}

/** Constant-time string compare for receivers written in JS. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export type VerifyReason = "bad_timestamp" | "timestamp_out_of_window" | "signature_mismatch" | "bad_signature_format";

/** Verify an LWE signature. `timestamp` is what the header carried, parsed by
 *  the caller; only integer unix seconds are accepted. */
export async function verifySignature(secret: string, body: string, timestamp: number, signatureHeader: string, toleranceSeconds = 300, now = Math.floor(Date.now() / 1000)): Promise<{ ok: boolean; reason: VerifyReason | null }> {
  if (!isValidTimestamp(timestamp)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(now - timestamp) > toleranceSeconds) return { ok: false, reason: "timestamp_out_of_window" };
  if (typeof signatureHeader !== "string" || !/^sha256=[0-9a-f]{64}$/.test(signatureHeader)) return { ok: false, reason: "bad_signature_format" };
  const expected = `sha256=${await hmacSha256Hex(secret, signedMessage(timestamp, body))}`;
  return timingSafeEqual(expected, signatureHeader) ? { ok: true, reason: null } : { ok: false, reason: "signature_mismatch" };
}

/* ---------- Standard Webhooks (https://www.standardwebhooks.com) ---------- */

export const SW_ID_HEADER = "webhook-id";
export const SW_TIMESTAMP_HEADER = "webhook-timestamp";
export const SW_SIGNATURE_HEADER = "webhook-signature";

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

function base64ToBytes(b64: string): Uint8Array | null {
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  if (!B64_RE.test(std) || std.replace(/=+$/, "").length % 4 === 1) return null;
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
function bytesToBase64(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

/** Standard Webhooks secrets are base64 (standard or url-safe alphabet),
 *  commonly prefixed `whsec_`. Returns null when the secret is not valid
 *  base64; callers decide whether to fall back to raw bytes. */
export function decodeStandardSecret(secret: string): Uint8Array | null {
  const body = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  if (!body || !(B64_RE.test(body) || B64URL_RE.test(body))) return null;
  return base64ToBytes(body);
}

/** Key material for a configured secret: decoded base64 when valid, else the
 *  raw UTF-8 bytes (documented compatibility fallback for plain passphrases;
 *  a `whsec_` prefixed value that is not base64 is rejected). */
export function standardSecretKey(secret: string): Uint8Array {
  const decoded = decodeStandardSecret(secret);
  if (decoded) return decoded;
  if (secret.startsWith("whsec_")) throw new Error("whsec_ secret is not valid base64");
  return enc.encode(secret);
}

export function standardSignedMessage(id: string, timestamp: number, body: string): string {
  return `${id}.${timestamp}.${body}`;
}

export async function buildStandardWebhookHeaders(secret: string, body: string, id: string, timestamp: number): Promise<Record<string, string>> {
  if (!isValidEventId(id)) throw new Error("webhook-id must match [A-Za-z0-9_-]{8,64}");
  if (!isValidTimestamp(timestamp)) throw new Error("timestamp must be integer unix seconds");
  const key = await crypto.subtle.importKey("raw", standardSecretKey(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(standardSignedMessage(id, timestamp, body)));
  return { [SW_ID_HEADER]: id, [SW_TIMESTAMP_HEADER]: String(timestamp), [SW_SIGNATURE_HEADER]: `v1,${bytesToBase64(sig)}` };
}

/** Verify a Standard Webhooks signature header (space-separated `v1,<b64>` list). */
export async function verifyStandardWebhook(secret: string, body: string, id: string, timestampHeader: string, signatureHeader: string, toleranceSeconds = 300, now = Math.floor(Date.now() / 1000)): Promise<{ ok: boolean; reason: VerifyReason | "bad_event_id" | null }> {
  if (!isValidEventId(id)) return { ok: false, reason: "bad_event_id" };
  if (!/^\d{1,12}$/.test(timestampHeader)) return { ok: false, reason: "bad_timestamp" };
  const ts = Number(timestampHeader);
  if (!isValidTimestamp(ts)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(now - ts) > toleranceSeconds) return { ok: false, reason: "timestamp_out_of_window" };
  const candidates = signatureHeader.trim().split(/\s+/).filter((c) => /^v1,[A-Za-z0-9+/]+={0,2}$/.test(c));
  if (!candidates.length) return { ok: false, reason: "bad_signature_format" };
  const key = await crypto.subtle.importKey("raw", standardSecretKey(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = `v1,${bytesToBase64(await crypto.subtle.sign("HMAC", key, enc.encode(standardSignedMessage(id, ts, body))))}`;
  return candidates.some((c) => timingSafeEqual(c, expected)) ? { ok: true, reason: null } : { ok: false, reason: "signature_mismatch" };
}
