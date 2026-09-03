/** HMAC-SHA256 request signing using WebCrypto (works in service workers and Node 20+). */

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

/** The signed string is `${timestamp}.${body}` so replays with an old timestamp are detectable. */
export function signedMessage(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

export async function buildSignatureHeaders(secret: string, body: string, timestamp: number): Promise<Record<string, string>> {
  const sig = await hmacSha256Hex(secret, signedMessage(timestamp, body));
  return { [SIGNATURE_HEADER]: `sha256=${sig}`, [TIMESTAMP_HEADER]: String(timestamp) };
}

/* ---------- Standard Webhooks (https://www.standardwebhooks.com) ---------- */

export const SW_ID_HEADER = "webhook-id";
export const SW_TIMESTAMP_HEADER = "webhook-timestamp";
export const SW_SIGNATURE_HEADER = "webhook-signature";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

/** Standard Webhooks secrets are base64, commonly prefixed `whsec_`. A secret
 *  that is not valid base64 is used as raw UTF-8 bytes so plain passphrases work. */
export function decodeStandardSecret(secret: string): Uint8Array {
  const body = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  try {
    const bytes = base64ToBytes(body);
    if (bytesToBase64(bytes.buffer as ArrayBuffer).replace(/=+$/, "") === body.replace(/=+$/, "")) return bytes;
  } catch {
    /* not base64 */
  }
  return enc.encode(secret);
}

export function standardSignedMessage(id: string, timestamp: number, body: string): string {
  return `${id}.${timestamp}.${body}`;
}

export async function buildStandardWebhookHeaders(secret: string, body: string, id: string, timestamp: number): Promise<Record<string, string>> {
  if (id.includes(".")) throw new Error("webhook-id must not contain '.'");
  const key = await crypto.subtle.importKey("raw", decodeStandardSecret(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(standardSignedMessage(id, timestamp, body)));
  return { [SW_ID_HEADER]: id, [SW_TIMESTAMP_HEADER]: String(timestamp), [SW_SIGNATURE_HEADER]: `v1,${bytesToBase64(sig)}` };
}

/** Constant-time string compare for receivers written in JS. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function verifySignature(secret: string, body: string, timestamp: number, signatureHeader: string, toleranceSeconds = 300, now = Math.floor(Date.now() / 1000)): Promise<{ ok: boolean; reason: string | null }> {
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(now - timestamp) > toleranceSeconds) return { ok: false, reason: "timestamp_out_of_window" };
  const expected = `sha256=${await hmacSha256Hex(secret, signedMessage(timestamp, body))}`;
  return timingSafeEqual(expected, signatureHeader) ? { ok: true, reason: null } : { ok: false, reason: "signature_mismatch" };
}
