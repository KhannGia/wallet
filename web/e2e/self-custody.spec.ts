import { expect, test } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { config, deposit100, nav, signUp, tokenBalance } from "./support.ts";

test("graduates to a smart account in the browser, then spends from it with no ether", async ({ page }) => {
    await signUp(page, "graduate");
    await deposit100(page);
    await expect(page.getByRole("figure", { name: "Custody tier: starter" })).toBeVisible();

    await nav(page, "Self-custody");
    await page.getByRole("button", { name: "Make my key" }).click();
    const owner = (await page.getByTestId("owner-address").textContent())!;
    await page.getByRole("button", { name: "I have saved it somewhere safe" }).click();
    await page.getByRole("button", { name: "Start" }).click();

    // Guardians named in the same operation that deploys the account.
    const guardians = [privateKeyToAccount(generatePrivateKey()).address, privateKeyToAccount(generatePrivateKey()).address];
    await page.getByLabel(/Guardians/).fill(guardians.join("\n"));
    await page.getByLabel("How many must agree to recover").fill("2");
    await page.getByRole("button", { name: "Sign and deploy" }).click();
    await page.getByRole("button", { name: "Move my balance" }).click();
    await expect(page.getByTestId("graduated")).toContainText("100 USDC moved");
    await expect(page.getByRole("figure", { name: "Custody tier: smart" })).toBeVisible();

    // The account page reads the chain, not our database.
    await nav(page, "Smart account");
    await expect(page.getByTestId("smart-balance")).toHaveText("100");
    await expect(page.getByTestId("threshold")).toHaveText("2");
    await expect(page.getByText(owner)).toBeVisible();

    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    await page.getByLabel("Recipient address").fill(recipient);
    await page.getByLabel("Amount").fill("30");
    await page.getByRole("button", { name: "Sign and send" }).click();
    await expect(page.getByRole("status")).toContainText("gas paid by the platform");
    await expect(page.getByTestId("smart-balance")).toHaveText("70");

    const { token } = await config(page);
    expect(await tokenBalance(token.address, recipient)).toBe(30_000_000n);

    // Custody is empty: the balance left with the user.
    await nav(page, "Account");
    await expect(page.getByTestId("balance")).toHaveText("0");
});

test("checks the user's own balance against the root published on chain", async ({ page }) => {
    await signUp(page, "auditor");
    await deposit100(page);
    await nav(page, "Reserves");
    await expect(page.getByTestId("solvent")).toHaveText("Covered");

    // The reserves worker snapshots on a timer; until one includes this
    // account's deposit, the latest proves an older balance -- or none. Ask
    // again until it proves this one.
    await expect(async () => {
        await page.getByRole("button", { name: "Check my balance" }).click();
        await expect(page.getByTestId("verdict")).toContainText("Verified. 100 USDC owed to account", { timeout: 5_000 });
    }).toPass({ timeout: 90_000, intervals: [3_000] });
    await expect(page.getByRole("list", { name: "Proof" }).getByRole("listitem").first()).toContainText("Your leaf");
});
