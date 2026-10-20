# P4 — Reorgs and finality

**Reorgs are induced, not simulated.** `anvil_reorg` rewrites real blocks, so
the tests exercise the same conditions a live chain produces: a height keeps its
number and receives a new hash. Removing the hash comparison from the detector
and leaving a height check in its place fails two of these tests every run.

**Block data must not be cached.** viem holds block reads for its polling
interval by default. That is a good default and precisely wrong here: after a
reorg the cache keeps serving the old hash, so the check compares a stale hash
against itself and concludes nothing changed -- silently leaving deposits from a
replaced block credited forever. `createChainClient` sets `cacheTime: 0` for
every service, and the tests use that same constructor so they cannot pass
against a client configured differently from production.

**Detection reports; reversal acts.** They are separate functions so detection
can be exercised on its own and a bug in reporting cannot move money by itself.

**Reversal takes nothing from anyone.** A reorged deposit is still parked in
`PENDING_DEPOSITS`, so returning it to the gateway touches no user account. This
is the payoff of the two-step deposit introduced in P3.

**A confirmed deposit is not clawed back automatically, and that is deliberate.**
Its funds are in a user account and may already be spent, so an automated
reversal would either fail or push a real person negative. The indexer reports
it for manual review on every pass instead. It should also never happen:
confirmation waits for finality, and a finalised block being replaced means
something far worse than routine churn.

**The cursor rewinds, which is why `advanceCursor` refuses to.** Rewinding is
correct in exactly one situation, so it is a separate, explicitly named
operation that a stale scan result cannot trigger by accident.

**Reconciliation checks where the money is, not just that it sums to zero.** A
reversal that marks a deposit reorged but forgets to move the funds leaves the
total at zero and every cached balance accurate, while the amount stranded in
the system account quietly grows. So reconciliation also asserts that
`PENDING_DEPOSITS` holds exactly what the still-pending deposits are owed --
an invariant that catches a class of bug the first two checks are blind to.

---

[All phases](README.md) · [Project README](../../README.md)
