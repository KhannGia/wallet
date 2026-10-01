import { getAddress, isAddress } from "viem";
import { z } from "zod";

/**
 * Amounts arrive as decimal strings, never JSON numbers: a JSON number is an
 * IEEE-754 double and loses precision above 2^53, which would corrupt a
 * balance silently rather than loudly.
 */
export const amountSchema = z
    .string()
    .regex(/^[1-9][0-9]*$/, "amount must be a positive integer in minor units")
    .transform((value) => BigInt(value));

export const accountIdSchema = z
    .string()
    .regex(/^[1-9][0-9]*$/, "account id must be a positive integer")
    .transform((value) => BigInt(value));

export const createUserSchema = z.object({
    email: z.string().email(),
});

export const depositSchema = z.object({
    accountId: accountIdSchema,
    amount: amountSchema,
});

export const withdrawalSchema = depositSchema;

export const transferSchema = z.object({
    fromAccountId: accountIdSchema,
    toAccountId: accountIdSchema,
    amount: amountSchema,
});

export const entriesQuerySchema = z.object({
    cursor: accountIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Validates and checksums a destination address.
 *
 * A hex-shaped string is not enough. viem refuses a mixed-case address whose
 * EIP-55 checksum does not match, and it refuses it at signing time -- deep
 * inside the withdrawal worker, after a nonce has already been committed to the
 * row. That transaction can then never be broadcast, and every later nonce
 * queues behind it forever.
 *
 * Rejecting it here costs the caller a 400 and costs the queue nothing.
 */
export const addressSchema = z
    .string()
    .refine((value) => isAddress(value, { strict: false }), "must be a 20-byte hex address")
    .refine(
        (value) => !/[A-F]/.test(value) || isAddress(value),
        "address has an invalid EIP-55 checksum",
    )
    .transform((value) => getAddress(value));

export const payoutSchema = z.object({
    accountId: accountIdSchema,
    to: addressSchema,
    amount: amountSchema,
});

export const proposalIdSchema = z
    .string()
    .regex(/^[1-9][0-9]*$/, "proposal id must be a positive integer")
    .transform((value) => BigInt(value));

const MAX_UINT256 = 2n ** 256n - 1n;

/** A uint256 as a decimal string. Zero is allowed: a contract call may send no value. */
const uint256Schema = z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/, "must be a non-negative integer as a decimal string")
    .transform((value) => BigInt(value))
    .refine((value) => value <= MAX_UINT256, "must fit in a uint256");

export const createProposalSchema = z.object({
    to: addressSchema,
    /** Wei. */
    value: uint256Schema,
    /** Calldata for the target; "0x" for a plain transfer of native currency. */
    data: z
        .string()
        .regex(/^0x([0-9a-fA-F]{2})*$/, "data must be whole bytes of 0x-prefixed hex")
        .default("0x")
        .transform((value) => value.toLowerCase() as `0x${string}`),
    /** Unix seconds, compared against chain time rather than the server's clock. */
    deadline: uint256Schema,
});

export const signatureSchema = z.object({
    signature: z.string().regex(/^0x[0-9a-fA-F]*$/, "signature must be 0x-prefixed hex"),
});
