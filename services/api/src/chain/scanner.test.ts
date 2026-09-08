import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveDepositAddress, loadEnv } from "@wallet/shared";
import type { Address } from "viem";

import { chainHarness, deployMockUsdc, mintTo, type ChainHarness } from "../test-support/chain.ts";
import { TEST_XPUB } from "../test-support/db.ts";
import { fetchIncomingTransfers } from "./scanner.ts";

describe("chain scanner", () => {
    let harness: ChainHarness;
    let token: Address;

    // Deposit addresses belonging to three different users.
    const watched: Address[] = [0, 1, 2].map((i) => deriveDepositAddress(TEST_XPUB, i));
    const unwatched = deriveDepositAddress(TEST_XPUB, 99);

    let firstBlock: bigint;
    let lastBlock: bigint;

    before(async () => {
        const env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        harness = chainHarness(env.RPC_URL);
        token = await deployMockUsdc(harness);

        // Three deposits to watched addresses, plus one to an address this
        // wallet does not own.
        firstBlock = await mintTo(harness, token, watched[0]!, 1_000_000n);
        await mintTo(harness, token, watched[1]!, 2_500_000n);
        await mintTo(harness, token, unwatched, 9_999_999n);
        lastBlock = await mintTo(harness, token, watched[2]!, 3_000_000n);
    });

    after(() => {
        // Nothing to tear down: anvil state is discarded with the container.
    });

    it("finds transfers into watched addresses", async () => {
        const transfers = await fetchIncomingTransfers({
            client: harness.publicClient,
            token,
            toAddresses: watched,
            range: { fromBlock: firstBlock, toBlock: lastBlock },
        });

        assert.equal(transfers.length, 3);
        assert.deepEqual(
            transfers.map((t) => t.value),
            [1_000_000n, 2_500_000n, 3_000_000n],
        );
    });

    it("ignores transfers to addresses this wallet does not own", async () => {
        const transfers = await fetchIncomingTransfers({
            client: harness.publicClient,
            token,
            toAddresses: watched,
            range: { fromBlock: firstBlock, toBlock: lastBlock },
        });

        assert.equal(
            transfers.some((t) => t.to.toLowerCase() === unwatched.toLowerCase()),
            false,
            "a transfer to an unwatched address must never be returned",
        );
    });

    it("carries the identity a credit and a later reorg both need", async () => {
        const [transfer] = await fetchIncomingTransfers({
            client: harness.publicClient,
            token,
            toAddresses: [watched[0]!],
            range: { fromBlock: firstBlock, toBlock: lastBlock },
        });

        assert.ok(transfer);
        assert.match(transfer.transactionHash, /^0x[0-9a-f]{64}$/);
        assert.match(transfer.blockHash, /^0x[0-9a-f]{64}$/);
        assert.equal(typeof transfer.logIndex, "number");
        assert.equal(transfer.blockNumber, firstBlock);
    });

    it("returns the same set whether scanned in one call or many chunks", async () => {
        const range = { fromBlock: firstBlock, toBlock: lastBlock };
        const common = { client: harness.publicClient, token, toAddresses: watched };

        const wholeRange = await fetchIncomingTransfers({ ...common, range });
        // A chunk size of one block forces a separate eth_getLogs per block.
        const chunked = await fetchIncomingTransfers({ ...common, range, chunkSize: 1n });

        assert.deepEqual(
            chunked.map((t) => `${t.transactionHash}:${t.logIndex}`),
            wholeRange.map((t) => `${t.transactionHash}:${t.logIndex}`),
        );
    });

    it("returns nothing when no addresses are watched", async () => {
        // An empty topic filter matches every transfer rather than none, so
        // this case is short-circuited before it reaches the node. Without
        // that, a wallet with no accounts would ingest the entire token's
        // traffic.
        const transfers = await fetchIncomingTransfers({
            client: harness.publicClient,
            token,
            toAddresses: [],
            range: { fromBlock: firstBlock, toBlock: lastBlock },
        });

        assert.deepEqual(transfers, []);
    });

    it("rejects an inverted range instead of silently scanning nothing", async () => {
        await assert.rejects(
            fetchIncomingTransfers({
                client: harness.publicClient,
                token,
                toAddresses: watched,
                range: { fromBlock: lastBlock, toBlock: firstBlock },
            }),
            /Empty range/,
        );
    });
});
