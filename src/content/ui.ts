export interface PanelHandles {
  root: HTMLElement;
  primary: HTMLButtonElement;
  secondary: HTMLButtonElement;
  status: HTMLElement;
  title: HTMLElement;
  setStatus(text: string, kind?: "ok" | "err" | "warn" | ""): void;
}

export function mountPanel(doc: Document, titleText: string, primaryLabel: string, secondaryLabel: string | null): PanelHandles {
  doc.querySelector(".lwe-root")?.remove();
  const root = doc.createElement("div");
  root.className = "lwe-root";
  root.setAttribute("data-lwe-panel", "");
  const panel = doc.createElement("div");
  panel.className = "lwe-panel";
  const title = doc.createElement("div");
  title.className = "lwe-title";
  const mark = doc.createElement("span");
  mark.className = "lwe-mark";
  mark.setAttribute("aria-hidden", "true");
  const titleLabel = doc.createElement("span");
  titleLabel.className = "lwe-title-text";
  titleLabel.textContent = titleText;
  title.append(mark, titleLabel);
  const row = doc.createElement("div");
  row.className = "lwe-row";
  const primary = doc.createElement("button");
  primary.className = "lwe-btn";
  primary.textContent = primaryLabel;
  primary.setAttribute("data-lwe-action", "send");
  row.appendChild(primary);
  const secondary = doc.createElement("button");
  secondary.className = "lwe-btn lwe-secondary";
  secondary.setAttribute("data-lwe-action", "select-all");
  if (secondaryLabel) {
    secondary.textContent = secondaryLabel;
    row.appendChild(secondary);
  }
  const status = doc.createElement("div");
  status.className = "lwe-status";
  status.setAttribute("data-lwe-status", "");
  const foot = doc.createElement("a");
  foot.className = "lwe-foot";
  foot.href = "https://deepline.com/?utm_source=linkedin-webhook-exporter";
  foot.target = "_blank";
  foot.rel = "noopener";
  foot.textContent = "by Deepline";
  panel.append(title, row, status, foot);
  root.appendChild(panel);
  doc.body.appendChild(root);
  return {
    root,
    primary,
    secondary,
    status,
    title: titleLabel,
    setStatus(text, kind = "") {
      status.textContent = text;
      status.className = `lwe-status${kind ? " lwe-" + kind : ""}`;
    }
  };
}

export function toast(doc: Document, text: string, ms = 2500): void {
  const el = doc.createElement("div");
  el.className = "lwe-toast";
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
  const doc = panel.root.ownerDocument;
  const wrap = doc.createElement("div");
  wrap.className = "lwe-export";
  wrap.setAttribute("data-lwe-export", "");

  const form = doc.createElement("div");
  form.className = "lwe-row";
  const label = doc.createElement("span");
  label.className = "lwe-label";
  label.textContent = "Export all pages, up to";
  const limit = doc.createElement("input");
  limit.type = "number";
  limit.min = "1";
  limit.max = "2500";
  limit.value = String(defaultLimit);
  limit.className = "lwe-input";
  limit.setAttribute("data-lwe-export-limit", "");
  const start = doc.createElement("button");
  start.className = "lwe-btn";
  start.textContent = "Export all";
  start.setAttribute("data-lwe-action", "export-all");
  form.append(label, limit, start);
  const saveSearch = doc.createElement("button");
  saveSearch.className = "lwe-btn lwe-secondary";
  saveSearch.textContent = "Save search";
  saveSearch.title = "Send this search's URL and filters to the webhook so a backend provider can run it";
  saveSearch.setAttribute("data-lwe-action", "save-search");
  form.append(saveSearch);

  const progress = doc.createElement("div");
  progress.className = "lwe-row lwe-progress";
  progress.hidden = true;
  const progressText = doc.createElement("span");
  progressText.className = "lwe-status";
  progressText.setAttribute("data-lwe-export-status", "");
  const pause = doc.createElement("button");
  pause.className = "lwe-btn lwe-secondary";
  pause.textContent = "Pause";
  pause.setAttribute("data-lwe-action", "export-pause");
  const stopBtn = doc.createElement("button");
  stopBtn.className = "lwe-btn lwe-secondary";
  stopBtn.textContent = "Stop";
  stopBtn.setAttribute("data-lwe-action", "export-stop");
  progress.append(progressText, pause, stopBtn);

  wrap.append(form, progress);
  const panelEl = panel.root.firstElementChild!;
  panelEl.insertBefore(wrap, panelEl.querySelector(".lwe-foot"));
  return { form, limit, start, progress, progressText, pause, stopBtn, saveSearch };
}
