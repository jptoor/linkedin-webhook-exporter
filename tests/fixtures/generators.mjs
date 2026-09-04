/** Generated fixtures shared by the sample site and the acceptance harness. */
export const PAGED_TOTAL = 60;
export const PAGED_PAGES = 3;

const NAMES = ["Lead", "Zoë Ångström", "李 小龙", "José María de la Cruz", "Ayşe Öztürk 🚀", "O'Brien-Smith", "Nguyễn Văn An", "Владимир Петров", "Ẹ̀mí Adébáyọ̀", "Åsa Lindqvist"];

/** Display name for row n (before badge stripping). */
export function sampleName(n) {
  const base = NAMES[n % NAMES.length];
  return base === "Lead" ? `Lead ${n}` : `${base} ${n}`;
}

export function pagedSalesNav(page, opts = {}) {
  const start = (page - 1) * 25;
  const count = Math.max(0, Math.min(25, PAGED_TOTAL - start));
  const rows = Array.from({ length: count }, (_, i) => {
    const n = start + i + 1;
    const name = sampleName(n);
    return `<li class="artdeco-list__item">
      <a data-anonymize="headshot-photo" href="/sales/lead/ACwAAA${String(n).padStart(4, "0")}abcdef,NAME_SEARCH,x${n}"><img data-anonymize="headshot-photo" src="https://media.licdn.com/dms/image/${n}.jpg" alt=""></a>
      <a href="/sales/lead/ACwAAA${String(n).padStart(4, "0")}abcdef,NAME_SEARCH,x${n}"><span data-anonymize="person-name">${name}${n % 7 === 0 ? " is reachable" : ""}</span></a>
      <span class="artdeco-entity-lockup__degree">· ${["1st", "2nd", "3rd"][n % 3]}</span>
      <span data-anonymize="title">${n % 5 === 0 ? "Chief Revenue Officer (CRO)" : `Title ${n}`}</span>
      ${n % 6 === 0 ? `<span data-anonymize="company-name">Stealth ${n}</span>` : `<a data-anonymize="company-name" href="/sales/company/${1000 + n}?_ntb=abc">Company ${n}</a>`}
      <span data-anonymize="location">${n % 4 === 0 ? "Greater Paris Metropolitan Region" : `City ${n}, Country`}</span>
    </li>`;
  }).join("\n");
  const last = page >= PAGED_PAGES;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Search | Sales Navigator</title><style>li.artdeco-list__item{min-height:96px;border-bottom:1px solid #eee}</style>${opts.head ?? ""}</head><body>
  <h2 data-lwe="results-count">${PAGED_TOTAL} results</h2>
  <div id="search-results-container" style="height:600px;overflow-y:auto"><ol class="artdeco-list">${rows}</ol></div>
  <button aria-label="Previous" ${page <= 1 ? "disabled" : ""}>Prev</button>
  <button aria-label="Next" ${last ? "disabled" : ""}>Next</button>
  </body></html>`;
}

/** Rows render as skeletons and materialize after a delay when scrolled,
 *  like Sales Navigator's deferred rows. */
export function delayedSalesNav(page) {
  const html = pagedSalesNav(page);
  const script = `<script>
    // Replace rows with skeletons; restore each row 250ms after it intersects the viewport.
    document.addEventListener('DOMContentLoaded', () => {
      const rows = [...document.querySelectorAll('#search-results-container li')];
      const real = rows.map(r => r.innerHTML);
      rows.forEach((r, i) => { r.innerHTML = '<div class="dummy-text"></div>'; r.dataset.idx = i; });
      const io = new IntersectionObserver(entries => {
        for (const e of entries) if (e.isIntersecting) { const r = e.target; io.unobserve(r); setTimeout(() => { r.innerHTML = real[r.dataset.idx]; }, 250); }
      }, { root: document.querySelector('#search-results-container') });
      rows.forEach(r => io.observe(r));
    });
  </script>`;
  return html.replace("</head>", script + "</head>");
}

/** Half the rows exist at load; the rest are APPENDED to the list 300 ms
 *  after the user scrolls near the bottom (true late insertion), and the Next
 *  control only becomes enabled once all rows are present. */
export function appendedSalesNav(page) {
  const html = pagedSalesNav(page);
  const script = `<script>
    document.addEventListener('DOMContentLoaded', () => {
      const ol = document.querySelector('#search-results-container ol');
      const rows = [...ol.querySelectorAll('li')];
      const late = rows.slice(Math.ceil(rows.length / 2));
      late.forEach(r => r.remove());
      const next = document.querySelector('button[aria-label="Next"]');
      const wasDisabled = next.disabled; next.disabled = true; next.setAttribute('data-was-disabled', String(wasDisabled));
      const box = document.querySelector('#search-results-container');
      let done = false;
      const release = () => { if (done) return; done = true; setTimeout(() => { late.forEach(r => ol.appendChild(r)); next.disabled = wasDisabled; }, 300); };
      box.addEventListener('scroll', () => { if (box.scrollTop + box.clientHeight >= box.scrollHeight - 40) release(); });
      // A page too short to scroll (e.g. the last one) releases its rows on its own, like a real lazy list that finishes loading.
      if (box.scrollHeight <= box.clientHeight + 10) setTimeout(release, 200);
    });
  </script>`;
  return html.replace("</head>", script + "</head>");
}

/** Two pages of exactly 25 rows: the last page is FULL, so only the disabled
 *  Next control (not the row count) can tell the exporter to stop. The results
 *  list also sits inside a nested scrolling wrapper. */
export function fullLastPageSalesNav(page) {
  const total = 50;
  const start = (page - 1) * 25;
  const count = Math.max(0, Math.min(25, total - start));
  const rows = Array.from({ length: count }, (_, i) => {
    const n = start + i + 1;
    return `<li class="artdeco-list__item"><a href="/sales/lead/ACwAAAfull${String(n).padStart(4, "0")}xx,NAME_SEARCH,f${n}"><span data-anonymize="person-name">Full ${n}</span></a><span data-anonymize="title">T${n}</span><a data-anonymize="company-name" href="/sales/company/${n}">C${n}</a><span data-anonymize="location">City ${n}, Country</span></li>`;
  }).join("\n");
  const last = page >= 2;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Search | Sales Navigator</title></head><body>
  <div style="height:700px;overflow-y:auto"><div style="padding:10px"><h2>${total} results</h2>
  <div id="search-results-container" style="height:500px;overflow-y:auto"><ol class="artdeco-list">${rows}</ol></div>
  <button aria-label="Next" ${last ? "disabled" : ""}>Next</button></div></div>
  </body></html>`;
}
