import { expect, test } from "@playwright/test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import { config, deposit100, nav, PASSWORD, signUp, tokenBalance } from "./support.ts";

test("a deposit arrives, waits to be final, then can be spent", async ({ page }) => {
    await signUp(page, "depositor");
    await expect(page.getByTestId("balance")).toHaveText("0");
    await expect(page.getByTestId("deposit-address")).toHaveText(/^0x[0-9a-fA-F]{40}$/);

    await deposit100(page);
    await expect(page.getByTestId("pending")).toHaveText("0");
    await expect(page.locator(".entries li").first()).toContainText("Deposit");
    await expect(page.locator(".entries li").first()).toContainText("+100");
});

test("sends to another user inside the ledger, and pays out on chain", async ({ page, browser }) => {
    // Bob, in a browser of his own.
    const bobPage = await (await browser.newContext()).newPage();
    const bob = await signUp(bobPage, "bob");

    await signUp(page, "alice");
    await deposit100(page);

    await nav(page, "Send");
    await page.getByLabel("Recipient's account number").fill(bob.accountId);
    await page.getByLabel("Amount").fill("25.5");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(`Sent 25.5 to account ${bob.accountId}`);

    await bobPage.reload();
    await expect(bobPage.getByTestId("balance")).toHaveText("25.5");
    await expect(bobPage.locator(".entries li").first()).toContainText("Transfer");

    // Out of custody, to an address nobody has used.
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    await page.getByRole("tab", { name: "On chain" }).click();
    await page.getByLabel("Recipient address").fill(recipient);
    await page.getByLabel("Amount").fill("10");
    await page.getByRole("button", { name: "Pay out" }).click();
    await expect(page.getByRole("status")).toContainText("accepted");

    await nav(page, "Account");
    await expect(page.getByTestId("balance")).toHaveText("64.5");
    // Set aside, then gone once the worker settles it on chain.
    await expect(page.getByTestId("reserved")).toHaveText("0", { timeout: 60_000 });
    await expect(page.locator(".entries li").filter({ hasText: "Payout" })).toHaveCount(1);
    const { token } = await config(page);
    expect(await tokenBalance(token.address, recipient)).toBe(10_000_000n);
});

test("refuses a wrong password, and spending more than is there", async ({ page }) => {
    const { email } = await signUp(page, "careful");
    await page.getByRole("button", { name: "Sign out" }).click();

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("not the password at all");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("Email or password is wrong");

    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("balance")).toHaveText("0");

    await nav(page, "Send");
    const friend = await signUp(await (await page.context().browser()!.newContext()).newPage(), "friend");
    await page.getByLabel("Recipient's account number").fill(friend.accountId);
    await page.getByLabel("Amount").fill("5");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Not enough available balance");
});
