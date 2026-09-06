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
