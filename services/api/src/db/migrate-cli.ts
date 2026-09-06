// Entry point for `./wallet migrate`.
import { loadEnv } from "@wallet/shared";

import { createPool } from "./pool.ts";
import { migrate } from "./migrate.ts";

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);

try {
    const { applied, alreadyApplied } = await migrate(pool);

    for (const version of alreadyApplied) {
        console.log(`  skip    ${version}`);
    }
    for (const version of applied) {
        console.log(`  applied ${version}`);
    }

    console.log(
        applied.length === 0
            ? "Database is up to date."
            : `Applied ${applied.length} migration(s).`,
    );
} finally {
    await pool.end();
}
