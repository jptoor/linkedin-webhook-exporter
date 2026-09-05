/** Deepline sign-in through the browser session, the way Frontier picks up
 *  its web app's `credentials.*` cookies: the rep signs in to Deepline once in
 *  a normal tab and the extension is signed in too. No API key to paste.
 *
 *  Mechanics: the extension has host permission for the Deepline base URL, so
 *  a `fetch(..., { credentials: "include" })` from the worker carries the
 *  `better-auth.session_token` cookie and Deepline's `requireAuth` falls back
 *  to that session. The `cookies` permission is scoped to the same host and
 *  is used only to notice sign-in / sign-out promptly. The cookie value is
 *  never read into extension code; only its presence is checked. */
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

const COOKIE_NAMES = ["__Secure-better-auth.session_token", "better-auth.session_token"];

export async function hasSessionCookie(baseUrl: string, cookies: typeof chrome.cookies | undefined = chrome.cookies): Promise<boolean> {
  if (!cookies?.get) return true; // cannot tell; let the session call decide
  for (const name of COOKIE_NAMES) {
    try {
      if (await cookies.get({ url: baseUrl, name })) return true;
    } catch {
      /* no permission for that host: fall through */
    }
  }
  return false;
}

/** Ask Deepline who the session belongs to. */
export async function fetchSession(baseUrlRaw: string, fetchImpl: typeof fetch = fetch, cookies?: typeof chrome.cookies): Promise<SessionState> {
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  const base: SessionState = { signedIn: false, baseUrl, userId: null, email: null, name: null, orgId: null, checkedAt: Date.now(), error: null };
  if (!(await hasSessionCookie(baseUrl, cookies))) return base;
  try {
    const res = await fetchImpl(`${baseUrl}/api/v2/auth/session`, { credentials: "include", headers: { Accept: "application/json" }, redirect: "error" });
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

/** True when a cookie change concerns the Deepline session. */
export function isSessionCookieChange(change: { cookie: { name: string; domain: string } }, baseUrl: string): boolean {
  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  const d = change.cookie.domain.replace(/^\./, "");
  return COOKIE_NAMES.includes(change.cookie.name) && (host === d || host.endsWith(`.${d}`));
}
