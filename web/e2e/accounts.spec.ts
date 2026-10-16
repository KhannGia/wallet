import { expect, test } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { advanceTime, config, graduated, nav, PASSWORD, tokenBalance } from "./support.ts";

const fresh = () => {
    const key = generatePrivateKey();
    return { key, address: privateKeyToAccount(key).address };
};

test("guardians hand a lost account to a new key, after the delay", async ({ page, browser }) => {
    const guardians = [fresh(), fresh()];
    const { email } = await graduated(page, "forgetful", guardians.map((g) => g.address), 2);
    await nav(page, "Guardians");
    await expect(page.getByTestId("guardian-threshold")).toHaveText("2");

    // A new browser: signed in, but with no owner key in it.
    const lost = await (await browser.newContext()).newPage();
    await lost.goto("/");
    await lost.getByLabel("Email").fill(email);
    await lost.getByLabel("Password").fill(PASSWORD);
    await lost.getByRole("button", { name: "Sign in" }).click();
    await lost.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Guardians", exact: true }).click();
    await lost.getByRole("button", { name: "Ask my guardians" }).click();
    const link = (await lost.getByTestId("guardian-link").textContent())!.trim();

    // Each guardian, in a browser of their own, not signed in to anything.
    for (const guardian of guardians) {
        const theirs = await (await browser.newContext()).newPage();
        await theirs.goto(link.replace(/^https?:\/\/[^/]+/, ""));
        await theirs.getByLabel("Your guardian key").fill(guardian.key);
        await theirs.getByRole("button", { name: "Approve the recovery" }).click();
        await expect(theirs.getByRole("status")).toContainText("Approved as");
    }
    await expect(lost.getByTestId("recovery-status")).toHaveText("STARTED");

    // The old browser sees the alarm: 48 hours to stop it.
    await page.reload();
    await expect(page.getByTestId("pending-recovery")).toBeVisible();

    await advanceTime(48 * 3600 + 60);
    // Once the relayer executes it, this browser's key is the owner's: the
    // lost-key panel has nothing left to offer, and goes.
    await expect(lost.getByRole("region", { name: "Lost key" })).toHaveCount(0, { timeout: 60_000 });

    // The new key owns the account now, and spends from it.
    await lost.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Smart account", exact: true }).click();
    await expect(lost.getByText("— the key in this browser")).toBeVisible();
    const recipient = fresh().address;
    await lost.getByLabel("Recipient address").fill(recipient);
    await lost.getByLabel("Amount").fill("5");
    await lost.getByRole("button", { name: "Sign and send" }).click();
    await expect(lost.getByRole("status")).toContainText("Sent 5");
    const { token } = await config(page);
    expect(await tokenBalance(token.address, recipient)).toBe(5_000_000n);
});

test("the owner stops a recovery they did not ask for", async ({ page, browser }) => {
    const guardian = fresh();
    const { email } = await graduated(page, "watchful", [guardian.address], 1);

    const impostor = await (await browser.newContext()).newPage();
    await impostor.goto("/");
    await impostor.getByLabel("Email").fill(email);
    await impostor.getByLabel("Password").fill(PASSWORD);
    await impostor.getByRole("button", { name: "Sign in" }).click();
    await impostor.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Guardians", exact: true }).click();
    await impostor.getByRole("button", { name: "Ask my guardians" }).click();
    const link = (await impostor.getByTestId("guardian-link").textContent())!.trim();
    const theirs = await (await browser.newContext()).newPage();
    await theirs.goto(link.replace(/^https?:\/\/[^/]+/, ""));
    await theirs.getByLabel("Your guardian key").fill(guardian.key);
    await theirs.getByRole("button", { name: "Approve the recovery" }).click();
    await expect(impostor.getByTestId("recovery-status")).toHaveText("STARTED");

    await nav(page, "Guardians");
    await page.getByRole("button", { name: "This was not me — stop it" }).click();
    await expect(page.getByRole("status")).toContainText("Recovery stopped");
    await expect(page.getByTestId("pending-recovery")).toHaveCount(0);
    await expect(impostor.getByTestId("recovery-status")).toHaveText("CANCELLED", { timeout: 30_000 });
});

test("a session key spends within its cap, and nothing once revoked", async ({ page }) => {
    await graduated(page, "delegator");
    await nav(page, "Sessions");
    await page.getByLabel("Valid for (hours)").fill("1");
    await page.getByLabel(/At most, in total/).fill("20");
    await page.getByRole("button", { name: "Grant a session key" }).click();
    const sessionKey = (await page.getByTestId("session-key").textContent())!.trim();
    await expect(page.getByTestId("session-row")).toContainText("active");

    const recipient = fresh().address;
    const send = async (amount: string) => {
        await page.getByLabel("Session key", { exact: true }).fill(sessionKey);
        await page.getByLabel("Recipient address").fill(recipient);
        await page.getByLabel("Amount").fill(amount);
        await page.getByRole("button", { name: "Send as the app" }).click();
    };

    await send("15");
    await expect(page.getByText("Sent 15 USDC with the session key")).toBeVisible();
    await expect(page.getByTestId("session-row")).toContainText("15 / 20 used");

    // Over the cap: the account refuses, whoever pays the gas.
    await send("10");
    await expect(page.getByRole("alert")).toBeVisible();
    const { token } = await config(page);
    expect(await tokenBalance(token.address, recipient)).toBe(15_000_000n);

    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByTestId("session-row")).toContainText("revoked");
    await send("1");
    await expect(page.getByRole("alert")).toBeVisible();
    expect(await tokenBalance(token.address, recipient)).toBe(15_000_000n);
});
