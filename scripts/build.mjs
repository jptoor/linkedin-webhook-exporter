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
  name: "LinkedIn Webhook Exporter",
  version: pkg.version,
  description: "Send LinkedIn and Sales Navigator leads to any webhook, Deepline play, or CRM list. Open source, by Deepline.",
  minimum_chrome_version: "116",
  permissions: ["storage", "alarms"],
  // Only LinkedIn is requested at install. The webhook URL the user
  // configures is requested as an optional host permission at save time.
  host_permissions: matches,
  optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
  background: { service_worker: "background.js", type: "module" },
  content_scripts: [
    {
      matches,
      js: ["content.js"],
      css: ["content.css"],
      run_at: "document_idle"
    }
  ],
  action: { default_popup: "popup.html", default_title: "LinkedIn Webhook Exporter" },
  options_ui: { page: "options.html", open_in_tab: true },
  commands: {
    "send-current": {
      suggested_key: { default: "Alt+Shift+L" },
      description: "Send the current LinkedIn profile to the webhook"
    }
  },
  icons: { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
};
writeFileSync(resolve(outdir, "manifest.json"), JSON.stringify(manifest, null, 2));

await build({
  entryPoints: {
    background: "src/background/service-worker.ts",
    content: "src/content/index.ts",
    options: "src/options/options.ts",
    popup: "src/popup/popup.ts"
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

for (const f of ["src/options/options.html", "src/popup/popup.html", "src/content/content.css"]) {
  cpSync(f, resolve(outdir, f.split("/").pop()));
}
cpSync("src/icons", resolve(outdir, "icons"), { recursive: true });
cpSync("src/brand", resolve(outdir, "brand"), { recursive: true });
console.log(`built -> ${outdir}`);
