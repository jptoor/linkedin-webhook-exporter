/** Panel UI lives in an open shadow root so LinkedIn's CSS cannot restyle it
 *  and the page cannot trivially spoof or query its internals. Row checkboxes
 *  must sit in the light DOM (they position inside LinkedIn rows) and stay
 *  styled by content.css. Tests locate controls by data-lwe-* attributes;
 *  Playwright pierces open shadow roots. */

const PANEL_CSS = `
:host { all: initial; position: fixed; z-index: 2147483000; right: 20px; bottom: 20px; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111; }
* { box-sizing: border-box; font-family: inherit; }
.panel { background: #fff; border: 1px solid #d0d7de; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 10px 12px; min-width: 220px; max-width: 360px; }
.title { font-weight: 600; font-size: 12px; color: #1C112A; margin-bottom: 6px; display: flex; gap: 6px; align-items: center; }
.mark { width: 14px; height: 14px; flex: none; background: #1C112A; -webkit-mask: var(--lwe-mark) no-repeat center / contain; mask: var(--lwe-mark) no-repeat center / contain; }
.row { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
button { appearance: none; border: 0; border-radius: 6px; padding: 7px 12px; background: #1C112A; color: #fff; font-weight: 600; font-size: 13px; cursor: pointer; }
button:hover { background: #2c1d42; }
button:focus-visible { outline: 2px solid #0a66c2; outline-offset: 2px; }
button:disabled { background: #a9a2b5; cursor: default; }
button.secondary { background: #f1eff5; color: #1C112A; }
.status { font-size: 12px; color: #555; margin-top: 6px; min-height: 16px; }
.status.ok { color: #1a7f37; } .status.err { color: #b42318; } .status.warn { color: #9a6700; }
.export { border-top: 1px solid #eef0f2; margin-top: 8px; padding-top: 8px; }
label.inline { font-size: 12px; color: #444; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
input[type=number] { width: 64px; padding: 5px 6px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 13px; }
input:focus-visible { outline: 2px solid #0a66c2; }
.progress .status { flex-basis: 100%; margin-top: 0; }
[hidden] { display: none !important; }
a.foot { display: block; margin-top: 8px; font-size: 11px; color: #6b6478; text-decoration: none; text-align: right; }
a.foot:hover { color: #1C112A; text-decoration: underline; }
`;

const MARK_SVG = `url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Cpath d='M14.8479 6.14148C14.8479 4.31179 13.3311 2.8285 11.4599 2.8285H0.00494977V0H11.4599C14.9286 7.71287e-07 17.7404 2.74962 17.7405 6.14148V17.5267H14.8479V6.14148ZM2.89599 8.23729V14.6959H8.89317V17.5244H0.0034555V8.23729H2.89599ZM13.3152 17.5267H10.4226V6.94413H0V4.11554H11.0514C12.3017 4.11555 13.3152 5.10668 13.3152 6.32924V17.5267Z'/%3E%3C/svg%3E")`;

export interface PanelHandles {
  host: HTMLElement;
  root: ShadowRoot;
  panel: HTMLElement;
  primary: HTMLButtonElement;
  secondary: HTMLButtonElement;
  status: HTMLElement;
  title: HTMLElement;
  setStatus(text: string, kind?: "ok" | "err" | "warn" | ""): void;
  dispose(): void;
}

export function mountPanel(doc: Document, titleText: string, primaryLabel: string, secondaryLabel: string | null): PanelHandles {
  doc.querySelectorAll("[data-lwe-panel]").forEach((e) => e.remove());
  const host = doc.createElement("div");
  host.setAttribute("data-lwe-panel", "");
  host.style.setProperty("--lwe-mark", MARK_SVG);
  const root = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = PANEL_CSS;
  root.appendChild(style);

  const panel = doc.createElement("section");
  panel.className = "panel";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "LinkedIn Webhook Exporter");
  const title = doc.createElement("div");
  title.className = "title";
  const mark = doc.createElement("span");
  mark.className = "mark";
  mark.setAttribute("aria-hidden", "true");
  const titleLabel = doc.createElement("h2");
  titleLabel.style.cssText = "font: inherit; margin: 0;";
  titleLabel.textContent = titleText;
  title.append(mark, titleLabel);
  const row = doc.createElement("div");
  row.className = "row";
  const primary = doc.createElement("button");
  primary.type = "button";
  primary.textContent = primaryLabel;
  primary.setAttribute("data-lwe-action", "send");
  row.appendChild(primary);
  const secondary = doc.createElement("button");
  secondary.type = "button";
  secondary.className = "secondary";
  secondary.setAttribute("data-lwe-action", "select-all");
  if (secondaryLabel) {
    secondary.textContent = secondaryLabel;
    row.appendChild(secondary);
  }
  const status = doc.createElement("div");
  status.className = "status";
  status.setAttribute("data-lwe-status", "");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const foot = doc.createElement("a");
  foot.className = "foot";
  foot.href = "https://deepline.com/?utm_source=linkedin-webhook-exporter";
  foot.target = "_blank";
  foot.rel = "noopener noreferrer";
  foot.textContent = "by Deepline";
  panel.append(title, row, status, foot);
  root.appendChild(panel);
  doc.body.appendChild(host);
  return {
    host,
    root,
    panel,
    primary,
    secondary,
    status,
    title: titleLabel,
    setStatus(text, kind = "") {
      status.textContent = text;
      status.className = `status${kind ? " " + kind : ""}`;
    },
    dispose() {
      host.remove();
    }
  };
}

export function toast(doc: Document, text: string, ms = 2500): void {
  const el = doc.createElement("div");
  el.className = "lwe-toast";
  el.setAttribute("role", "status");
  el.textContent = text;
  doc.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export interface ExportControls {
  form: HTMLElement;
  limit: HTMLInputElement;
  start: HTMLButtonElement;
  progress: HTMLElement;
  progressText: HTMLElement;
  pause: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  saveSearch: HTMLButtonElement;
}

/** "Export all results" controls appended to the list-page panel. */
export function mountExportControls(panel: PanelHandles, defaultLimit: number): ExportControls {
  const doc = panel.host.ownerDocument;
  const wrap = doc.createElement("div");
  wrap.className = "export";
  wrap.setAttribute("data-lwe-export", "");

  const form = doc.createElement("div");
  form.className = "row";
  const label = doc.createElement("label");
  label.className = "inline";
  label.textContent = "Export all pages, up to";
  const limit = doc.createElement("input");
  limit.type = "number";
  limit.min = "1";
  limit.max = "2500";
  limit.value = String(defaultLimit);
  limit.setAttribute("data-lwe-export-limit", "");
  limit.setAttribute("aria-label", "Maximum results to export");
  label.appendChild(limit);
  const start = doc.createElement("button");
  start.type = "button";
  start.textContent = "Export all";
  start.setAttribute("data-lwe-action", "export-all");
  const saveSearch = doc.createElement("button");
  saveSearch.type = "button";
  saveSearch.className = "secondary";
  saveSearch.textContent = "Save search";
  saveSearch.title = "Send this search's URL and filters to the webhook so a backend provider can run it";
  saveSearch.setAttribute("data-lwe-action", "save-search");
  form.append(label, start, saveSearch);

  const progress = doc.createElement("div");
  progress.className = "row progress";
  progress.hidden = true;
  const progressText = doc.createElement("span");
  progressText.className = "status";
  progressText.setAttribute("data-lwe-export-status", "");
  progressText.setAttribute("role", "status");
  progressText.setAttribute("aria-live", "polite");
  const pause = doc.createElement("button");
  pause.type = "button";
  pause.className = "secondary";
  pause.textContent = "Pause";
  pause.setAttribute("data-lwe-action", "export-pause");
  const stopBtn = doc.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "secondary";
  stopBtn.textContent = "Stop";
  stopBtn.setAttribute("data-lwe-action", "export-stop");
  progress.append(progressText, pause, stopBtn);

  wrap.append(form, progress);
  panel.panel.insertBefore(wrap, panel.panel.querySelector("a.foot"));
  return { form, limit, start, progress, progressText, pause, stopBtn, saveSearch };
}
