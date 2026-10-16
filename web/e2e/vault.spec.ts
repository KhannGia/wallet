import { expect, test } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { adminToken, advanceTime, config, nav, signUp, tokenBalance, VAULT_OWNER_KEYS } from "./support.ts";

test("two owners approve a payout from the vault, it waits out the timelock, and executes", async ({ page }) => {
    await signUp(page, "operator");
    await nav(page, "Vault");
    const recipient = privateKeyToAccount(generatePrivateKey()).address;

    await page.getByLabel("Admin token").fill(adminToken());
    await page.getByLabel(/Send USDC to/).fill(recipient);
    await page.getByLabel("Amount").fill("300");
    await page.getByRole("button", { name: "Open a proposal" }).click();
    const opened = (await page.getByRole("status").textContent())!;
    const id = /Proposal (\d+) opened/.exec(opened)![1]!;
    const row = page.getByTestId(`proposal-${id}`);
    await expect(page.getByTestId(`proposal-${id}-status`)).toContainText("collecting · 0/2");

    // Not the admin token's to approve: only owners sign.
    for (const key of VAULT_OWNER_KEYS.slice(0, 2)) {
        await page.getByLabel("Your owner key, to sign or cancel").fill(key);
        await row.getByRole("button", { name: "Sign" }).click();
        await expect(page.getByRole("status")).toContainText(`Signed #${id}`);
    }
    // Not a top-up of the hot wallet, so it waits out the delay.
    await expect(page.getByTestId(`proposal-${id}-status`)).toContainText("queued", { timeout: 30_000 });
    await advanceTime(180);
    await expect(page.getByTestId(`proposal-${id}-status`)).toContainText("executed", { timeout: 30_000 });

    const { token } = await config(page);
    expect(await tokenBalance(token.address, recipient)).toBe(300_000_000n);
});

test("a single owner cancels a queued payout", async ({ page }) => {
    await signUp(page, "canceller");
    await nav(page, "Vault");
    const recipient = privateKeyToAccount(generatePrivateKey()).address;

    await page.getByLabel("Admin token").fill(adminToken());
    await page.getByLabel(/Send USDC to/).fill(recipient);
    await page.getByLabel("Amount").fill("400");
    await page.getByRole("button", { name: "Open a proposal" }).click();
    const id = /Proposal (\d+) opened/.exec((await page.getByRole("status").textContent())!)![1]!;
    const row = page.getByTestId(`proposal-${id}`);
    for (const key of VAULT_OWNER_KEYS.slice(1, 3)) {
        await page.getByLabel("Your owner key, to sign or cancel").fill(key);
        await row.getByRole("button", { name: "Sign" }).click();
        await expect(page.getByRole("status")).toContainText(`Signed #${id}`);
    }
    await expect(page.getByTestId(`proposal-${id}-status`)).toContainText("queued", { timeout: 30_000 });

    await page.getByLabel("Your owner key, to sign or cancel").fill(VAULT_OWNER_KEYS[0]);
    await row.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId(`proposal-${id}-status`)).toContainText("cancelled", { timeout: 30_000 });

    await advanceTime(180);
    const { token } = await config(page);
    expect(await tokenBalance(token.address, recipient)).toBe(0n);
});
