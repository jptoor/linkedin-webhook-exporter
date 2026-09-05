import type { BackgroundToContent, BasketResponse, CaptureResponse, ContentSettingsResponse, PageContext } from "../shared/messages";
import { dedupeKey } from "../shared/normalize";
import { isSensitiveParam, savedSearchIdFrom, searchName } from "../shared/search";
import type { LeadRecord, PageType } from "../shared/types";
import { detectPageType, isListPage, listRows, parsePage, parsePeopleSearchRow, parseSalesNavRow } from "./parsers";
import { makePick, mountPanel, setPicked, toast } from "./ui";

const send = <T,>(msg: unknown): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;
const NEW_ID = () => crypto.randomUUID();

function describeRejection(r: CaptureResponse): string {
  switch (r.rejectedReason) {
    case "no_destination":
      return "Choose where to send first (open the panel).";
    case "invalid_url":
      return "That play or webhook is not set up completely. Open Settings.";
    case "daily_cap":
      return `You hit today’s limit (${r.remainingToday} left). You can raise it in Settings.`;
    case "nothing_to_send":
      return "Could not read a name on this page.";
    case "invalid_message":
      return "This is not a page the extension can read.";
    case "unsupported_by_play":
      return r.detail ?? "This play does not take people.";
    default:
      return "Rejected.";
  }
}

function summarize(r: CaptureResponse | { error?: string } | undefined): { text: string; kind: "ok" | "err" | "warn" } {
  if (!r || !("ok" in r)) return { text: `Something went wrong: ${(r as { error?: string } | undefined)?.error ?? "no answer from the extension"}`, kind: "err" };
  if (!r.ok) return { text: describeRejection(r), kind: "err" };
  const parts: string[] = [];
  if (r.queued) parts.push(`${r.queued} on the way`);
  if (r.skippedDuplicates.length) parts.push(`${r.skippedDuplicates.length} pushed before`);
  parts.push(`${r.remainingToday} left today`);
  return { text: parts.join(" · "), kind: r.queued ? "ok" : "warn" };
}

async function getSettings(): Promise<ContentSettingsResponse> {
  return send<ContentSettingsResponse>({ type: "GET_CONTENT_SETTINGS" });
}

function shortDest(s: ContentSettingsResponse): string | null {
  if (!s.hasDestination || !s.destinationName) return null;
  const n = s.destinationName.trim();
  return n.length > 22 ? `${n.slice(0, 21)}…` : n;
}
function destinationLabel(s: ContentSettingsResponse, count = 0): string {
  const d = shortDest(s);
  if (count > 0) return d ? `Push ${count} to ${d}` : `Push ${count}`;
  return d ? `Push to ${d}` : "Push";
}

/* ---------- page context reporting (feeds the side panel) ---------- */

let currentContext: PageContext | null = null;
function reportContext(ctx: PageContext): void {
  currentContext = ctx;
  void send({ type: "PAGE_CONTEXT", context: ctx }).catch(() => undefined);
}

function detectTotalHint(): number | null {
  const el = document.querySelector<HTMLElement>('[data-lwe="results-count"], .search-results__total, h2.t-14, .artdeco-pagination__page-state');
  const m = el?.textContent?.replace(/[,.\s\u00a0\u202f]/g, "").match(/(\d{1,7})\s*(results?|leads?|people)/i) ?? el?.textContent?.match(/(\d{1,7})/);
  return m ? Number(m[1]) : null;
}

/* ---------- mount lifecycle ---------- */

/** Everything a page mount owns, so navigation can tear it down completely. */
interface Mount {
  dispose(): void;
  sendCurrent?: () => void;
  action?: (a: Extract<BackgroundToContent, { type: "PAGE_ACTION" }>["action"]) => Promise<PageContext | null>;
  basketChanged?: (keys: string[]) => void;
}
let active: Mount | null = null;

/* ---------- single-record pages (profile, Sales Nav lead) ---------- */

async function setupSinglePage(pageType: PageType): Promise<Mount> {
  const panel = mountPanel(document, "Deepline", "Loading…", "Select instead", "Push again");
  panel.primary.disabled = true;
  let alive = true;
  const light = () => parsePage(document, location.href, { includeExperience: false, includeEducation: false, includeAbout: false }).leads[0] ?? null;
  const context = (): PageContext => {
    const lead = light();
    return { pageType, url: location.href, title: document.title, lead: lead?.full_name ? lead : null, rowsOnPage: 0, selectedOnPage: 0, savedSearchId: null, shareUrl: null, searchName: null, totalHint: null };
  };
  // Attach handlers before any async work so an early click is never lost.
  const doSend = async (force: boolean) => {
    panel.primary.disabled = true;
    panel.setStatus("Reading page…");
    const settings = await getSettings();
    if (!alive) return;
    const { leads } = parsePage(document, location.href, { includeExperience: settings.includeExperience, includeEducation: settings.includeEducation, includeAbout: settings.includeAbout });
    const lead = leads[0];
    if (!lead || !lead.full_name) {
      panel.setStatus("Could not read a name on this page yet. Scroll a little and try again.", "err");
      panel.primary.disabled = false;
      return;
    }
    const res = await send<CaptureResponse>({ type: "CAPTURE", leads: [lead], pageType, pageUrl: location.href, force, importId: NEW_ID(), importKind: "manual", pageTitle: document.title });
    if (!alive) return;
    const s = summarize(res);
    panel.setStatus(lead.parse_warnings.length && s.kind === "ok" ? `${s.text} · check: ${lead.parse_warnings.join(", ")}` : s.text, s.kind);
    panel.primary.disabled = false;
  };
  const addToBasket = async () => {
    const lead = light();
    if (!lead?.full_name) return panel.setStatus("Could not read a name from this page.", "err");
    const r = await send<BasketResponse & { added: number }>({ type: "BASKET_ADD", leads: [lead], pageType, pageUrl: location.href, pageTitle: document.title });
    if (!alive) return;
    panel.setStatus(r.added ? `Selected. ${r.count} so far.` : "Already selected.", r.added ? "ok" : "warn");
  };
  panel.primary.addEventListener("click", () => void doSend(false));
  panel.secondary.addEventListener("click", () => void addToBasket());
  panel.tertiary.addEventListener("click", () => void doSend(true));
  panel.openPanel.addEventListener("click", () => void send({ type: "OPEN_SIDE_PANEL" }));
  const relabel = () => void getSettings().then((s) => {
    if (!alive) return;
    panel.primary.textContent = destinationLabel(s);
    panel.primary.disabled = false;
  });
  relabel();
  const onChange = (changes: Record<string, unknown>) => {
    if ("settings" in changes) relabel();
  };
  chrome.storage.onChanged.addListener(onChange);
  // Show whether this profile was already sent.
  const lead = light();
  if (lead?.full_name) {
    const key = dedupeKey(lead);
    const seen = await send<Record<string, boolean>>({ type: "CHECK_DEDUPE", keys: [key] });
    if (alive && seen[key]) panel.setStatus("Pushed before. “Push again” sends it anyway.", "warn");
  }
  reportContext(context());
  return {
    dispose: () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
      panel.dispose();
    },
    sendCurrent: () => void doSend(false),
    action: async (a) => {
      if (a === "send_current") await doSend(false);
      if (a === "add_selected" || a === "add_all") await addToBasket();
      return context();
    }
  };
}

/* ---------- list pages (Sales Nav search/list, people search) ---------- */

interface RowState {
  el: HTMLElement;
  pick: HTMLButtonElement;
  key: string;
  lead: LeadRecord;
  /** LinkedIn's own row checkbox, mirrored when present. */
  native: HTMLInputElement | null;
}

function parseRow(row: HTMLElement, pageType: PageType, now: string): LeadRecord | null {
  return pageType === "people_search" ? parsePeopleSearchRow(row, now) : parseSalesNavRow(row, now);
}

function nativeCheckbox(row: HTMLElement): HTMLInputElement | null {
  const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]:not([data-lwe-row-check])');
  return box && !box.closest("[data-lwe-panel]") ? box : null;
}

async function setupListPage(pageType: PageType): Promise<Mount> {
  const panel = mountPanel(document, "Deepline", "Loading…", "Add all on page", "Import search");
  const rows = new Map<HTMLElement, RowState>();
  let basketKeys = new Set<string>();
  let alive = true;
  const disposers: Array<() => void> = [() => (alive = false), () => panel.dispose()];
  const savedSearchId = pageType === "salesnav_search" ? savedSearchIdFrom(location.href) : null;
  panel.tertiary.hidden = pageType !== "salesnav_search";
  let settingsCache: ContentSettingsResponse | null = null;
  const relabel = () => void getSettings().then((s) => {
    if (!alive) return;
    settingsCache = s;
    refresh();
  });
  const onSettingsChange = (changes: Record<string, unknown>) => {
    if ("settings" in changes) relabel();
  };
  chrome.storage.onChanged.addListener(onSettingsChange);
  disposers.push(() => chrome.storage.onChanged.removeListener(onSettingsChange));

  const context = (): PageContext => ({
    pageType,
    url: location.href,
    title: document.title,
    lead: null,
    rowsOnPage: rows.size,
    selectedOnPage: Array.from(rows.values()).filter((r) => basketKeys.has(r.key)).length,
    savedSearchId,
    shareUrl: null,
    searchName: searchName(location.href, pageType, document.title),
    totalHint: detectTotalHint()
  });

  const refresh = () => {
    let sel = 0;
    for (const r of rows.values()) {
      const picked = basketKeys.has(r.key);
      if (picked) sel++;
      setPicked(r.pick, picked);
      if (r.native && r.native.checked !== picked && !r.native.disabled) {
        // Mirror our state onto LinkedIn's checkbox without firing its handlers twice.
        r.native.checked = picked;
      }
    }
    panel.primary.textContent = settingsCache ? destinationLabel(settingsCache, basketKeys.size) : "Loading…";
    panel.primary.disabled = !settingsCache || basketKeys.size === 0;
    panel.count.textContent = sel ? `${sel}/${rows.size}` : "";
    panel.count.title = `${sel} of ${rows.size} on this page selected`;
    panel.title.textContent = `Deepline · ${rows.size} on page · ${sel} selected`;
    reportContext(context());
  };

  const toggle = async (st: RowState, on: boolean) => {
    if (on) {
      const r = await send<BasketResponse & { added: number; full: boolean }>({ type: "BASKET_ADD", leads: [st.lead], pageType, pageUrl: location.href, pageTitle: document.title });
      if (!alive) return;
      if (r.full) panel.setStatus("You have 500 people selected, the maximum. Push or clear them first.", "warn");
      basketKeys = new Set(r.items.map((i) => i.key));
    } else {
      const r = await send<BasketResponse>({ type: "BASKET_REMOVE", keys: [st.key] });
      if (!alive) return;
      basketKeys = new Set(r.items.map((i) => i.key));
    }
    refresh();
  };

  let decorating = false;
  const decorate = async () => {
    if (decorating || !alive) return;
    decorating = true;
    try {
      const found = listRows(document, pageType);
      const now = new Date().toISOString();
      const keys: string[] = [];
      for (const el of found) {
        if (rows.has(el)) continue;
        const lead = parseRow(el, pageType, now);
        if (!lead) continue;
        el.classList.add("lwe-row-host");
        const pick = makePick(document, lead.first_name ?? lead.full_name);
        const key = dedupeKey(lead);
        const st: RowState = { el, pick, key, lead, native: nativeCheckbox(el) };
        pick.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          void toggle(st, !basketKeys.has(st.key));
        });
        if (st.native) {
          const onNative = () => {
            if (!alive) return;
            const want = !!st.native?.checked;
            if (want !== basketKeys.has(st.key)) void toggle(st, want);
          };
          st.native.addEventListener("change", onNative);
          disposers.push(() => st.native?.removeEventListener("change", onNative));
        }
        el.appendChild(pick);
        rows.set(el, st);
        keys.push(key);
      }
      // Rows LinkedIn removed (virtualized lists) are dropped from the map.
      for (const [el, st] of rows) {
        if (!el.isConnected) {
          rows.delete(el);
          st.pick.remove();
        }
      }
      if (keys.length) {
        const seen = await send<Record<string, boolean>>({ type: "CHECK_DEDUPE", keys });
        if (!alive) return; // navigated away while waiting
        for (const st of rows.values()) {
          if (seen[st.key]) {
            st.el.classList.add("lwe-sent");
            st.pick.title = "Already sent";
          }
        }
      }
      refresh();
    } finally {
      decorating = false;
    }
  };

  const addAll = async (): Promise<void> => {
    const all = Array.from(rows.values());
    const unpicked = all.filter((r) => !basketKeys.has(r.key));
    if (!unpicked.length) {
      // Everything on the page is in already: the second click clears the page.
      const r = await send<BasketResponse>({ type: "BASKET_REMOVE", keys: all.map((x) => x.key) });
      if (!alive) return;
      basketKeys = new Set(r.items.map((i) => i.key));
      panel.secondary.textContent = "Add all on page";
      return refresh();
    }
    const r = await send<BasketResponse & { added: number; full: boolean }>({ type: "BASKET_ADD", leads: unpicked.map((x) => x.lead), pageType, pageUrl: location.href, pageTitle: document.title });
    if (!alive) return;
    basketKeys = new Set(r.items.map((i) => i.key));
    panel.secondary.textContent = "Remove all on page";
    panel.setStatus(r.full ? "You have 500 people selected, the maximum. Push or clear them first." : `${r.count} selected${r.pages > 1 ? ` across ${r.pages} pages` : ""}. Go to the next page to add more, or push now.`, r.full ? "warn" : "ok");
    refresh();
  };

  /** Add only the rows LinkedIn's own checkboxes have selected. */
  const addSelected = async (): Promise<void> => {
    const picked = Array.from(rows.values()).filter((r) => r.native?.checked && !basketKeys.has(r.key));
    if (!picked.length) return addAll();
    const r = await send<BasketResponse & { added: number; full: boolean }>({ type: "BASKET_ADD", leads: picked.map((x) => x.lead), pageType, pageUrl: location.href, pageTitle: document.title });
    if (!alive) return;
    basketKeys = new Set(r.items.map((i) => i.key));
    refresh();
  };

  const sendBasket = async (): Promise<void> => {
    panel.primary.disabled = true;
    panel.setStatus(`Pushing ${basketKeys.size}…`);
    const before = new Set(basketKeys);
    const res = await send<CaptureResponse & { sentFromPages: number }>({ type: "BASKET_SEND" });
    if (!alive) return;
    const s = summarize(res);
    panel.setStatus(res.ok && res.sentFromPages > 1 ? `${s.text} · from ${res.sentFromPages} pages` : s.text, s.kind);
    const b = await send<BasketResponse>({ type: "BASKET_GET" });
    if (!alive) return;
    basketKeys = new Set(b.items.map((i) => i.key));
    // Only rows that were selected and left the basket were pushed.
    for (const st of rows.values()) if (res.ok && before.has(st.key) && !basketKeys.has(st.key)) st.el.classList.add("lwe-sent");
    if (res.ok) disposers.push(toast(document, s.text));
    refresh();
  };

  const sendSearch = async (limit?: number): Promise<void> => {
    const settings = await getSettings();
    if (!alive) return;
    if (savedSearchId) {
      // The panel owns the saved-search recovery flow; hand off instead of sending the rep hunting.
      panel.setStatus("This saved search is private. Open the side panel to make it importable.", "warn");
      void send({ type: "OPEN_SIDE_PANEL" });
      return;
    }
    const r = await send<{ ok: boolean; queued: boolean; duplicate: boolean; rejectedReason: string | null; detail?: string | null }>({ type: "SEARCH_CAPTURE", url: location.href, pageType, totalHint: detectTotalHint(), limit: limit ?? settings.searchDefaultLimit, searchName: searchName(location.href, pageType, document.title) });
    if (!alive) return;
    if (!r.ok) {
      const why =
        r.rejectedReason === "no_destination"
          ? "Choose where to send first (open the panel)."
          : r.rejectedReason === "saved_search_needs_share_link"
            ? "This saved search is private. Open the side panel to make it importable."
            : r.rejectedReason === "unsupported_by_play"
              ? "This destination takes individual people, not whole searches. Choose a search-ready destination in the panel."
              : "Could not start the search import.";
      panel.setStatus(why, "err");
    } else panel.setStatus(r.duplicate ? "This search was already imported." : `Search import started (up to ${limit ?? settings.searchDefaultLimit} people). You can keep working.`, r.duplicate ? "warn" : "ok");
  };

  const shareSearch = (): boolean => {
    const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => /share search/i.test(b.textContent ?? ""));
    if (!btn) return false;
    btn.click();
    return true;
  };

  panel.secondary.addEventListener("click", () => void addAll());
  panel.primary.addEventListener("click", () => void sendBasket());
  panel.tertiary.addEventListener("click", () => void sendSearch());
  panel.openPanel.addEventListener("click", () => void send({ type: "OPEN_SIDE_PANEL" }));

  const b = await send<BasketResponse>({ type: "BASKET_GET" }).catch(() => ({ items: [] as BasketResponse["items"], count: 0, pages: 0 }));
  if (!alive) return { dispose: () => disposers.splice(0).forEach((d) => d()) };
  basketKeys = new Set(b.items.map((i) => i.key));
  relabel();
  await decorate();
  // LinkedIn renders lists incrementally and on scroll; observe the results
  // container (not the whole body) for new rows, debounced.
  const container = document.querySelector("#search-results-container, main") ?? document.body;
  let debounce: number | null = null;
  const mo = new MutationObserver(() => {
    if (debounce != null) clearTimeout(debounce);
    debounce = window.setTimeout(() => void decorate(), 300);
  });
  mo.observe(container, { childList: true, subtree: true });
  disposers.push(() => {
    mo.disconnect();
    if (debounce != null) clearTimeout(debounce);
    for (const st of rows.values()) {
      st.pick.remove();
      st.el.classList.remove("lwe-row-host", "lwe-sent", "lwe-in-basket");
    }
    rows.clear();
  });
  return {
    dispose: () => disposers.splice(0).forEach((d) => d()),
    basketChanged: (keys) => {
      basketKeys = new Set(keys);
      refresh();
    },
    action: async (a) => {
      if (a === "add_all") await addAll();
      else if (a === "add_selected") await addSelected();
      else if (a === "clear_page") {
        const r = await send<BasketResponse>({ type: "BASKET_REMOVE", keys: Array.from(rows.values()).map((x) => x.key) });
        basketKeys = new Set(r.items.map((i) => i.key));
        refresh();
      } else if (a === "share_search") {
        if (!shareSearch()) panel.setStatus("Could not find Sales Navigator's “Share search” button on this page.", "err");
        else panel.setStatus("Getting the shareable link…");
      } else if (a === "refresh") await decorate();
      return context();
    }
  };
}

/* ---------- single global message listener ---------- */

chrome.runtime.onMessage.addListener((m: BackgroundToContent, _s, sendResponse) => {
  if (m?.type === "PAGE_ACTION") {
    const run = active?.action ? active.action(m.action) : Promise.resolve(currentContext);
    run.then((ctx) => sendResponse(ctx ?? currentContext), () => sendResponse(currentContext));
    return true;
  }
  if (m?.type === "BASKET_CHANGED") active?.basketChanged?.(Array.isArray(m.keys) ? m.keys.filter((k): k is string => typeof k === "string") : []);
  if (m?.type === "SEND_CURRENT") active?.sendCurrent?.();
  return false;
});

// Share links copied by Sales Navigator's "Share search" (see main-world.ts).
window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin || !e.data || typeof e.data !== "object") return;
  const url = (e.data as Record<string, unknown>).__lwe_share_link__;
  if (typeof url === "string") void send({ type: "SHARE_LINK", url }).catch(() => undefined);
});

/* ---------- navigation controller ---------- */

/** Route identity: path + query minus session/tracking params, so a new
 *  search on the same path remounts, while a sessionId refresh does not. */
function routeKey(): string {
  const u = new URL(location.href);
  const parts = Array.from(u.searchParams.entries())
    .filter(([k]) => !isSensitiveParam(k))
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  return `${u.pathname}?${parts.join("&")}`;
}

let currentRoute = "";
let mounting: Promise<void> | null = null;
function boot(): void {
  const key = routeKey();
  if (key === currentRoute) return;
  currentRoute = key;
  const run = async () => {
    active?.dispose();
    active = null;
    const pageType = detectPageType(location.pathname);
    if (!pageType) {
      reportContext({ pageType: null, url: location.href, title: document.title, lead: null, rowsOnPage: 0, selectedOnPage: 0, savedSearchId: null, shareUrl: null, searchName: null, totalHint: null });
      return;
    }
    const mount = isListPage(pageType) ? await setupListPage(pageType) : await setupSinglePage(pageType);
    // A navigation during setup wins: tear down what we just built.
    if (routeKey() !== key) mount.dispose();
    else active = mount;
  };
  mounting = (mounting ?? Promise.resolve()).then(run, run);
}

boot();
// LinkedIn is a single-page app; watch every way the route can change.
for (const method of ["pushState", "replaceState"] as const) {
  const orig = history[method].bind(history);
  history[method] = (...args: Parameters<History["pushState"]>) => {
    orig(...args);
    setTimeout(boot, 400);
  };
}
window.addEventListener("popstate", () => setTimeout(boot, 400));
setInterval(() => {
  if (routeKey() !== currentRoute) boot();
}, 1500);
