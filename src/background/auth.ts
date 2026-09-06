/** Deepline sign-in through the browser session: the rep signs in to Deepline
 *  once in a normal tab and the extension is signed in too. No API key to
 *  paste, and no `cookies` permission either.
 *
 *  Mechanics: the extension has host permission for the Deepline base URL, so
 *  a `fetch(..., { credentials: "include" })` from the worker carries the
 *  session cookie and Deepline's `requireAuth` falls back to that session.
 *  The extension never reads the cookie; it only asks `/api/v2/auth/session`
 *  who the session belongs to, and re-asks when a Deepline tab finishes
 *  loading, when the panel opens, or when a run comes back 401. */
import { normalizeBaseUrl } from "../shared/deepline";

export interface SessionState {
  signedIn: boolean;
  baseUrl: string;
  userId: string | null;
  email: string | null;
  name: string | null;
  orgId: string | null;
  checkedAt: number;
  error: string | null;
}

/** Ask Deepline who the session belongs to. */
export async function fetchSession(baseUrlRaw: string, fetchImpl: typeof fetch = fetch): Promise<SessionState> {
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  const base: SessionState = { signedIn: false, baseUrl, userId: null, email: null, name: null, orgId: null, checkedAt: Date.now(), error: null };
  try {
    const res = await fetchImpl(`${baseUrl}/api/v2/auth/session`, { credentials: "include", headers: { Accept: "application/json" }, redirect: "error", cache: "no-store" });
    if (!res.ok) return { ...base, error: `HTTP ${res.status}` };
    const json = (await res.json()) as { session?: { user?: { id?: string; email?: string; name?: string }; activeOrgId?: string | null; session?: { activeOrganizationId?: string | null } } | null };
    const s = json.session;
    if (!s || !s.user) return base;
    return { ...base, signedIn: true, userId: s.user.id ?? null, email: s.user.email ?? null, name: s.user.name ?? null, orgId: s.activeOrgId ?? s.session?.activeOrganizationId ?? null };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

export function signInUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/sign-in`;
}

/** True when a tab URL is on the Deepline base host (a sign-in or sign-out
 *  may just have happened there). */
export function isDeeplineTab(url: string | undefined, baseUrl: string): boolean {
  try {
    return !!url && new URL(url).origin === normalizeBaseUrl(baseUrl);
  } catch {
    return false;
  }
}

/** The identity a queued run was authorized under: user + org. A run must
 *  not be sent under a different identity than the one that queued it. */
export function identityKey(s: Pick<SessionState, "signedIn" | "userId" | "orgId"> | null): string | null {
  return s?.signedIn && s.userId ? `${s.userId}|${s.orgId ?? ""}` : null;
}

/* ------------------------------------------------------------ device key */

/** "Connect Deepline": the same device-approval flow as `deepline auth
 *  register`. The extension registers itself (`POST /api/v2/auth/cli/register`),
 *  the rep approves it on the claim page, and polling
 *  `POST /api/v2/auth/cli/status { claim_token, reveal: true }` returns a
 *  per-device API key the rep can revoke from Deepline's device list. The key
 *  then replaces the session cookie as the credential (`Authorization: Bearer`,
 *  `credentials: "omit"`). */
export interface Connection {
  baseUrl: string;
  apiKey: string;
  /** Deepline's id for this device key: shown next to "Disconnect". */
  apiKeyId: string | null;
  userId: string | null;
  email: string | null;
  orgId: string | null;
  orgName: string | null;
  connectedAt: number;
}
export interface PendingClaim {
  baseUrl: string;
  claimToken: string;
  /** `claim_url` from register; GET redirects (307) to the approval page. */
  claimUrl: string;
  startedAt: number;
  /** `claim_expires_at` from register (about 24 h); polling stops here. */
  expiresAt: number;
}
export const AGENT_NAME = "Chrome extension: Deepline for LinkedIn";
const CLAIM_MAX_MS = 24 * 3600_000;

function authInit(version: string, body: Record<string, unknown>, apiKey: string | null = null): RequestInit {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json", "X-Deepline-Client-Family": "chrome-extension", "X-Deepline-Client-Version": version };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return { method: "POST", headers, body: JSON.stringify(body), credentials: "omit", redirect: "error", cache: "no-store" };
}

export async function registerDevice(baseUrlRaw: string, version: string, fetchImpl: typeof fetch = fetch): Promise<PendingClaim> {
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  const res = await fetchImpl(`${baseUrl}/api/v2/auth/cli/register`, authInit(version, { agent_name: AGENT_NAME }));
  if (!res.ok) throw new Error(`Deepline responded ${res.status}`);
  const json = (await res.json()) as { claim_url?: unknown; claim_token?: unknown; claim_expires_at?: unknown };
  const claimUrl = typeof json.claim_url === "string" ? json.claim_url : "";
  const claimToken = typeof json.claim_token === "string" ? json.claim_token : "";
  if (!claimUrl || !claimToken || new URL(claimUrl).origin !== baseUrl) throw new Error("Deepline returned no approval link");
  const now = Date.now();
  const expires = typeof json.claim_expires_at === "string" ? Date.parse(json.claim_expires_at) : NaN;
  return { baseUrl, claimToken, claimUrl, startedAt: now, expiresAt: Number.isFinite(expires) ? Math.min(expires, now + CLAIM_MAX_MS) : now + CLAIM_MAX_MS };
}

export type ClaimPoll = { state: "pending" | "expired" | "unauthorized" } | { state: "claimed"; connection: Connection };

/** One poll of a pending claim, with the CLI's status handling: 401/403 is
 *  unauthorized (drop the claim), 5xx/network/400 keep polling. */
export async function pollClaim(claim: PendingClaim, version: string, fetchImpl: typeof fetch = fetch): Promise<ClaimPoll> {
  let res: Response;
  try {
    res = await fetchImpl(`${claim.baseUrl}/api/v2/auth/cli/status`, authInit(version, { claim_token: claim.claimToken, reveal: true }));
  } catch {
    return { state: "pending" };
  }
  if (res.status === 401 || res.status === 403) return { state: "unauthorized" };
  if (!res.ok) return { state: "pending" };
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const state = String(json.status ?? "").toLowerCase();
  if (state === "expired") return { state: "expired" };
  const apiKey = typeof json.api_key === "string" ? json.api_key : "";
  if (state !== "claimed" || !apiKey) return { state: "pending" };
  return { state: "claimed", connection: { baseUrl: claim.baseUrl, apiKey, apiKeyId: str(json.api_key_id), userId: str(json.user_id), email: str(json.user_email), orgId: str(json.org_id), orgName: str(json.org_name), connectedAt: Date.now() } };
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Who a device key belongs to (`POST /api/v2/auth/cli/status { api_key }`),
 *  as a SessionState so identity binding works the same as in session mode.
 *  `revoked` is set only on 401/403; any other failure keeps the stored
 *  identity so a flaky network does not sign the rep out. */
export async function keySession(conn: Connection, version: string, fetchImpl: typeof fetch = fetch): Promise<SessionState & { revoked: boolean; keyId: string | null }> {
  const base = { signedIn: true, baseUrl: conn.baseUrl, userId: conn.userId, email: conn.email, name: conn.orgName, orgId: conn.orgId, checkedAt: Date.now(), error: null, revoked: false, keyId: conn.apiKeyId };
  try {
    const res = await fetchImpl(`${conn.baseUrl}/api/v2/auth/cli/status`, authInit(version, { api_key: conn.apiKey }, conn.apiKey));
    if (res.status === 401 || res.status === 403) return { ...base, signedIn: false, userId: null, email: null, orgId: null, name: null, keyId: null, error: "key_revoked", revoked: true };
    if (!res.ok) return { ...base, error: `HTTP ${res.status}` };
    const json = (await res.json()) as Record<string, unknown>;
    return { ...base, userId: str(json.user_id) ?? conn.userId, email: str(json.user_email) ?? conn.email, orgId: str(json.org_id) ?? conn.orgId, name: str(json.org_name) ?? conn.orgName, keyId: str(json.api_key_id) ?? conn.apiKeyId };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}
