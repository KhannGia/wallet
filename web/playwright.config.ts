import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the real frontend against the real demo stack: API,
 * chain, bundler, paymaster and every worker. `./wallet e2e` runs them in
 * Playwright's own image on the demo stack's network, so the addresses below
 * are Compose service names.
 */
export default defineConfig({
    testDir: "e2e",
    // One at a time: the tests share one chain, and a payout in one would
    // otherwise sit in the hot wallet's queue behind another's.
    workers: 1,
    timeout: 120_000,
    expect: { timeout: 30_000 },
    retries: 0,
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        baseURL: process.env.E2E_BASE_URL ?? "http://web:5173",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
