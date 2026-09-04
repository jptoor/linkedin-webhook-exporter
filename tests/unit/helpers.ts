import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadFixture(name: string, url: string): Document {
  const html = readFileSync(resolve(__dirname, "../fixtures", name), "utf8");
  return new JSDOM(html, { url }).window.document;
}
export function loadSample(name: string, url: string): Document {
  const html = readFileSync(resolve(__dirname, "../../samples", name), "utf8");
  return new JSDOM(html, { url }).window.document;
}
export function dom(html: string, url = "https://www.linkedin.com/in/x-y-z/"): Document {
  return new JSDOM(html, { url }).window.document;
}
