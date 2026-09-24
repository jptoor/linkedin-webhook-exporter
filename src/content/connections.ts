import { connectionOwner, CONNECTIONS_PAGE_SIZE, parseConnectionPage, type ConnectionRequest } from "../shared/connections";

declare const __TEST_BUILD__: boolean;
let active: { id: string; token: string; owner: string; abort: AbortController } | null = null;
function csrf(): string {
  const raw = document.cookie.split(";").map(x => x.trim()).find(x => x.startsWith("JSESSIONID="))?.slice(11).replace(/^"|"$/g, "");
  if (!raw || raw.length > 200 || /[\r\n]/.test(raw)) throw new Error("Sign in to LinkedIn and reload this tab before syncing.");
  return raw;
}
async function read(path: string, token: string, abort: AbortController): Promise<unknown> {
  const timeout = setTimeout(() => abort.abort(), 15_000);
  try {
    const response = await fetch(new URL(path, location.origin), { credentials: "same-origin", redirect: "error", headers: { "csrf-token": token, accept: "application/vnd.linkedin.normalized+json+2.1" }, signal: abort.signal });
    if (!response.ok) throw new Error(`LinkedIn returned HTTP ${response.status}. Sync stopped; no automatic retry.`);
    if (!response.headers.get("content-type")?.includes("json")) throw new Error("LinkedIn returned a sign-in or challenge page. Sync stopped.");
    return await response.json();
  } finally { clearTimeout(timeout); }
}

// This isolated-world listener can only be invoked by our extension. No page
// postMessage bridge, cookie storage, telemetry, or credential handoff is used.
chrome.runtime.onMessage.addListener((m: ConnectionRequest, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  if (m?.type === "CONNECTIONS_ABORT") {
    if (active?.id === m.runId) { active.abort.abort(); active = null; }
    reply({ ok: true });
    return false;
  }
  if (m?.type !== "CONNECTIONS_READ") return false;
  let requestRun: typeof active = null;
  void (async () => {
    const allowed = location.origin === "https://www.linkedin.com" || location.origin === "https://linkedin.com" || (__TEST_BUILD__ && ["127.0.0.1", "localhost"].includes(location.hostname));
    if (!allowed || !Number.isSafeInteger(m.start) || m.start < 0 || !Number.isSafeInteger(m.count) || m.count < 1 || m.count > CONNECTIONS_PAGE_SIZE || typeof m.runId !== "string") throw new Error("Invalid connection sync request.");
    const token = csrf();
    if (m.start === 0 && active?.id !== m.runId) { active?.abort.abort(); active = null; }
    if (!active) {
      if (m.start !== 0) throw new Error("The LinkedIn tab changed. Start a new sync.");
      const run = { id: m.runId, token, owner: "", abort: new AbortController() };
      active = run;
      requestRun = run;

    }
    const run = active;
    requestRun = run;
    if (run.id !== m.runId || run.token !== token) throw new Error("The LinkedIn session changed. Sync stopped.");
    // Re-check the account before each page, even if its CSRF value is unchanged.
    const owner = connectionOwner(await read("/voyager/api/me", token, run.abort));
    if (active !== run) throw new Error("Sync stopped.");
    if (run.owner && run.owner !== owner) throw new Error("The LinkedIn account changed. Sync stopped.");
    run.owner = owner;
    const query = new URLSearchParams({ decorationId: "com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16", count: String(m.count), q: "search", sortType: "RECENTLY_ADDED", start: String(m.start) });
    const raw = await read(`/voyager/api/relationships/dash/connections?${query}`, token, run.abort);
    if (active !== run || csrf() !== token) throw new Error("The LinkedIn session changed. Sync stopped.");
    return parseConnectionPage(raw, run.owner, m.start, m.count);
  })().then(page => reply({ page }), e => {
    if (active === requestRun) { active?.abort.abort(); active = null; }
    // Never return response bodies, cookies, or raw transport exceptions.
    reply({ error: e instanceof Error && /^(LinkedIn|Sign in|The LinkedIn|Invalid connection|A LinkedIn|Sync stopped)/.test(e.message) ? e.message : "LinkedIn request failed or timed out. Sync stopped; no automatic retry." });
  });
  return true;
});
