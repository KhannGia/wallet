import { erc20Abi, getAddress, type Address, type Hash, type PublicClient } from "viem";

import { one, type Pool, type PoolClient } from "../db/pool.ts";
import { receiptMovedTokens } from "../chain/receipts.ts";

/**
 * Proof of reserves, the first half: does the platform hold on chain at least
 * what it owes?
 *
 *   assets       token balance of every address the platform controls --
 *                hot wallets, the vault, and every deposit address, since a
 *                credited deposit sits there until it is swept
 *   liabilities  per user: their balance, their deposits seen but not yet
 *                final, and their payouts (graduations included) not yet on
 *                chain
 *
 * Both are read at one block, and that is the whole difficulty. Money moving
 * between the platform's own addresses -- a sweep, a rebalance -- changes
 * nothing as long as every balance is read at the same height. Money crossing
 * the boundary must be counted on exactly one side:
 *
 * - The block is the indexer's cursor, read in the same database snapshot as
 *   the ledger. Every deposit the ledger knows about arrived at or before it,
 *   so the tokens behind every deposit counted as owed are in the balances.
 *   (The indexer records a range's deposits before advancing the cursor past
 *   them; any it has recorded beyond the cursor are left out of both sides.)
 * - A payout mined at or before the block but not yet settled in the ledger
 *   has already left the hot wallet, so it is no longer owed. A payout mined
 *   after it is still owed, and its tokens are still in the balances.
 *
 * What remains can only err towards a surplus -- a deposit not yet indexed, a
 * payout the ledger settled after the block -- never towards a shortfall that
 * is not real.
 */

export interface ReservesConfig {
    token: Address;
    /** Optional: without a vault, reserves are the hot wallets and deposit addresses alone. */
    vault?: Address;
    /** The indexer scanner whose cursor fixes the block. */
    scannerId: string;
}

export interface Holding {
    address: Address;
    balance: bigint;
}

export interface ReservesReport {
    token: Address;
    blockNumber: bigint;
    assets: {
        hotWallets: Holding[];
        vault: Holding | null;
        /** Summed: there is one per user, and none of them is interesting alone. */
        depositAddresses: bigint;
        total: bigint;
    };
    liabilities: {
        /** What each user account is owed, every user account included. */
        accounts: { accountId: bigint; amount: bigint }[];
        /** Payouts already mined by the block but not yet settled in the ledger. */
        minedNotSettled: bigint;
        total: bigint;
    };
    /** Assets minus liabilities. Negative is a shortfall. */
    surplus: bigint;
    solvent: boolean;
}

interface LedgerView {
    blockNumber: bigint | null;
    owed: Map<bigint, bigint>;
    inFlight: { accountId: bigint; hash: Hash; to: string; amount: bigint }[];
    hotWallets: Address[];
    depositAddresses: Address[];
}

/**
 * Everything the ledger says, read in one REPEATABLE READ transaction so no
 * deposit, payout or settlement can land between two of the queries.
 */
async function readLedger(pool: Pool, scannerId: string): Promise<LedgerView> {
    const client: PoolClient = await pool.connect();
    try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

        const cursor = await client.query<{ last_scanned_block: bigint }>(
            "SELECT last_scanned_block FROM indexer_state WHERE id = $1",
            [scannerId],
        );
        // No cursor means the indexer has never run, so no deposit has been
        // recorded and any block will do; the caller picks the head.
        const blockNumber = cursor.rows[0]?.last_scanned_block ?? null;

        const { rows: owedRows } = await client.query<{ id: bigint; owed: string }>(
            `SELECT a.id,
                    a.balance
                    + COALESCE((SELECT SUM(d.amount) FROM chain_deposits d
                                 WHERE d.account_id = a.id AND d.status = 'PENDING'
                                   AND ($1::BIGINT IS NULL OR d.block_number <= $1)), 0)
                    + COALESCE((SELECT SUM(w.amount) FROM chain_withdrawals w
                                 WHERE w.account_id = a.id AND w.kind <> 'REBALANCE'
                                   AND w.status IN ('PENDING', 'SUBMITTED')), 0) AS owed
               FROM accounts a
              WHERE a.type = 'USER'
              ORDER BY a.id`,
            [blockNumber],
        );

        const { rows: flightRows } = await client.query<{
            account_id: bigint;
            transaction_hash: string;
            to_address: string;
            amount: bigint;
        }>(
            `SELECT account_id, transaction_hash, to_address, amount
               FROM chain_withdrawals
              WHERE kind <> 'REBALANCE' AND status = 'SUBMITTED' AND transaction_hash IS NOT NULL`,
        );

        const { rows: hotRows } = await client.query<{ address: string }>(
            "SELECT address FROM hot_wallets ORDER BY id",
        );
        const { rows: depositRows } = await client.query<{ deposit_address: string }>(
            `SELECT deposit_address FROM accounts
              WHERE type = 'USER' AND deposit_address IS NOT NULL ORDER BY id`,
        );

        await client.query("COMMIT");

        return {
            blockNumber,
            owed: new Map(owedRows.map((row) => [row.id, BigInt(row.owed)])),
            inFlight: flightRows.map((row) => ({
                accountId: row.account_id,
                hash: row.transaction_hash as Hash,
                to: row.to_address,
                amount: row.amount,
            })),
            hotWallets: hotRows.map((row) => getAddress(row.address)),
            depositAddresses: depositRows.map((row) => getAddress(row.deposit_address)),
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

/** At most this many balance reads in flight at once, so a large user base does not flood the node. */
const READ_CONCURRENCY = 32;

async function balancesAt(
    client: PublicClient,
    token: Address,
    addresses: Address[],
    blockNumber: bigint,
): Promise<Map<string, bigint>> {
    const balances = new Map<string, bigint>();
    for (let start = 0; start < addresses.length; start += READ_CONCURRENCY) {
        const batch = addresses.slice(start, start + READ_CONCURRENCY);
        const read = await Promise.all(
            batch.map((address) =>
                client.readContract({
                    address: token,
                    abi: erc20Abi,
                    functionName: "balanceOf",
                    args: [address],
                    blockNumber,
                }),
            ),
        );
        batch.forEach((address, index) => balances.set(address.toLowerCase(), read[index] ?? 0n));
    }
    return balances;
}

/** Whether a payout's transfer is on chain by `blockNumber`, tokens moved. */
async function minedBy(
    client: PublicClient,
    token: Address,
    payout: { hash: Hash; to: string; amount: bigint },
    blockNumber: bigint,
): Promise<boolean> {
    let receipt;
    try {
        receipt = await client.getTransactionReceipt({ hash: payout.hash });
    } catch {
        // Not mined -- or mined under a replacement's hash, which the ledger
        // has not caught up with. Counting it as still owed is the cautious
        // side: at worst a shortfall that clears once the worker settles.
        return false;
    }
    return (
        receipt.blockNumber <= blockNumber &&
        receipt.status === "success" &&
        receiptMovedTokens(receipt, { token, to: payout.to, amount: payout.amount })
    );
}

export async function computeReserves(
    deps: { pool: Pool; client: PublicClient },
    config: ReservesConfig,
): Promise<ReservesReport> {
    const { pool, client } = deps;
    const ledger = await readLedger(pool, config.scannerId);
    const blockNumber = ledger.blockNumber ?? (await client.getBlockNumber());

    // Each address counted once, whatever roles it plays: an address that is
    // both a hot wallet and a deposit address holds one balance, not two.
    const vault = config.vault === undefined ? null : getAddress(config.vault);
    const addresses = [
        ...new Map(
            [...ledger.hotWallets, ...(vault === null ? [] : [vault]), ...ledger.depositAddresses].map((a) => [
                a.toLowerCase(),
                a,
            ]),
        ).values(),
    ];
    const balances = await balancesAt(client, config.token, addresses, blockNumber);
    const counted = new Set<string>();
    const take = (address: Address): bigint => {
        const key = address.toLowerCase();
        if (counted.has(key)) return 0n;
        counted.add(key);
        return balances.get(key) ?? 0n;
    };

    const hotWallets = ledger.hotWallets.map((address) => ({ address, balance: take(address) }));
    const vaultHolding = vault === null ? null : { address: vault, balance: take(vault) };
    const depositAddresses = ledger.depositAddresses.reduce((sum, address) => sum + take(address), 0n);
    const assets =
        hotWallets.reduce((sum, holding) => sum + holding.balance, 0n) + (vaultHolding?.balance ?? 0n) + depositAddresses;

    const owed = new Map(ledger.owed);
    let minedNotSettled = 0n;
    for (const payout of ledger.inFlight) {
        if (await minedBy(client, config.token, payout, blockNumber)) {
            minedNotSettled += payout.amount;
            owed.set(payout.accountId, (owed.get(payout.accountId) ?? 0n) - payout.amount);
        }
    }
    const accounts = [...owed].map(([accountId, amount]) => ({ accountId, amount }));
    const liabilities = accounts.reduce((sum, account) => sum + account.amount, 0n);

    return {
        token: getAddress(config.token),
        blockNumber,
        assets: { hotWallets, vault: vaultHolding, depositAddresses, total: assets },
        liabilities: { accounts, minedNotSettled, total: liabilities },
        surplus: assets - liabilities,
        solvent: assets >= liabilities,
    };
}

export interface ReservesSnapshot {
    id: bigint;
    report: ReservesReport;
}

/** Computes the reserves and records them, with what each account was owed. */
export async function takeReservesSnapshot(
    deps: { pool: Pool; client: PublicClient },
    config: ReservesConfig,
): Promise<ReservesSnapshot> {
    const report = await computeReserves(deps, config);
    const detail = {
        hotWallets: report.assets.hotWallets.map((h) => ({ address: h.address, balance: String(h.balance) })),
        vault: report.assets.vault && { address: report.assets.vault.address, balance: String(report.assets.vault.balance) },
        depositAddresses: String(report.assets.depositAddresses),
        minedNotSettled: String(report.liabilities.minedNotSettled),
    };

    const client = await deps.pool.connect();
    try {
        await client.query("BEGIN");
        const { id } = one(
            (
                await client.query<{ id: bigint }>(
                    `INSERT INTO reserve_snapshots (token_address, block_number, assets, liabilities, detail)
                     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                    [report.token, report.blockNumber, report.assets.total, report.liabilities.total, detail],
                )
            ).rows,
            "snapshot",
        );
        if (report.liabilities.accounts.length > 0) {
            await client.query(
                `INSERT INTO reserve_liabilities (snapshot_id, account_id, amount)
                 SELECT $1, * FROM unnest($2::BIGINT[], $3::NUMERIC[])`,
                [
                    id,
                    report.liabilities.accounts.map((a) => a.accountId),
                    report.liabilities.accounts.map((a) => a.amount.toString()),
                ],
            );
        }
        await client.query("COMMIT");
        return { id, report };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export interface StoredSnapshot {
    id: bigint;
    token: Address;
    blockNumber: bigint;
    assets: bigint;
    liabilities: bigint;
    surplus: bigint;
    solvent: boolean;
    detail: unknown;
    createdAt: Date;
}

export async function latestReservesSnapshot(pool: Pool): Promise<StoredSnapshot | null> {
    const { rows } = await pool.query<{
        id: bigint;
        token_address: string;
        block_number: bigint;
        assets: string;
        liabilities: string;
        detail: unknown;
        created_at: Date;
    }>("SELECT * FROM reserve_snapshots ORDER BY id DESC LIMIT 1");
    const row = rows[0];
    if (row === undefined) return null;
    const assets = BigInt(row.assets);
    const liabilities = BigInt(row.liabilities);
    return {
        id: row.id,
        token: getAddress(row.token_address),
        blockNumber: row.block_number,
        assets,
        liabilities,
        surplus: assets - liabilities,
        solvent: assets >= liabilities,
        detail: row.detail,
        createdAt: row.created_at,
    };
}
