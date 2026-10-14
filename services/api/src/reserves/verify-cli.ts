// Entry point for `./wallet verify-proof <proof.json>`: what a user runs to
// check their balance is inside the total the platform published.
//
// The proof is the response of GET /api/v1/reserves/:id/proof/:accountId,
// saved to a file. Only RPC_URL and RESERVES_REGISTRY_ADDRESS are needed; the
// platform's API is not asked anything.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadEnv } from "@wallet/shared";
import type { Address } from "viem";

import { createChainClient } from "../chain/client.ts";
import { verifyAgainstRegistry } from "./verify.ts";

const env = loadEnv();
const file = process.argv[2];
if (file === undefined || env.RESERVES_REGISTRY_ADDRESS === undefined) {
    console.error("Usage: ./wallet verify-proof <proof.json>, with RESERVES_REGISTRY_ADDRESS set.");
    process.exit(2);
}

// npm runs this from the workspace directory; the path was given relative to
// wherever the user was.
const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
let document: unknown;
try {
    document = JSON.parse(await readFile(path, "utf8"));
} catch (error) {
    console.error(`Cannot read ${path}: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
}

const registry = env.RESERVES_REGISTRY_ADDRESS as Address;
const verdict = await verifyAgainstRegistry(createChainClient(env.RPC_URL), registry, document);

if (!verdict.valid) {
    console.error(`NOT VERIFIED: ${verdict.reason}`);
    process.exit(1);
}

console.log(
    [
        `VERIFIED: account ${verdict.accountId} is owed ${verdict.amount}, inside attestation ${verdict.attestationId}`,
        `  registry     ${registry} (token ${verdict.token})`,
        `  block        ${verdict.blockNumber}`,
        `  liabilities  ${verdict.liabilities}`,
        `  assets       ${verdict.assets}${verdict.assets >= verdict.liabilities ? "" : "  -- SHORT of liabilities"}`,
    ].join("\n"),
);
