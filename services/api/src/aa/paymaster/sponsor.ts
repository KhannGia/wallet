import { numberToHex, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";

import { withTransaction, type Pool } from "../../db/pool.ts";
import { checkCalls, maxCost } from "./policy.ts";
import {
    encodePaymasterData,
    rpcUserOperationSchema,
    sponsorshipTypedData,
    type PricedUserOperation,
} from "./sponsorship.ts";

/** Gas the paymaster's validation is given. It reads immutables and recovers one signature. */
export const PAYMASTER_VERIFICATION_GAS = 100_000n;

/**
 * Stands in for the sponsor's signature while the bundler estimates gas: 65
 * bytes, so validation runs its full length, recovering to nobody.
 */
const STUB_SIGNATURE: Hex =
    "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c";

/** A sponsorship turned down. The reason goes back to the wallet that asked. */
export class SponsorshipRefused extends Error {
    readonly reason: string;
    constructor(reason: string) {
        super(`sponsorship refused: ${reason}`);
        this.name = "SponsorshipRefused";
        this.reason = reason;
    }
}

export interface SponsorConfig {
    paymaster: Address;
    entryPoint: Address;
    chainId: number;
    factory: Address;
    token: Address;
    /** Most wei of gas one account may be promised in a rolling day. */
    dailyCapWei: bigint;
    /** How long a sponsorship stays valid, in seconds of chain time. */
    ttlSeconds: number;
}

/** Records an account as one the platform sponsors. */
export async function registerSmartAccount(
    pool: Pool,
    params: { address: Address; owner: Address },
): Promise<void> {
    await pool.query(
        `INSERT INTO smart_accounts (address, owner) VALUES ($1, $2)
         ON CONFLICT (address) DO NOTHING`,
        [params.address.toLowerCase(), params.owner.toLowerCase()],
    );
}

/**
 * The sponsorship service's two answers, ERC-7677's pm_getPaymasterStubData
 * and pm_getPaymasterData.
 *
 * Both check the same policy -- a known account, only token transfers, and our
 * own factory -- so a wallet hears "no" before the bundler has spent effort
 * estimating. Only the second signs, and only it counts against the daily cap,
 * because only it produces something that can actually be spent.
 */
export function createSponsor(
    deps: { pool: Pool; client: PublicClient; signer: LocalAccount },
    config: SponsorConfig,
) {
    const { pool, client, signer } = deps;

    function parse(rawOp: unknown, entryPoint: unknown, chainId: unknown) {
        if (typeof entryPoint !== "string" || entryPoint.toLowerCase() !== config.entryPoint.toLowerCase()) {
            throw new SponsorshipRefused(`only EntryPoint ${config.entryPoint} is supported`);
        }
        if (typeof chainId !== "string" || BigInt(chainId) !== BigInt(config.chainId)) {
            throw new SponsorshipRefused(`only chain ${config.chainId} is supported`);
        }
        const parsed = rpcUserOperationSchema.safeParse(rawOp);
        if (!parsed.success) {
            throw new SponsorshipRefused(`malformed user operation: ${parsed.error.issues[0]?.message}`);
        }
        return parsed.data;
    }

    async function checkPolicy(op: ReturnType<typeof parse>): Promise<void> {
        const { rows } = await pool.query("SELECT 1 FROM smart_accounts WHERE address = $1", [
            op.sender.toLowerCase(),
        ]);
        if (rows.length === 0) throw new SponsorshipRefused(`${op.sender} is not a registered account`);

        // Deployment is sponsored too, but only through our factory: another
        // factory could deploy code that does anything at the platform's expense.
        if (op.factory && op.factory.toLowerCase() !== config.factory.toLowerCase()) {
            throw new SponsorshipRefused(`factory ${op.factory} is not sponsored`);
        }

        const verdict = checkCalls(op.callData as Hex, config.token);
        if (!verdict.allowed) throw new SponsorshipRefused(verdict.reason);
    }

    return {
        async stubData(rawOp: unknown, entryPoint: unknown, chainId: unknown) {
            const op = parse(rawOp, entryPoint, chainId);
            await checkPolicy(op);
            return {
                paymaster: config.paymaster,
                paymasterData: encodePaymasterData(0, 0, STUB_SIGNATURE),
                paymasterVerificationGasLimit: numberToHex(PAYMASTER_VERIFICATION_GAS),
                paymasterPostOpGasLimit: numberToHex(0n),
                isFinal: false,
            };
        },

        async paymasterData(rawOp: unknown, entryPoint: unknown, chainId: unknown) {
            const op = parse(rawOp, entryPoint, chainId);
            await checkPolicy(op);

            const missing = (
                [
                    "callGasLimit",
                    "verificationGasLimit",
                    "preVerificationGas",
                    "maxFeePerGas",
                    "maxPriorityFeePerGas",
                    "paymasterVerificationGasLimit",
                    "paymasterPostOpGasLimit",
                ] as const
            ).filter((field) => op[field] === undefined);
            if (missing.length > 0) {
                throw new SponsorshipRefused(`gas fields missing: ${missing.join(", ")}`);
            }
            const priced = op as PricedUserOperation;

            // The gas limits the stub handed out are the only ones signed for:
            // more would let validation run up a bill nobody estimated.
            if (priced.paymasterVerificationGasLimit > PAYMASTER_VERIFICATION_GAS || priced.paymasterPostOpGasLimit !== 0n) {
                throw new SponsorshipRefused("paymaster gas limits differ from the ones offered");
            }

            const cost = maxCost(priced);
            const now = Number((await client.getBlock()).timestamp);
            const validUntil = now + config.ttlSeconds;
            const validAfter = 0;

            const signature = await withTransaction(pool, async (tx) => {
                // Serialises requests for one account, so two arriving together
                // cannot both fit under a cap that only one of them fits under.
                await tx.query("SELECT 1 FROM smart_accounts WHERE address = $1 FOR UPDATE", [
                    priced.sender.toLowerCase(),
                ]);

                const { rows } = await tx.query<{ promised: string }>(
                    `SELECT COALESCE(SUM(max_cost), 0)::TEXT AS promised
                       FROM paymaster_sponsorships
                      WHERE sender = $1 AND created_at > now() - interval '1 day'
                        AND user_op_nonce <> $2`,
                    [priced.sender.toLowerCase(), priced.nonce.toString()],
                );
                const promised = BigInt(rows[0]?.promised ?? "0");
                if (promised + cost > config.dailyCapWei) {
                    throw new SponsorshipRefused(
                        `daily gas cap reached: ${promised} wei promised, ${cost} more requested, ` +
                            `cap ${config.dailyCapWei}`,
                    );
                }

                await tx.query(
                    `INSERT INTO paymaster_sponsorships (sender, user_op_nonce, max_cost, valid_until)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (sender, user_op_nonce) DO UPDATE
                        SET max_cost = EXCLUDED.max_cost, valid_until = EXCLUDED.valid_until,
                            created_at = now()`,
                    [priced.sender.toLowerCase(), priced.nonce.toString(), cost.toString(), validUntil],
                );

                return signer.signTypedData(
                    sponsorshipTypedData({
                        op: priced,
                        paymaster: config.paymaster,
                        chainId: config.chainId,
                        validUntil,
                        validAfter,
                    }),
                );
            });

            return {
                paymaster: config.paymaster,
                paymasterData: encodePaymasterData(validUntil, validAfter, signature),
            };
        },
    };
}

export type Sponsor = ReturnType<typeof createSponsor>;
