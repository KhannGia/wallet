import { z } from "zod";

/**
 * Every service reads its configuration through this schema. Failing fast on a
 * malformed environment is deliberate: a wallet that boots with a half-valid
 * config is worse than one that refuses to start.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  RPC_URL: z.string().min(1),

  // Extended PUBLIC key only. loadWatchOnlyKey rejects an xprv, so a
  // misconfiguration here fails at startup rather than quietly giving the API
  // server spending authority over every deposit address.
  WALLET_XPUB: z.string().min(1),
  CHAIN_ID: z.coerce.number().int().positive().default(31337),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // --- Indexer. Unused by the API server, which is why these are optional. ---

  /** The ERC-20 the indexer watches. On a real network, USDC. */
  USDC_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "USDC_ADDRESS must be a 20-byte hex address")
    .optional(),

  /** Where a fresh indexer begins. Never "now": that skips history silently. */
  INDEXER_START_BLOCK: z
    .string()
    .regex(/^\d+$/)
    .default("0")
    .transform((value) => BigInt(value)),

  /**
   * Defaults to the consensus-finalised block, which is the safe answer on a
   * real network. Devnets have no consensus layer -- anvil pins `finalized` to
   * genesis forever -- so they must opt into counting confirmations instead.
   */
  FINALITY_MODE: z.enum(["finalized", "confirmations"]).default("finalized"),
  FINALITY_CONFIRMATIONS: z.coerce.number().int().positive().default(3),

  INDEXER_POLL_MS: z.coerce.number().int().positive().default(4000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // A variable that is simply not set reaches a process as an empty string
  // rather than as absent: `.env` files carry blank placeholders, and Docker
  // Compose turns `${VAR:-}` into "". Left alone, an empty value is validated
  // as if it were a real one, so a blank optional field fails the schema and
  // the service refuses to start -- including the migration runner.
  const provided = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== ""),
  );

  const parsed = envSchema.safeParse(provided);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return parsed.data;
}
