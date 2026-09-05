// Build script: bundles TS entrypoints with esbuild and writes manifest.json.
// TEST_BUILD=1 adds a localhost match pattern so acceptance tests can load
// fixture pages that mimic LinkedIn routes without touching linkedin.com.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const isTest = process.env.TEST_BUILD === "1";
const outdir = resolve(isTest ? "dist-test" : "dist");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const linkedinMatches = ["https://www.linkedin.com/*", "https://linkedin.com/*"];
const testMatches = ["http://127.0.0.1/*", "http://localhost/*"];
const matches = isTest ? [...linkedinMatches, ...testMatches] : linkedinMatches;

const manifest = {
  manifest_version: 3,
  name: "Deepline for LinkedIn",
  short_name: "Deepline",
  version: pkg.version,
  description: "Push people from LinkedIn and Sales Navigator into a Deepline play, or hand a whole search to Deepline to fetch. Open source.",
  minimum_chrome_version: "116",
  // storage: settings/queue. alarms: retry schedule. sidePanel: the panel.
  // tabs: read the active tab's URL so the panel follows it (LinkedIn only,
  // via host_permissions) and relay actions to that tab's content script.
  permissions: ["storage", "alarms", "sidePanel", "tabs"],
  // Only LinkedIn is requested at install. The play/webhook host the user
  // configures is requested as an optional host permission at save time.
  host_permissions: matches,
  optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
  background: { service_worker: "background.js", type: "module" },
  content_scripts: [
    { matches, js: ["content.js"], css: ["content.css"], run_at: "document_idle" },
    // MAIN-world helper: hands the link copied by Sales Navigator's "Share
    // search" to the content script (saved searches only resolve for their
    // owner; the share link carries the full query a backend can run).
    { matches, js: ["main-world.js"], run_at: "document_start", world: "MAIN" }
  ],
  action: { default_title: "Deepline for LinkedIn" },
  side_panel: { default_path: "sidepanel.html" },
  options_ui: { page: "options.html", open_in_tab: true },
  commands: {
    "send-current": {
      suggested_key: { default: "Alt+Shift+L" },
      description: "Push the person on the current page"
    }
  },
  icons: { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
};
writeFileSync(resolve(outdir, "manifest.json"), JSON.stringify(manifest, null, 2));

await build({
  entryPoints: {
    background: "src/background/service-worker.ts",
    content: "src/content/index.ts",
    "main-world": "src/content/main-world.ts",
    options: "src/options/options.ts",
    sidepanel: "src/sidepanel/sidepanel.ts"
  },
  bundle: true,
  format: "esm",
  target: "chrome116",
  outdir,
  sourcemap: isTest ? "inline" : false,
  minify: !isTest,
  define: { __EXTENSION_VERSION__: JSON.stringify(pkg.version), __TEST_BUILD__: JSON.stringify(isTest), __LWE_DEBUG__: JSON.stringify(isTest || process.env.LWE_DEBUG === "1") },
  logLevel: "info"
});

for (const f of ["src/options/options.html", "src/sidepanel/sidepanel.html", "src/content/content.css"]) {
  cpSync(f, resolve(outdir, f.split("/").pop()));
}
cpSync("src/icons", resolve(outdir, "icons"), { recursive: true });
cpSync("src/brand", resolve(outdir, "brand"), { recursive: true });
console.log(`built -> ${outdir}`);
