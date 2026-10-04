import { z } from "zod";

/**
 * Every service reads its configuration through this schema. Failing fast on a
 * malformed environment is deliberate: a wallet that boots with a half-valid
 * config is worse than one that refuses to start.
 */
/** A token amount in minor units, as a decimal string. */
const tokenAmount = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer in the token's minor units")
  .transform((value) => BigInt(value));

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

  // --- Withdrawal worker. The only component that holds a spending key. ---

  /**
   * Signs outgoing transfers. Development only: in production this belongs in
   * a KMS or HSM, and the worker asks that service to sign rather than holding
   * the key in its own memory.
   */
  HOT_WALLET_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "HOT_WALLET_PRIVATE_KEY must be a 32-byte hex key")
    .optional(),

  /** A transaction unmined for this long is resent at a higher fee. */
  STUCK_AFTER_MS: z.coerce.number().int().positive().default(60_000),

  /** Nodes require at least 10%; a little above avoids rounding rejections. */
  FEE_BUMP_PERCENT: z.coerce.number().int().min(10).default(12),

  /** Failed broadcasts before a withdrawal is abandoned and its nonce freed. */
  MAX_BROADCAST_ATTEMPTS: z.coerce.number().int().positive().default(3),

  WITHDRAWAL_POLL_MS: z.coerce.number().int().positive().default(4000),

  // --- Sweeper. Holds the mnemonic, so it runs nowhere near the API. ---

  /**
   * Derives the keys for deposit addresses. Development only: in production
   * the sweeper asks a KMS to sign, and this never exists as a string.
   */
  WALLET_MNEMONIC: z.string().min(1).optional(),

  /** Below this token balance an address is left alone; sweeping it costs more. */
  MIN_SWEEP_BALANCE: z
    .string()
    .regex(/^\d+$/)
    .default("1000000")
    .transform((value) => BigInt(value)),

  /**
   * Sends that native currency. Its own account, never the hot wallet's: the
   * withdrawal worker allocates the hot wallet's nonces in the database, and a
   * second process sending from it would take nonces payouts were promised.
   * It also keeps the sweeper from holding a key that can spend the hot
   * wallet's tokens, when all it ever needs to send is a little gas.
   */
  GAS_FUNDER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "GAS_FUNDER_PRIVATE_KEY must be a 32-byte hex key")
    .optional(),

  /** Native currency sent to an address that cannot pay for its own transfer. */
  SWEEP_GAS_FUNDING_WEI: z
    .string()
    .regex(/^\d+$/)
    .default("2000000000000000")
    .transform((value) => BigInt(value)),

  SWEEP_POLL_MS: z.coerce.number().int().positive().default(15_000),

  // --- Vault. Proposals are served by the API; submission is a separate worker. ---

  /** The multisig holding cold reserves. Without it, the proposal API answers 503. */
  VAULT_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "VAULT_ADDRESS must be a 20-byte hex address")
    .optional(),

  /**
   * Pays gas to submit a proposal that has its quorum. It authorises nothing:
   * the owners' signatures do that, and the vault checks them. It must still
   * not be the hot wallet's key -- the withdrawal worker allocates that
   * account's nonces in the database, and a second process sending from it
   * would collide with them.
   */
  VAULT_SUBMITTER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "VAULT_SUBMITTER_PRIVATE_KEY must be a 32-byte hex key")
    .optional(),

  VAULT_SUBMIT_POLL_MS: z.coerce.number().int().positive().default(5_000),

  // --- Rebalancing. All three marks, or none: without them it stays off. ---

  /** Below this available hot balance, a top-up from the vault is proposed. */
  REBALANCE_LOW: tokenAmount.optional(),
  /** Where a rebalance in either direction brings the hot balance. */
  REBALANCE_TARGET: tokenAmount.optional(),
  /** Above this, the excess goes back to the vault. */
  REBALANCE_HIGH: tokenAmount.optional(),

  /** How long owners have to sign an automatic top-up. */
  REBALANCE_PROPOSAL_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
}).superRefine((env, ctx) => {
  const marks = [env.REBALANCE_LOW, env.REBALANCE_TARGET, env.REBALANCE_HIGH];
  const set = marks.filter((mark) => mark !== undefined).length;

  if (set !== 0 && set !== 3) {
    ctx.addIssue({
      code: "custom",
      path: ["REBALANCE_LOW"],
      message: "set REBALANCE_LOW, REBALANCE_TARGET and REBALANCE_HIGH together, or none",
    });
    return;
  }

  // Two separate thresholds, not one: a balance hovering around a single line
  // would trigger a rebalance on every pass, and each one costs gas or an
  // owner's signature.
  const [low, target, high] = marks;
  if (low !== undefined && target !== undefined && high !== undefined) {
    if (!(low < target && target < high)) {
      ctx.addIssue({
        code: "custom",
        path: ["REBALANCE_TARGET"],
        message: "rebalancing needs REBALANCE_LOW < REBALANCE_TARGET < REBALANCE_HIGH",
      });
    }
  }
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
