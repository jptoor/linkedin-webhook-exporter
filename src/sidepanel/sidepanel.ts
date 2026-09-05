/** Side panel for reps: what you are looking at, where it goes, one button.
 *  All state comes from the worker; page actions are relayed to the content
 *  script of the active tab. Vocabulary: push, selected, search import. */
import { summarizePlayInput, type PlaySummary } from "../shared/deepline";
import type { AuthResponse, BackgroundToPanel, BasketResponse, CaptureResponse, ListPlaysResponse, PageContext, SearchCaptureResponse, StateResponse } from "../shared/messages";
import type { Destination, LeadRecord, QueueItem } from "../shared/types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const msg = <T,>(m: unknown): Promise<T> => chrome.runtime.sendMessage(m) as Promise<T>;

let state: StateResponse | null = null;
let auth: AuthResponse | null = null;
let basket: BasketResponse = { items: [], count: 0, pages: 0 };
let context: PageContext | null = null;
let activeTabId: number | null = null;
/** When a search import was last started, so the pinned bar can say so. */
let searchImportStartedAt = 0;
let searchImportDest = "";

/* ---------- helpers ---------- */

function note(el: HTMLElement, text: string | null, kind: "ok" | "err" | "warn" | "info" = "info") {
  if (!text) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.className = `note ${kind}`;
}
function ctaStatus(text: string, kind: "ok" | "err" | "warn" | "" = "") {
  const el = $("ctaStatus");
  el.textContent = text;
  el.className = `status${kind ? " " + kind : ""}`;
}
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}
function avatar(lead: LeadRecord): HTMLElement {
  const a = document.createElement("span");
  a.className = "avatar";
  // Initials first; the photo replaces them only once it has actually loaded.
  a.textContent = initials(lead.full_name);
  if (lead.profile_image_url) {
    const img = document.createElement("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.hidden = true;
    img.addEventListener("load", () => {
      a.textContent = "";
      img.hidden = false;
      a.appendChild(img);
    });
    img.src = lead.profile_image_url;
  }
  return a;
}
function whyNot(r: CaptureResponse): string {
  switch (r.rejectedReason) {
    case "no_destination":
      return "Choose where to send first.";
    case "invalid_url":
      return "That play or webhook is not set up completely. Open Settings.";
    case "daily_cap":
      return `You hit today’s limit (${r.remainingToday} left). You can raise it in Settings.`;
    case "nothing_to_send":
      return "Nothing to push.";
    case "invalid_message":
      return "This is not a page the extension can read.";
    case "unsupported_by_play":
      return r.detail ?? "This play does not take people.";
    case "signed_out":
      return "Sign in to Deepline first.";
    default:
      return "Could not push.";
  }
}
function pluralPeople(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}
function activeDest(): Destination | null {
  return state?.settings.destinations.find((d) => d.id === state?.settings.activeDestinationId) ?? null;
}
function destLabel(d: Destination | null): string {
  return d ? d.name : "somewhere";
}

/* ---------- destination chip + picker ---------- */

function renderDest() {
  const d = activeDest();
  const btn = $("destBtn");
  btn.classList.toggle("empty", !d);
  $("destName").textContent = d ? d.name : "Choose a play";
  const none = !!state && state.settings.destinations.length === 0;
  const signedIn = !!auth?.signedIn;
  $("signIn").hidden = !none || signedIn;
  $("firstRun").hidden = !none || !signedIn;
  $("account").textContent = signedIn ? `· ${auth?.email ?? auth?.name ?? "signed in"}` : "for LinkedIn";
}

/* ---------- Deepline plays from the rep's own sign-in ---------- */

let sheetPlays: PlaySummary[] | null = null;
async function renderSheetPlays(force = false) {
  const box = $("sheetPlays");
  if (!auth?.signedIn) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const ul = $("sheetPlayList");
  const teach = (text: string) => {
    ul.textContent = "";
    const li = document.createElement("li");
    li.className = "teach";
    li.style.padding = "6px 8px";
    li.textContent = text;
    ul.appendChild(li);
  };
  if (!sheetPlays || force) {
    teach("Loading your plays…");
    const r = await msg<ListPlaysResponse>({ type: "LIST_PLAYS" });
    if (!r.ok) {
      sheetPlays = null;
      teach(r.error?.includes("signed in") ? "Your Deepline sign-in expired. Sign in again." : `Could not load plays: ${r.error}`);
      return;
    }
    sheetPlays = r.plays;
  }
  ul.textContent = "";
  const q = sheetQuery.trim().toLowerCase();
  const connected = new Set(state?.settings.destinations.map((d) => (d.kind === "deepline_play" ? d.playKey : "")) ?? []);
  const items = sheetPlays.filter((p) => !connected.has(p.playKey) && (!q || p.displayName.toLowerCase().includes(q) || p.playKey.toLowerCase().includes(q))).sort((a, b) => (a.origin === b.origin ? a.displayName.localeCompare(b.displayName) : a.origin === "owned" ? -1 : 1));
  if (!items.length) return teach(sheetPlays.length ? "All your plays are connected." : "No plays in this Deepline workspace yet.");
  for (const p of items.slice(0, 50)) {
    const li = document.createElement("li");
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "pick";
    pick.setAttribute("data-lwe-play", p.playKey);
    const t = document.createElement("span");
    t.className = "t";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = p.displayName;
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = `${p.origin === "prebuilt" ? "Deepline prebuilt · " : ""}${summarizePlayInput(p.input)}`;
    t.append(n, k);
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = "Add";
    pick.append(t, kind);
    pick.addEventListener("click", async () => {
      state = await msg<StateResponse>({ type: "ADD_PLAY_DESTINATION", playKey: p.playKey, playName: p.displayName, inputSchema: p.inputSchema, activate: true });
      closeSheet();
      renderAll();
      ctaStatus(`Connected ${p.displayName}.`, "ok");
    });
    li.append(pick);
    ul.appendChild(li);
  }
}

async function refreshAuth(refresh = false) {
  auth = await msg<AuthResponse>({ type: "GET_AUTH", refresh });
  renderDest();
}

let sheetQuery = "";
function renderSheet() {
  if (!state) return;
  const ul = $("sheetList");
  ul.textContent = "";
  const q = sheetQuery.trim().toLowerCase();
  const items = state.settings.destinations
    .filter((d) => !q || d.name.toLowerCase().includes(q) || (d.kind === "deepline_play" && d.playKey.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "teach";
    li.style.padding = "10px 8px";
    li.textContent = state.settings.destinations.length ? "No matches." : "Nothing connected yet. Add a Deepline play (or a webhook) below.";
    ul.appendChild(li);
  }
  for (const d of items) {
    const li = document.createElement("li");
    if (d.id === state.settings.activeDestinationId) li.className = "current";
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "pick";
    pick.setAttribute("data-lwe-dest", d.id);
    const t = document.createElement("span");
    t.className = "t";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = d.name;
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = d.kind === "deepline_play" ? d.playKey : safeHost(d.url);
    t.append(n, k);
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = d.kind === "deepline_play" ? "Play" : "Webhook";
    pick.append(t, kind);
    pick.addEventListener("click", async () => {
      state = await msg<StateResponse>({ type: "SET_ACTIVE_DESTINATION", destinationId: d.id });
      closeSheet();
      renderAll();
    });
    const star = document.createElement("button");
    star.type = "button";
    star.className = "star";
    star.setAttribute("aria-pressed", d.favorite ? "true" : "false");
    star.setAttribute("aria-label", d.favorite ? `Unpin ${d.name}` : `Pin ${d.name}`);
    star.textContent = d.favorite ? "★" : "☆";
    star.addEventListener("click", async (e) => {
      e.stopPropagation();
      state = await msg<StateResponse>({ type: "TOGGLE_FAVORITE", destinationId: d.id });
      renderSheet();
    });
    li.append(pick, star);
    ul.appendChild(li);
  }
}
function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}
function openSheet() {
  renderSheet();
  void renderSheetPlays();
  $("sheet").hidden = false;
  $<HTMLInputElement>("sheetSearch").focus();
}
function closeSheet() {
  if ($("sheet").hidden) return;
  $("sheet").hidden = true;
  $("destBtn").focus();
}
/** Keep keyboard focus inside the open sheet. */
$("sheet").addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const focusables = Array.from($("sheet").querySelectorAll<HTMLElement>("button, input")).filter((el) => !el.hidden && el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

/* ---------- page ---------- */

function renderPage() {
  const ctx = context;
  const single = !!ctx && (ctx.pageType === "profile" || ctx.pageType === "salesnav_lead");
  const list = !!ctx && (ctx.pageType === "salesnav_search" || ctx.pageType === "salesnav_list" || ctx.pageType === "people_search");
  $("pageNone").hidden = single || list;
  $("pageSingle").hidden = !single;
  $("pageList").hidden = !list;
  $("searchSection").hidden = !(list && ctx?.pageType === "salesnav_search");
  if (single && ctx) {
    const lead = ctx.lead;
    const av = $("leadAvatar");
    av.replaceWith(lead ? Object.assign(avatar(lead), { id: "leadAvatar" }) : Object.assign(document.createElement("span"), { id: "leadAvatar", className: "avatar" }));
    $("leadName").textContent = lead?.full_name ?? "Reading the page…";
    $("leadMeta").textContent = lead ? [lead.title, lead.company_name].filter(Boolean).join(" · ") + (lead.location ? ` · ${lead.location}` : "") : "";
    $<HTMLButtonElement>("addCurrent").disabled = !lead;
    $("addCurrent").textContent = lead ? `Add ${lead.first_name ?? lead.full_name} to selection (push later)` : "Add to selection (push later)";
  }
  if (list && ctx) {
    const onPage = ctx.selectedOnPage;
    $("listTitle").textContent = basket.count ? `${basket.count} selected${basket.pages > 1 ? ` across ${basket.pages} pages` : ""}` : "Selected people";
    $("addAll").textContent = ctx.rowsOnPage && onPage >= ctx.rowsOnPage ? `Remove all ${ctx.rowsOnPage} on this page` : `Add all${ctx.rowsOnPage ? ` ${ctx.rowsOnPage}` : ""} on this page`;
    $("clearAll").hidden = basket.count === 0;
    $("listTeach").hidden = basket.count > 0;
    const isSearch = ctx.pageType === "salesnav_search";
    if (isSearch) {
      const d = activeDest();
      const can = !!d && (d.kind === "webhook" || d.input.acceptsSearch);
      const lim = Number($<HTMLInputElement>("searchLimit").value) || state?.settings.searchDefaultLimit || 100;
      $("searchTitle").textContent = ctx.searchName ? `Import up to ${lim} people from “${ctx.searchName.slice(0, 60)}${ctx.searchName.length > 60 ? "…" : ""}”` : `Import up to ${lim} people from this search`;
      $("searchBlurb").textContent = d ? `${d.name} will fetch matching people in the background. You can keep working in LinkedIn.` : "Choose where to send first.";
      $<HTMLButtonElement>("sendSearch").disabled = !can || (!!ctx.savedSearchId && !ctx.shareUrl);
      $("savedNote").hidden = !ctx.savedSearchId || !!ctx.shareUrl;
      $("shareOk").hidden = !ctx.shareUrl;
      // The capability warning is derived state; a transient result message
      // ("Importing up to 40 people…") must survive re-renders.
      const sn = $("searchNote");
      if (d && !can) {
        note(sn, `${d.name} can receive individual people, not whole searches. Choose a search-ready destination, or select people one by one.`, "warn");
        sn.dataset.derived = "1";
      } else if (sn.dataset.derived) {
        note(sn, null);
        delete sn.dataset.derived;
      }
    }
  }
  renderCta();
}

function renderPeople() {
  const ul = $("people");
  ul.textContent = "";
  for (const it of basket.items.slice().reverse()) {
    const li = document.createElement("li");
    li.className = "person";
    li.setAttribute("data-lwe-selected", it.key);
    const who = document.createElement("span");
    who.className = "who";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = it.lead.full_name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = [it.lead.title, it.lead.company_name].filter(Boolean).join(" · ") || "LinkedIn";
    who.append(name, meta);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "icon-btn x";
    x.setAttribute("aria-label", `Remove ${it.lead.full_name}`);
    x.textContent = "×";
    x.addEventListener("click", async () => {
      basket = await msg<BasketResponse>({ type: "BASKET_REMOVE", keys: [it.key] });
      renderAll();
    });
    li.append(avatar(it.lead), who, x);
    ul.appendChild(li);
  }
}

/** The pinned button always says exactly what will happen. */
function renderCta() {
  const cta = $<HTMLButtonElement>("cta");
  const d = activeDest();
  const single = context?.pageType === "profile" || context?.pageType === "salesnav_lead";
  const importing = Date.now() - searchImportStartedAt < 20_000;
  if (!d) {
    cta.textContent = "Choose where to send";
    cta.disabled = false;
    cta.dataset.mode = "choose";
  } else if (basket.count === 0 && !(single && context?.lead) && importing) {
    cta.textContent = `Search import started for ${searchImportDest || destLabel(d)}`;
    cta.disabled = true;
    cta.dataset.mode = "none";
  } else if (basket.count > 0) {
    cta.textContent = `Push ${pluralPeople(basket.count)} to ${destLabel(d)}`;
    cta.disabled = false;
    cta.dataset.mode = "basket";
  } else if (single && context?.lead) {
    cta.textContent = `Push ${context.lead.first_name ?? context.lead.full_name} to ${destLabel(d)}`;
    cta.disabled = false;
    cta.dataset.mode = "current";
  } else {
    cta.textContent = single ? "Reading the page…" : "Pick people to push";
    cta.disabled = true;
    cta.dataset.mode = "none";
  }
  if (state) {
    $("sentToday").textContent = String(state.sentToday);
    $("capTotal").textContent = String(state.settings.dailyCap);
  }
}

async function pageAction(action: "add_selected" | "add_all" | "clear_page" | "share_search" | "send_current" | "refresh"): Promise<PageContext | null> {
  if (activeTabId == null) return null;
  try {
    const ctx = (await chrome.tabs.sendMessage(activeTabId, { type: "PAGE_ACTION", action })) as PageContext | null;
    if (ctx) context = { ...ctx, shareUrl: ctx.shareUrl ?? context?.shareUrl ?? null };
    return ctx;
  } catch {
    note($("pageNote"), "Reload the LinkedIn tab once so the extension can see it.", "warn");
    return null;
  }
}

/** Tests and debugging can pin the panel to a tab with `?tab=<id>`; otherwise
 *  it follows the active tab of the window it lives in. */
const PINNED_TAB = Number(new URLSearchParams(location.search).get("tab")) || null;

async function loadContext() {
  const [tab] = PINNED_TAB ? [await chrome.tabs.get(PINNED_TAB).catch(() => undefined)] : await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  context = activeTabId != null ? await msg<PageContext | null>({ type: "GET_PAGE_CONTEXT", tabId: activeTabId }) : null;
  renderPage();
}

/* ---------- recent ---------- */

function chipFor(item: QueueItem): { cls: string; text: string } {
  if (item.status === "sent") return { cls: "sent", text: item.destinationKind === "deepline_play" ? "Running" : "Sent" };
  if (item.status === "failed") return { cls: "failed", text: "Failed" };
  if (item.status === "sending") return { cls: "sending", text: "Sending" };
  return item.attempts > 0 ? { cls: "retry", text: "Retrying" } : { cls: "pending", text: "Queued" };
}
function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function renderRecent() {
  if (!state) return;
  const ul = $("recent");
  ul.textContent = "";
  const items = state.queue.slice(0, 8);
  $("recentEmpty").hidden = items.length > 0;
  $("retry").hidden = !state.queue.some((i) => i.status === "failed");
  for (const item of items) {
    const li = document.createElement("li");
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = item.label || (item.leadCount > 1 ? pluralPeople(item.leadCount) : (item.leadUrls[0] ?? "").replace(/^https?:\/\/www\.linkedin\.com\//, ""));
    what.title = item.lastError ? humanError(item.lastError) : item.runId ? `Run ${item.runId}` : "";
    const chip = document.createElement("span");
    const c = chipFor(item);
    chip.className = `chip ${c.cls}`;
    chip.textContent = c.text;
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = ago(item.createdAt);
    li.append(what, chip, when);
    ul.appendChild(li);
  }
}
function humanError(e: string): string {
  if (/failed to fetch|networkerror|timeout/i.test(e)) return "Could not reach the server. Check the address and your connection.";
  if (/HTTP 401|HTTP 403/.test(e)) return "The API key or secret was rejected.";
  if (/HTTP 4\d\d/.test(e)) return `The server rejected it: ${e}`;
  return e;
}

/* ---------- state ---------- */

async function refreshState() {
  state = await msg<StateResponse>({ type: "GET_STATE" });
  renderAll();
}
async function refreshBasket(b?: BasketResponse) {
  basket = b ?? (await msg<BasketResponse>({ type: "BASKET_GET" }));
  renderPeople();
  renderPage();
}
function renderAll() {
  renderDest();
  renderPeople();
  renderPage();
  renderRecent();
  if (state && !$<HTMLInputElement>("searchLimit").value) $<HTMLInputElement>("searchLimit").value = String(state.settings.searchDefaultLimit);
}

/* ---------- actions ---------- */

async function pushBasket() {
  const cta = $<HTMLButtonElement>("cta");
  cta.disabled = true;
  ctaStatus(`Pushing ${pluralPeople(basket.count)}…`);
  const r = await msg<CaptureResponse & { sentFromPages: number }>({ type: "BASKET_SEND", force: $<HTMLInputElement>("force").checked });
  if (r.ok && r.queued) ctaStatus(`${pluralPeople(r.queued)} on the way${r.skippedDuplicates.length ? `, ${r.skippedDuplicates.length} already pushed before` : ""}.`, "ok");
  else if (r.ok) ctaStatus(`All ${r.skippedDuplicates.length} were pushed before. Tick “resend duplicates” to push again.`, "warn");
  else ctaStatus(whyNot(r), "err");
  await refreshBasket();
  await refreshState();
}
async function pushCurrent() {
  ctaStatus("Pushing…");
  const ctx = await pageAction("send_current");
  if (ctx) ctaStatus("On the way. See Recent below.", "ok");
  await refreshState();
}

$("cta").addEventListener("click", () => {
  const mode = $("cta").dataset.mode;
  if (mode === "choose") return openSheet();
  if (mode === "basket") return void pushBasket();
  if (mode === "current") return void pushCurrent();
});
$("destBtn").addEventListener("click", openSheet);
$("sheetClose").addEventListener("click", closeSheet);
$("sheet").addEventListener("click", (e) => {
  if (e.target === $("sheet")) closeSheet();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("sheet").hidden) closeSheet();
});
$<HTMLInputElement>("sheetSearch").addEventListener("input", (e) => {
  sheetQuery = (e.target as HTMLInputElement).value;
  renderSheet();
  void renderSheetPlays();
});
$("sheetAdd").addEventListener("click", async () => {
  if (!auth?.signedIn) {
    await msg({ type: "SIGN_IN" });
    return;
  }
  await renderSheetPlays(true);
  $("sheetPlays").scrollIntoView({ block: "nearest" });
});
$("sheetSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("signInBtn").addEventListener("click", async () => {
  await msg({ type: "SIGN_IN" });
  note($("signInNote"), "A Deepline tab opened. Sign in there; this panel updates by itself.", "info");
});
$("signInSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("firstRunPick").addEventListener("click", () => {
  openSheet();
  void renderSheetPlays(true);
});
$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("firstRunSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$<HTMLInputElement>("searchLimit").addEventListener("input", renderPage);
$("openLog").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("options.html#log") }));

$("addCurrent").addEventListener("click", async () => {
  if (!context?.lead || !context.pageType) return;
  const r = await msg<BasketResponse & { added: number }>({ type: "BASKET_ADD", leads: [context.lead], pageType: context.pageType, pageUrl: context.url, pageTitle: context.title });
  note($("leadNote"), r.added ? `${context.lead.first_name ?? context.lead.full_name} added. ${pluralPeople(r.count)} ready to push.` : "Already selected.", r.added ? "ok" : "info");
  await refreshBasket(r);
});
$("addSelected").addEventListener("click", async () => {
  await pageAction("add_selected");
  await refreshBasket();
});
$("addAll").addEventListener("click", async () => {
  await pageAction("add_all");
  await refreshBasket();
});
$("clearAll").addEventListener("click", async () => refreshBasket(await msg<BasketResponse>({ type: "BASKET_CLEAR" })));
$("getShare").addEventListener("click", async () => {
  note($("searchNote"), "Getting a shareable link from Sales Navigator…", "info");
  await pageAction("share_search");
  setTimeout(() => void loadContext(), 1200);
});
$("sendSearch").addEventListener("click", async () => {
  if (!context?.pageType) return;
  const limit = Math.max(1, Math.min(2500, Number($<HTMLInputElement>("searchLimit").value) || 100));
  $<HTMLButtonElement>("sendSearch").disabled = true;
  note($("searchNote"), "Starting the search import…", "info");
  const r = await msg<SearchCaptureResponse>({ type: "SEARCH_CAPTURE", url: context.url, pageType: context.pageType, totalHint: context.totalHint, limit, searchName: context.searchName, savedSearchId: context.savedSearchId, force: $<HTMLInputElement>("force").checked });
  $<HTMLButtonElement>("sendSearch").disabled = false;
  if (r.ok && !r.duplicate) {
    searchImportStartedAt = Date.now();
    searchImportDest = destLabel(activeDest());
    note($("searchNote"), `Search import started: up to ${limit} people are being fetched for ${searchImportDest}. You can keep working.`, "ok");
    ctaStatus(`Search import started for ${searchImportDest}.`, "ok");
    renderCta();
    setTimeout(renderCta, 21_000);
  } else if (r.ok) note($("searchNote"), "This search was already imported. Tick “Allow people already sent” to import it again.", "warn");
  else if (r.rejectedReason === "saved_search_needs_share_link") note($("searchNote"), "This saved search is private. Get the shareable link first (above).", "warn");
  else if (r.rejectedReason === "signed_out") note($("searchNote"), "Sign in to Deepline first.", "err");
  else if (r.rejectedReason === "search_import_disabled") note($("searchNote"), "Search import is paused for this version of the extension.", "warn");
  else note($("searchNote"), r.detail ?? whyNot({ ok: false, queued: 0, skippedDuplicates: [], rejectedReason: r.rejectedReason as CaptureResponse["rejectedReason"], remainingToday: state?.remainingToday ?? 0 }), "err");
  await refreshState();
});
$("retry").addEventListener("click", async () => {
  state = await msg<StateResponse>({ type: "RETRY_NOW" });
  renderRecent();
});

chrome.runtime.onMessage.addListener((m: BackgroundToPanel) => {
  if (m?.type === "CONTEXT_CHANGED" && m.tabId === activeTabId) {
    context = m.context;
    renderPage();
  } else if (m?.type === "BASKET_CHANGED") void refreshBasket();
  else if (m?.type === "STATE_CHANGED") void refreshState();
  else if (m?.type === "AUTH_CHANGED") {
    auth = m.auth;
    sheetPlays = null;
    renderDest();
    if (auth.signedIn) note($("signInNote"), null);
  }
});
chrome.tabs.onActivated.addListener(() => {
  if (!PINNED_TAB) void loadContext();
});
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === activeTabId && (info.status === "complete" || info.url)) void loadContext();
});

void refreshState();
// A fresh check on every open: the rep may have signed in or out since.
void refreshAuth(true);
void loadContext();
void refreshBasket();
setInterval(() => void refreshState(), 5000);
// Errors in the panel are reported through the worker, like worker errors.
window.addEventListener("error", (e) => void msg({ type: "PANEL_ERROR", message: String(e.message), stack: e.error instanceof Error ? e.error.stack : null }).catch(() => undefined));
window.addEventListener("unhandledrejection", (e) => void msg({ type: "PANEL_ERROR", message: e.reason instanceof Error ? e.reason.message : String(e.reason), stack: e.reason instanceof Error ? (e.reason.stack ?? null) : null }).catch(() => undefined));
