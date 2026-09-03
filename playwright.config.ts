import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/acceptance",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" }
});
