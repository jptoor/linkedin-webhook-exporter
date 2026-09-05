/** Page-context bridge (runs in the MAIN world at document_start).
 *
 *  Two passive observers, the same pattern Frontier / Exportly ship as their
 *  "interceptor" script:
 *
 *  1. Response interception. `XMLHttpRequest` and `fetch` are wrapped so that
 *     when the page itself loads one of the allow-listed LinkedIn API URLs
 *     (Sales Navigator `sales-api`, Voyager GraphQL / search), the response
 *     text is handed to the content script. The bridge never issues a request
 *     of its own, never changes a request or a response, and ignores every
 *     other URL. The content script uses the data to fill in what the DOM does
 *     not render (public profile URLs, exact names, result totals).
 *
 *  2. Share link. When Sales Navigator's own "Share search" copies a link, the
 *     copied text is forwarded so a saved search can be sent by its shareable
 *     URL.
 *
 *  Messages go through `window.postMessage` on the page's own origin with a
 *  fixed channel name; the content script validates them again. */
(() => {
  const CHANNEL = "LWE_BRIDGE";
  const PATTERNS = ["/sales-api/salesApiLeadSearch", "/sales-api/salesApiPeopleSearch", "/sales-api/salesApiProfiles", "/sales-api/salesApiCompanies", "/sales-api/salesApiAccountSearch", "/sales-api/salesApiDashboardAccountTable", "/voyager/api/graphql", "/voyager/api/search/dash/clusters", "/voyager/api/identity/dash/profiles"];
  const MAX_BYTES = 2 * 1024 * 1024;
  const wanted = (url: unknown): url is string => typeof url === "string" && PATTERNS.some((p) => url.includes(p));
  // The content script mounts at document_idle; responses that land before it
  // listens are held (bounded) and flushed when it says it is ready.
  let ready = false;
  const held: Array<Record<string, unknown>> = [];
  const deliver = (payload: Record<string, unknown>) => {
    try {
      window.postMessage(payload, location.origin);
    } catch {
      /* ignore */
    }
  };
  const post = (event: string, data: Record<string, unknown>) => {
    const payload = { channel: CHANNEL, event, windowUrl: location.href, ...data };
    if (ready) deliver(payload);
    else if (held.length < 20) held.push(payload);
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || typeof e.data !== "object") return;
    const d = e.data as Record<string, unknown>;
    if (d.channel === CHANNEL && d.event === "CONTENT_READY" && !ready) {
      ready = true;
      for (const p of held.splice(0)) deliver(p);
    }
  });
  const emit = (url: string, text: string) => {
    if (typeof text !== "string" || !text || text.length > MAX_BYTES) return;
    post("INTERCEPTED_DATA", { url, responseText: text });
  };

  // --- XMLHttpRequest -------------------------------------------------------
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    XHR.prototype.open = function (this: XMLHttpRequest & { __lweUrl?: string; __lweHooked?: boolean }, method: string, url: string | URL, ...rest: unknown[]) {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : String(url);
      // Remember the CURRENT url on every open, so a reused XHR that moves to
      // a non-matching endpoint is never reported under the old url.
      this.__lweUrl = wanted(u) ? u : undefined;
      if (this.__lweUrl && !this.__lweHooked) {
        this.__lweHooked = true;
        this.addEventListener("load", () => {
          const current = this.__lweUrl;
          if (!current) return;
          try {
            if (this.responseType === "" || this.responseType === "text") emit(current, this.responseText);
            else if (this.responseType === "json" && this.response != null) emit(current, JSON.stringify(this.response));
          } catch {
            /* ignore */
          }
        });
      }
      return (open as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
    } as typeof XHR.prototype.open;
  }

  // --- fetch ------------------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);
      const p = origFetch.call(this, input, init);
      if (wanted(u)) {
        p.then((res) => {
          try {
            // Do not buffer bodies that already declare themselves too large.
            const declared = Number(res.headers.get("content-length") ?? 0);
            if (declared > MAX_BYTES) return;
            const clone = res.clone();
            clone.text().then((t) => emit(u, t)).catch(() => undefined);
          } catch {
            /* ignore */
          }
        }).catch(() => undefined);
      }
      return p;
    };
  }

  // --- share link -----------------------------------------------------------
  const share = (text: unknown) => {
    if (typeof text === "string" && /linkedin\.com\/sales\/search\//.test(text)) post("SHARE_LINK", { url: text });
  };
  const clip = navigator.clipboard;
  if (clip && typeof clip.writeText === "function") {
    const orig = clip.writeText.bind(clip);
    // The native call goes first, untouched; the link is reported once it
    // has settled (the page's own error handling is unaffected either way).
    clip.writeText = (text: string) => {
      const p = orig(text);
      p.then(() => share(text), () => share(text));
      return p;
    };
  }
  if (clip && typeof clip.write === "function") {
    const origWrite = clip.write.bind(clip);
    clip.write = (items: ClipboardItems) => {
      const p = origWrite(items);
      const report = async () => {
        try {
          for (const item of items) if (item.types.includes("text/plain")) share(await (await item.getType("text/plain")).text());
        } catch {
          /* ignore */
        }
      };
      p.then(report, report);
      return p;
    };
  }
  document.addEventListener(
    "copy",
    (e) => {
      const data = e.clipboardData?.getData("text/plain");
      share(data || String(document.getSelection() ?? ""));
    },
    true
  );

})();
