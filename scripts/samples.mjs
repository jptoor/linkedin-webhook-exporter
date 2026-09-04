// Serve the sample pages on LinkedIn-shaped paths so the TEST build of the
// extension (npm run build:test, which matches http://127.0.0.1) can be
// exercised end to end without touching linkedin.com.
//   npm run samples   ->  http://127.0.0.1:8790/
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pagedSalesNav, delayedSalesNav, appendedSalesNav } from "../tests/fixtures/generators.mjs";

const dir = resolve("samples");
const PORT = Number(process.env.PORT ?? 8790);
const routes = [
  [/^\/$/, "index.html"],
  [/^\/in\/jane-doe-123\/?$/, "profile-classic.html"],
  [/^\/in\/[^/]+\/?$/, "profile-sdui.html"],
  [/^\/search\/results\/people/, "people-search-sdui.html"],
  [/^\/sales\/lists\/people\//, "salesnav-list.html"],
  [/^\/sales\/lead\//, "salesnav-lead.html"]
];
const server = createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (/^\/sales\/search\/people/.test(u.pathname)) {
    const page = Number(u.searchParams.get("page") ?? "1");
    const q = u.searchParams.get("query");
    const body = q === "delayed" ? delayedSalesNav(page) : q === "appended" ? appendedSalesNav(page) : pagedSalesNav(page);
    return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  }
  const hit = routes.find(([re]) => re.test(u.pathname));
  const file = hit ? resolve(dir, hit[1]) : null;
  if (!file || !existsSync(file)) return res.writeHead(404).end("no sample for " + u.pathname);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(file));
});
server.listen(PORT, "127.0.0.1", () => console.log(`samples on http://127.0.0.1:${server.address().port}/  (load dist-test/ as an unpacked extension)`));
