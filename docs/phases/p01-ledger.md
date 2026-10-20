# P1 — The double-entry ledger

**Double-entry.** Money never changes, it only moves. Every transaction writes at
least two entries summing to zero, so `SUM(amount)` across the entire ledger is
always zero. `postEntries` is the single door money passes through, and it
rejects any set of postings that does not balance.

**Row-level locking.** `services/api/src/ledger/postings.ts` locks accounts with
`SELECT ... FOR UPDATE` in ascending id order. The ordering is what prevents a
deadlock when A pays B while B pays A.

**Idempotency.** Retrying a request with the same `Idempotency-Key` returns the
stored result instead of moving money twice. Correctness comes from the `UNIQUE`
constraint on `transactions.idempotency_key`, not from checking whether the key
exists first -- that check would itself be racy.

**Tests that would fail if the locking were removed.** In
`ledger/concurrency.test.ts`, the interleaving test drives two transactions by
hand and waits on `pg_stat_activity` until the second is provably parked on a
lock before committing the first. Removing `FOR UPDATE` fails it every run. The
20-parallel-withdrawal test is kept as the headline acceptance check, but it is
timing-dependent and can pass even against broken code -- which is exactly why
the deterministic one exists.

---

[All phases](README.md) · [Project README](../../README.md)
