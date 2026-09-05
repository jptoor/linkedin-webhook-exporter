/** On-page UI lives in an open shadow root so LinkedIn's CSS cannot restyle
 *  it and the page cannot trivially spoof or query its internals. Row toggles
 *  must sit in the light DOM (they position inside LinkedIn rows) and stay
 *  styled by content.css. Tests locate controls by data-lwe-* attributes;
 *  Playwright pierces open shadow roots.
 *
 *  The on-page piece is a small dock in the corner, like the launcher pills
 *  lemlist and Frontier float over Sales Navigator: the brand mark, one
 *  primary action ("Push"), a couple of quiet secondary actions on list pages,
 *  and a way into the side panel where everything else lives. */

const PANEL_CSS = `
:host { all: initial; position: fixed; z-index: 2147483000; right: 20px; bottom: 20px; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #1C112A; }
* { box-sizing: border-box; font-family: inherit; }
.dock { background: #FBF9FC; border: 1px solid #E8E3EE; border-radius: 14px; box-shadow: 0 10px 30px rgba(28,17,42,.18); padding: 8px; min-width: 200px; max-width: 340px; }
.top { display: flex; align-items: center; gap: 6px; }
.mark { width: 26px; height: 26px; border-radius: 8px; background: #1C112A; flex: none; display: inline-flex; align-items: center; justify-content: center; }
.mark i { display: block; width: 14px; height: 14px; background: #fff; -webkit-mask: var(--lwe-mark) no-repeat center / contain; mask: var(--lwe-mark) no-repeat center / contain; }
h2 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); margin: 0; }
button { appearance: none; border: 0; border-radius: 9px; padding: 7px 12px; background: #1C112A; color: #fff; font-weight: 600; font-size: 13px; cursor: pointer; white-space: nowrap; }
button:hover { background: #3A2D4A; }
button:focus-visible { outline: 2px solid #0a66c2; outline-offset: 2px; }
button:disabled { background: #EBE6F1; color: #6B6478; cursor: default; }
button.secondary { background: transparent; color: #1C112A; font-weight: 500; padding: 5px 8px; font-size: 12px; }
button.secondary:hover { background: #EBE6F1; }
button.open { background: transparent; color: #6B6478; padding: 6px; border-radius: 8px; }
button.open:hover { background: #EBE6F1; color: #1C112A; }
button.open svg { display: block; }
.count { font-weight: 600; font-size: 12px; color: #1C112A; padding: 0 4px; }
.more { display: flex; gap: 2px; margin-top: 4px; flex-wrap: wrap; }
.status { font-size: 12px; color: #6B6478; margin: 6px 4px 2px; min-height: 0; max-width: 320px; }
.status:empty { display: none; }
.status.ok { color: #1F7A3D; } .status.err { color: #A8261E; } .status.warn { color: #8A5A00; }
[hidden] { display: none !important; }
`;

const MARK_SVG = `url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Cpath d='M14.8479 6.14148C14.8479 4.31179 13.3311 2.8285 11.4599 2.8285H0.00494977V0H11.4599C14.9286 7.71287e-07 17.7404 2.74962 17.7405 6.14148V17.5267H14.8479V6.14148ZM2.89599 8.23729V14.6959H8.89317V17.5244H0.0034555V8.23729H2.89599ZM13.3152 17.5267H10.4226V6.94413H0V4.11554H11.0514C12.3017 4.11555 13.3152 5.10668 13.3152 6.32924V17.5267Z'/%3E%3C/svg%3E")`;
const OPEN_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>`;

export interface PanelHandles {
  host: HTMLElement;
  root: ShadowRoot;
  panel: HTMLElement;
  primary: HTMLButtonElement;
  secondary: HTMLButtonElement;
  tertiary: HTMLButtonElement;
  openPanel: HTMLButtonElement;
  status: HTMLElement;
  /** Visually hidden heading; its text is also mirrored into the dock's count badge. */
  title: HTMLElement;
  count: HTMLElement;
  setStatus(text: string, kind?: "ok" | "err" | "warn" | ""): void;
  dispose(): void;
}

export function mountPanel(doc: Document, titleText: string, primaryLabel: string, secondaryLabel: string | null, tertiaryLabel: string | null = null): PanelHandles {
  doc.querySelectorAll("[data-lwe-panel]").forEach((e) => e.remove());
  const host = doc.createElement("div");
  host.setAttribute("data-lwe-panel", "");
  host.style.setProperty("--lwe-mark", MARK_SVG);
  const root = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = PANEL_CSS;
  root.appendChild(style);

  const panel = doc.createElement("section");
  panel.className = "dock";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Deepline");
  const titleLabel = doc.createElement("h2");
  titleLabel.textContent = titleText;

  const top = doc.createElement("div");
  top.className = "top";
  const mark = doc.createElement("span");
  mark.className = "mark";
  mark.setAttribute("aria-hidden", "true");
  mark.appendChild(doc.createElement("i"));
  const count = doc.createElement("span");
  count.className = "count";
  count.setAttribute("data-lwe-count", "");
  const primary = doc.createElement("button");
  primary.type = "button";
  primary.textContent = primaryLabel;
  primary.setAttribute("data-lwe-action", "send");
  const openPanel = doc.createElement("button");
  openPanel.type = "button";
  openPanel.className = "open";
  openPanel.title = "Open Deepline side panel";
  openPanel.setAttribute("aria-label", "Open Deepline side panel");
  openPanel.innerHTML = OPEN_SVG;
  openPanel.setAttribute("data-lwe-action", "open-panel");
  top.append(mark, count, primary, openPanel);

  const more = doc.createElement("div");
  more.className = "more";
  const secondary = doc.createElement("button");
  secondary.type = "button";
  secondary.className = "secondary";
  secondary.setAttribute("data-lwe-action", "select-all");
  if (secondaryLabel) {
    secondary.textContent = secondaryLabel;
    more.appendChild(secondary);
  }
  const tertiary = doc.createElement("button");
  tertiary.type = "button";
  tertiary.className = "secondary";
  tertiary.setAttribute("data-lwe-action", "tertiary");
  if (tertiaryLabel) {
    tertiary.textContent = tertiaryLabel;
    more.appendChild(tertiary);
  }
  more.hidden = !secondaryLabel && !tertiaryLabel;

  const status = doc.createElement("div");
  status.className = "status";
  status.setAttribute("data-lwe-status", "");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  panel.append(titleLabel, top, more, status);
  root.appendChild(panel);
  doc.body.appendChild(host);
  return {
    host,
    root,
    panel,
    primary,
    secondary,
    tertiary,
    openPanel,
    status,
    title: titleLabel,
    count,
    setStatus(text, kind = "") {
      status.textContent = text;
      status.className = `status${kind ? " " + kind : ""}`;
    },
    dispose() {
      host.remove();
    }
  };
}

/** Returns a disposer so a mount can cancel the timer on teardown. */
export function toast(doc: Document, text: string, ms = 2500): () => void {
  const el = doc.createElement("div");
  el.className = "lwe-toast";
  el.setAttribute("role", "status");
  el.textContent = text;
  doc.body.appendChild(el);
  const t = setTimeout(() => el.remove(), ms);
  return () => {
    clearTimeout(t);
    el.remove();
  };
}

/** The per-row toggle: a visible round "+" that becomes a check. Not a
 *  checkbox hidden under LinkedIn's own checkbox: reps must be able to pick
 *  four people on a page without guessing where to click. */
export function makePick(doc: Document, name: string): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = "lwe-pick";
  b.setAttribute("data-lwe-row-check", "");
  b.dataset.name = name;
  setPicked(b, false);
  return b;
}

/** Label and title always say what the next click does. */
export function setPicked(b: HTMLButtonElement, picked: boolean): void {
  const name = b.dataset.name ?? "this person";
  b.setAttribute("aria-pressed", picked ? "true" : "false");
  b.textContent = picked ? "✓" : "+";
  const label = picked ? `Remove ${name} from selection` : `Select ${name}`;
  b.setAttribute("aria-label", label);
  b.title = label;
  const host = b.parentElement;
  if (host) host.classList.toggle("lwe-in-basket", picked);
}
