import { readFileSync } from "node:fs";

import { expect, type Page } from "@playwright/test";
import { createPublicClient, erc20Abi, http, type Address } from "viem";
import { foundry } from "viem/chains";

/** The demo chain, read directly -- what the tests check the frontend against. */
export const chain = createPublicClient({ chain: foundry, transport: http(process.env.E2E_CHAIN_URL ?? "http://anvil:8545") });

export const PASSWORD = "correct horse battery staple";

/** A fresh user, signed up through the form, landing on their account. */
export async function signUp(page: Page, name: string): Promise<{ email: string; accountId: string }> {
    const email = `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.local`;
    await page.goto("/");
    await page.getByRole("tab", { name: "Open an account" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Open my account" }).click();
    await expect(page.getByTestId("account-id")).toBeVisible();
    return { email, accountId: (await page.getByTestId("account-id").textContent())!.trim() };
}

/** Funds the account through the devnet faucet and waits for the deposit to become spendable. */
export async function deposit100(page: Page, expectedBalance = "100"): Promise<void> {
    await page.goto("/#/");
    await page.getByRole("button", { name: /Devnet faucet/ }).click();
    await expect(page.getByTestId("balance")).toHaveText(expectedBalance, { timeout: 60_000 });
}

export async function tokenBalance(token: Address, holder: Address): Promise<bigint> {
    return chain.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
}

export async function config(page: Page): Promise<{ token: { address: Address } }> {
    return (await page.request.get("/api/v1/config")).json();
}

/** Goes to a page through the main navigation, matching its name exactly ("Account" is not "Smart account"). */
export async function nav(page: Page, name: string): Promise<void> {
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true }).click();
}

/** anvil's accounts 1 to 3: the demo vault's owners. Their keys are in anvil's own banner. */
export const VAULT_OWNER_KEYS = [
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;

/** The demo's admin token, from the configuration its bootstrap wrote. */
export function adminToken(): string {
    const env = readFileSync(new URL("../../.env.demo", import.meta.url), "utf8");
    const token = /^API_ADMIN_TOKEN=(.+)$/m.exec(env)?.[1];
    if (!token) throw new Error("No API_ADMIN_TOKEN in .env.demo: run ./wallet demo up first");
    return token.trim();
}

/** Moves the demo chain's clock forward, past a timelock or a recovery delay. */
export async function advanceTime(seconds: number): Promise<void> {
    await chain.request({ method: "evm_increaseTime", params: [seconds] } as never);
    await chain.request({ method: "evm_mine", params: [] } as never);
}

/** A user who has graduated: signed up, funded, and moved to a smart account, with these guardians. */
export async function graduated(page: Page, name: string, guardians: string[] = [], threshold = 1) {
    const user = await signUp(page, name);
    await deposit100(page);
    await nav(page, "Self-custody");
    await page.getByRole("button", { name: "Make my key" }).click();
    await page.getByRole("button", { name: "I have saved it somewhere safe" }).click();
    await page.getByRole("button", { name: "Start" }).click();
    if (guardians.length > 0) {
        await page.getByLabel(/Guardians/).fill(guardians.join("\n"));
        await page.getByLabel("How many must agree to recover").fill(String(threshold));
    }
    await page.getByRole("button", { name: "Sign and deploy" }).click();
    await page.getByRole("button", { name: "Move my balance" }).click();
    await expect(page.getByTestId("graduated")).toBeVisible();
    return user;
}
