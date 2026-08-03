import { z } from "zod";

/**
 * Every service reads its configuration through this schema. Failing fast on a
 * malformed environment is deliberate: a wallet that boots with a half-valid
 * config is worse than one that refuses to start.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  RPC_URL: z.string().min(1),
  CHAIN_ID: z.coerce.number().int().positive().default(31337),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return parsed.data;
}
