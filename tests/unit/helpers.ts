import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadFixture(name: string, url: string): Document {
  const html = readFileSync(resolve(__dirname, "../fixtures", name), "utf8");
  return new JSDOM(html, { url }).window.document;
}
