import { getAddress, type Address, type PublicClient } from "viem";

import { one, withTransaction, type Pool } from "../db/pool.ts";
import { accountFactoryAbi, smartAccountAbi } from "../aa/smart-account.ts";
import { AccountNotFound } from "../ledger/errors.ts";
import { runIdempotent } from "../ledger/idempotency.ts";
import { postEntries } from "../ledger/postings.ts";
import { systemAccountId } from "../ledger/system-accounts.ts";
import {
    GraduationInProgress,
    GraduationNotFound,
    GraduationNotOpen,
    NotActivated,
    NothingToGraduate,
} from "./errors.ts";

/**
 * Graduation: moving a user's whole custodial balance to a SmartAccount whose
 * key only they hold.
 *
 * Two steps, with the user's own signature between them. Opening one fixes the
 * account address -- the factory derives it from the owner key -- and registers
 * it with the paymaster, so the user can deploy it without holding ether. Only
 * once it is deployed, and answers to that key, is the balance reserved and
 * handed to the withdrawal worker as a payout to it.
 */

/** Every account is the owner's first: one key, one account, whatever custodial account it came from. */
export const GRADUATION_SALT = 0n;

export type GraduationStatus = "AWAITING_ACTIVATION" | "FUNDING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface Graduation {
    id: bigint;
    accountId: bigint;
    owner: Address;
    smartAccount: Address;
    status: GraduationStatus;
    amount: bigint | null;
    withdrawalId: bigint | null;
    failure: string | null;
}

export interface GraduationConfig {
    factory: Address;
    token: Address;
}

export interface GraduationDeps {
    pool: Pool;
    client: PublicClient;
}

interface GraduationRow {
    id: bigint;
    account_id: bigint;
    owner: string;
    smart_account: string;
    status: GraduationStatus;
    amount: bigint | null;
    withdrawal_id: bigint | null;
    failure: string | null;
}

function toGraduation(row: GraduationRow): Graduation {
    return {
        id: row.id,
        accountId: row.account_id,
        owner: getAddress(row.owner),
        smartAccount: getAddress(row.smart_account),
        status: row.status,
        amount: row.amount,
        withdrawalId: row.withdrawal_id,
        failure: row.failure,
    };
}

export async function getGraduation(pool: Pool, id: bigint): Promise<Graduation> {
    const { rows } = await pool.query<GraduationRow>("SELECT * FROM graduations WHERE id = $1", [id]);
    const row = rows[0];
    if (row === undefined) throw new GraduationNotFound(id);
    return toGraduation(row);
}

function isUniqueViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/**
 * Opens a graduation of `accountId` to the account `owner` controls.
 *
 * Asking again for the same key returns the graduation already open, so a
 * retried request does no harm. Asking for a different key while one is open
 * is refused: the open one must finish or be cancelled first.
 */
export async function openGraduation(
    deps: GraduationDeps,
    config: GraduationConfig,
    params: { accountId: bigint; owner: Address },
): Promise<{ graduation: Graduation; created: boolean }> {
    const { pool, client } = deps;
    const owner = params.owner.toLowerCase();

    const { rows } = await pool.query<{ type: string; balance: bigint }>(
        "SELECT type, balance FROM accounts WHERE id = $1",
        [params.accountId],
    );
    const account = rows[0];
    // A system account has no user to graduate, so it is as good as missing.
    if (account === undefined || account.type !== "USER") throw new AccountNotFound(params.accountId);
    if (account.balance === 0n) throw new NothingToGraduate(params.accountId);

    const smartAccount = (
        await client.readContract({
            address: config.factory,
            abi: accountFactoryAbi,
            functionName: "getAddress",
            args: [params.owner, GRADUATION_SALT],
        })
    ).toLowerCase();

    try {
        const row = await withTransaction(pool, async (tx) => {
            await tx.query(
                `INSERT INTO smart_accounts (address, owner) VALUES ($1, $2)
                 ON CONFLICT (address) DO NOTHING`,
                [smartAccount, owner],
            );
            return one(
                (
                    await tx.query<GraduationRow>(
                        `INSERT INTO graduations (account_id, owner, smart_account)
                         VALUES ($1, $2, $3) RETURNING *`,
                        [params.accountId, owner, smartAccount],
                    )
                ).rows,
                "graduation",
            );
        });
        return { graduation: toGraduation(row), created: true };
    } catch (error) {
        if (!isUniqueViolation(error)) throw error;
    }

    // graduations_one_open_per_account turned the insert away. The open one
    // either is this same request again, or belongs to another key.
    const open = one(
        (
            await pool.query<GraduationRow>(
                `SELECT * FROM graduations
                  WHERE account_id = $1 AND status IN ('AWAITING_ACTIVATION', 'FUNDING')`,
                [params.accountId],
            )
        ).rows,
        "open graduation",
    );
    if (open.owner !== owner) throw new GraduationInProgress(params.accountId, open.id);
    return { graduation: toGraduation(open), created: false };
}

/**
 * Reserves the whole balance and sends it to the activated account.
 *
 * The chain is checked first: there must be code at the address, and it must
 * answer to the key the graduation was opened for. Code at that address can
 * only have come from our factory -- CREATE2 ties the address to its
 * deployer and bytecode -- so it is a SmartAccount, created for that owner.
 * The owner is read anyway: a recovery since then would have handed the
 * account to a different key, and the user should know before money arrives.
 *
 * Safe to call more than once. The ledger movement runs under an idempotency
 * key derived from the graduation, so two calls racing reserve only once, and
 * a call after funding has begun just reports where it stands.
 */
export async function fundGraduation(
    deps: GraduationDeps,
    config: GraduationConfig,
    id: bigint,
): Promise<Graduation> {
    const { pool, client } = deps;
    const graduation = await getGraduation(pool, id);
    if (graduation.status === "CANCELLED") throw new GraduationNotOpen(id, graduation.status);
    if (graduation.status !== "AWAITING_ACTIVATION") return graduation;

    const code = await client.getCode({ address: graduation.smartAccount });
    if (code === undefined || code === "0x") {
        throw new NotActivated(graduation.smartAccount, "nothing is deployed there yet");
    }
    const owner = await client.readContract({
        address: graduation.smartAccount,
        abi: smartAccountAbi,
        functionName: "owner",
    });
    if (owner.toLowerCase() !== graduation.owner.toLowerCase()) {
        throw new NotActivated(graduation.smartAccount, `it answers to ${owner}, not ${graduation.owner}`);
    }

    await runIdempotent(
        pool,
        { key: `graduation-fund:${id}`, kind: "WITHDRAWAL", body: { graduationId: String(id) } },
        async (tx, ledgerTxId) => {
            // Locked so a cancellation cannot slip in between this check and
            // the reservation below.
            const locked = one(
                (
                    await tx.query<{ status: GraduationStatus }>(
                        "SELECT status FROM graduations WHERE id = $1 FOR UPDATE",
                        [id],
                    )
                ).rows,
                "graduation",
            );
            if (locked.status !== "AWAITING_ACTIVATION") throw new GraduationNotOpen(id, locked.status);

            // The balance as it is now, not as it was when the graduation was
            // opened: the user may have received or spent since. Locked, so a
            // transfer cannot land between reading it and reserving it -- and
            // locked together with the reserve, in ascending id like
            // postEntries, so a refund locking both the other way round cannot
            // deadlock against this.
            const reserve = await systemAccountId(tx, "PENDING_WITHDRAWALS");
            const { rows: locks } = await tx.query<{ id: bigint; balance: bigint }>(
                "SELECT id, balance FROM accounts WHERE id IN ($1, $2) ORDER BY id FOR UPDATE",
                [graduation.accountId, reserve],
            );
            const balance = locks.find((row) => row.id === graduation.accountId)?.balance ?? 0n;
            if (balance === 0n) throw new NothingToGraduate(graduation.accountId);

            await postEntries(tx, ledgerTxId, [
                { accountId: graduation.accountId, amount: -balance },
                { accountId: reserve, amount: balance },
            ]);

            const withdrawal = one(
                (
                    await tx.query<{ id: bigint }>(
                        `INSERT INTO chain_withdrawals
                             (kind, account_id, to_address, token_address, amount,
                              status, reserved_transaction_id)
                         VALUES ('GRADUATION', $1, $2, $3, $4, 'PENDING', $5)
                         RETURNING id`,
                        [graduation.accountId, graduation.smartAccount, config.token, balance, ledgerTxId],
                    )
                ).rows,
                "withdrawal",
            );

            await tx.query(
                `UPDATE graduations
                    SET status = 'FUNDING', amount = $2, withdrawal_id = $3, funded_at = now()
                  WHERE id = $1`,
                [id, balance, withdrawal.id],
            );

            return { withdrawalId: String(withdrawal.id) };
        },
    );

    return getGraduation(pool, id);
}

/** Abandons a graduation that has not been funded. Nothing was reserved, so nothing moves. */
export async function cancelGraduation(pool: Pool, id: bigint): Promise<Graduation> {
    const { rows } = await pool.query<GraduationRow>(
        `UPDATE graduations SET status = 'CANCELLED', settled_at = now()
          WHERE id = $1 AND status = 'AWAITING_ACTIVATION'
          RETURNING *`,
        [id],
    );
    if (rows[0] !== undefined) return toGraduation(rows[0]);

    const graduation = await getGraduation(pool, id);
    if (graduation.status === "CANCELLED") return graduation;
    throw new GraduationNotOpen(id, graduation.status);
}
