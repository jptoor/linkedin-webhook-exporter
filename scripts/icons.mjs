// Renders the Deepline mark onto a rounded plum tile at 16/48/128 px using
// Playwright's bundled Chromium, so icons match the brand SVG exactly.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const mark = readFileSync("src/brand/deepline-mark.svg", "utf8").replace('fill="black"', 'fill="#FCFCFD"');
const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage({ deviceScaleFactor: 1 });
mkdirSync("src/icons", { recursive: true });
for (const size of [16, 48, 128]) {
  const radius = Math.round(size * 0.22);
  const pad = Math.round(size * 0.2);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">
    <div style="width:${size}px;height:${size}px;border-radius:${radius}px;background:#1C112A;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:${pad}px">
      ${mark.replace(/width="18" height="18"/, 'width="100%" height="100%"')}
    </div></body></html>`);
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(`src/icons/icon${size}.png`, buf);
  console.log(`icon${size}.png`);
}
await browser.close();
