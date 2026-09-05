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
