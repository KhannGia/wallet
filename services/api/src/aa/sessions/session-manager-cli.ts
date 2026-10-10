// Entry point for `./wallet session-manager`: holds session keys for apps and
// bots, and spends with them on request, within each session's limits.
//
// It holds keys -- sealed at rest, but keys -- so it runs as its own process,
// apart from the API, behind its own bearer token.
import { loadEnv } from "@wallet/shared";
import { http, type Address } from "viem";
import { createBundlerClient, createPaymasterClient } from "viem/account-abstraction";

import { createChainClient } from "../../chain/client.ts";
import { createPool } from "../../db/pool.ts";
import { parseMasterKey } from "./crypto.ts";
import { createSessionManager } from "./manager.ts";
import { buildSessionServer } from "./server.ts";

const env = loadEnv();

const missing = [
    ["SESSION_ENCRYPTION_KEY", env.SESSION_ENCRYPTION_KEY],
    ["SESSION_MANAGER_TOKEN", env.SESSION_MANAGER_TOKEN],
    ["ACCOUNT_FACTORY_ADDRESS", env.ACCOUNT_FACTORY_ADDRESS],
    ["BUNDLER_URL", env.BUNDLER_URL],
]
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
if (missing.length > 0) {
    console.error(
        `The session manager needs ${missing.join(", ")}.\n` +
            "Generate the key and token with: openssl rand -hex 32",
    );
    process.exit(1);
}

const client = createChainClient(env.RPC_URL);
const pool = createPool(env.DATABASE_URL);
const manager = createSessionManager(
    {
        pool,
        client,
        bundler: createBundlerClient({ client, transport: http(env.BUNDLER_URL) }),
        ...(env.PAYMASTER_URL ? { paymaster: createPaymasterClient({ transport: http(env.PAYMASTER_URL) }) } : {}),
    },
    {
        masterKey: parseMasterKey(env.SESSION_ENCRYPTION_KEY!),
        keyVersion: env.SESSION_KEY_VERSION,
        factory: env.ACCOUNT_FACTORY_ADDRESS as Address,
    },
);

const app = buildSessionServer(manager, env.SESSION_MANAGER_TOKEN!, env.LOG_LEVEL);
await app.listen({ host: "0.0.0.0", port: env.SESSION_MANAGER_PORT });
console.log(`session manager on :${env.SESSION_MANAGER_PORT}${env.PAYMASTER_URL ? ", sponsoring through the paymaster" : ""}`);

// Expired sessions lose their keys on a timer, not only when next used.
const purge = setInterval(() => {
    manager
        .purgeExpired()
        .then((count) => count > 0 && console.log(`shredded ${count} expired session key(s)`))
        .catch((error) => console.error("purge failed:", error instanceof Error ? error.message : error));
}, 60_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        void (async () => {
            clearInterval(purge);
            await app.close();
            await pool.end();
            process.exit(0);
        })();
    });
}
