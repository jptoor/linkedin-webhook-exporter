// Produce a release zip from dist/ and assert the production manifest has no
// test-only host patterns and only the expected permissions.
import { readFileSync, existsSync, createWriteStream } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const dist = resolve("dist");
if (!existsSync(resolve(dist, "manifest.json"))) throw new Error("run `npm run build` first");
const manifest = JSON.parse(readFileSync(resolve(dist, "manifest.json"), "utf8"));
const bad = [...manifest.host_permissions, ...manifest.content_scripts.flatMap((c) => c.matches)].filter((m) => /localhost|127\.0\.0\.1/.test(m));
if (bad.length) throw new Error(`production manifest contains test hosts: ${bad.join(", ")}`);
const allowed = new Set(["storage", "alarms"]);
const extra = manifest.permissions.filter((p) => !allowed.has(p));
if (extra.length) throw new Error(`unexpected permissions: ${extra.join(", ")}`);
if (!manifest.icons || !manifest.icons["128"]) throw new Error("manifest is missing icons");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const out = resolve(`linkedin-webhook-exporter-${pkg.version}.zip`);
execSync(`cd ${JSON.stringify(dist)} && zip -qr ${JSON.stringify(out)} .`);
const sha = execSync(`shasum -a 256 ${JSON.stringify(out)}`).toString().split(" ")[0];
console.log(`packed ${out}\nsha256 ${sha}`);
void createWriteStream;
