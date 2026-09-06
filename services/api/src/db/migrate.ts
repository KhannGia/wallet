import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";

import { withTransaction } from "./pool.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));

// Any constant works; it just has to be the same in every process so two
// containers starting at once cannot run the same migration twice.
const ADVISORY_LOCK_KEY = 4_827_310_915_744_001n;

export interface MigrationResult {
    applied: string[];
    alreadyApplied: string[];
}

async function listMigrationFiles(): Promise<string[]> {
    const files = await readdir(MIGRATIONS_DIR);
    // Lexicographic order is the execution order, which is why files are
    // numbered 0001, 0002, ... rather than named freely.
    return files.filter((name) => name.endsWith(".sql")).sort();
}

/**
 * Applies every migration that has not run yet.
 *
 * Safe to call on every boot: it reads which versions are already recorded and
 * skips them, so running it against an up-to-date database does nothing.
 *
 * A migration that has already been applied must never be edited. This process
 * would skip it while a fresh database would run the edited version, leaving
 * two schemas that differ with nothing to reveal it. Write a new file instead.
 */
export async function migrate(pool: Pool): Promise<MigrationResult> {
    const client = await pool.connect();

    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version    TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        // Session-scoped lock: a second process blocks here until the first is
        // finished, instead of both trying to create the same tables.
        await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);

        try {
            const { rows } = await client.query<{ version: string }>(
                "SELECT version FROM schema_migrations",
            );
            const done = new Set(rows.map((row) => row.version));

            const applied: string[] = [];
            const alreadyApplied: string[] = [];

            for (const file of await listMigrationFiles()) {
                const version = file.replace(/\.sql$/, "");

                if (done.has(version)) {
                    alreadyApplied.push(version);
                    continue;
                }

                const sql = await readFile(MIGRATIONS_DIR + file, "utf8");

                // One transaction per migration: a failure halfway through
                // rolls the whole file back rather than leaving a partial
                // schema that no later run knows how to repair.
                await withTransaction(pool, async (tx) => {
                    await tx.query(sql);
                    await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
                        version,
                    ]);
                });

                applied.push(version);
            }

            return { applied, alreadyApplied };
        } finally {
            await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
        }
    } finally {
        client.release();
    }
}
