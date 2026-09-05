import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/acceptance",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" }
});
