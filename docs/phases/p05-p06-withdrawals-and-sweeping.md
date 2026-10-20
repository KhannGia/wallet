# P5 & P6 — Withdrawals, nonces and sweeping

**Deciding and acting are separate.** The planner reads balances and returns a
verdict per address. Nothing signs, so the decision can be inspected -- and got
wrong -- without moving anyone's funds.

**Sweeping dust destroys value.** An ERC-20 transfer costs gas whether it moves
a million tokens or five, so below a threshold the tokens are better left where
they are. Judging that properly means comparing a token amount against a
native-currency cost, which needs a price feed this project does not have; the
threshold is the honest stand-in, and the estimate is reported so an operator
can revisit it.

**A deposit address cannot pay its own way.** It receives tokens and nothing
else, so it holds no native currency and the sweep costs two transactions: fund
it, then transfer. The estimate says which case an address is in.

**Tests get their own derivation range.** The chain outlives the database, so a
test that funds an address leaves it funded for every later run. A fixed index
made the suite pass once and fail from the second run onward, which is how this
was found.

**The sweeper holds the mnemonic, so it runs nowhere near the API.** Moving
funds that have arrived at a deposit address requires the key for that address,
which means the phrase every deposit address is derived from. That is the most
dangerous secret in the system, so it lives in its own process -- the API server
still holds nothing that can spend.

**Every signing process has its own account.** The sweeper first paid gas
from the hot wallet, letting the node pick the nonce, while the withdrawal
worker handed out the same account's nonces from the database. Running both,
a gas funding could take a nonce a payout had been promised, and the payout
failed for no reason it could explain. The sweeper now pays gas from
`GAS_FUNDER_PRIVATE_KEY`, and the withdrawer, sweeper and vault submitter all
refuse to start if any two of their keys are the same account. As a side
effect the sweeper no longer holds a key that can spend the hot wallet's
tokens: it reads the hot wallet's address from the row the withdrawal worker
registered, and warns when fewer than ten gas fundings are left.

**A mismatched mnemonic is caught before anything is signed.** A phrase that
does not match the deployed xpub derives a perfectly valid key for a completely
different address. Signing would succeed, the transaction would be accepted, and
the tokens would sit untouched while the wallet reported success. Every
derivation is checked against the address the xpub produced; removing that check
fails a test.

**Sweeping is stateless, and deliberately so.** It moves tokens between two
addresses the wallet already controls, so no user's balance changes and there is
nothing to record -- the deposit was credited when it arrived, and where the
tokens physically sit afterwards is a custody detail. Re-reading balances every
pass makes a crash halfway harmless: the next run simply picks up what is left.

**One failing address does not strand the rest.** A single unsweepable deposit
holding up every other user's funds would be worse than the failure itself, so
failures are collected and reported rather than thrown.

**Nonces come from the database, not the chain.** Two workers that both call
`eth_getTransactionCount` receive the same answer, sign two transactions with
the same nonce, and the node keeps one -- the other withdrawal disappears with
no error anywhere. Postgres can serialise the request; the chain cannot.

**Allocation is a single `UPDATE ... RETURNING`.** Postgres holds the row lock
for the duration of one statement, so callers are serialised without explicit
locking. Reading the nonce and writing back `nonce + 1` as two statements
reintroduces exactly the race the table exists to remove, and doing so fails two
of these tests.

**A rollback returns the nonce.** Gaps are worse than duplicates: a nonce that
is allocated but never broadcast blocks every transaction queued behind it.
Allocation therefore happens inside the caller's transaction, so a withdrawal
that fails after allocating does not consume one.

**The counter is never wound backwards.** Running ahead of the chain is normal
while transactions are in flight, and "correcting" it would reissue nonces
already sitting in the mempool. Sync only ever moves forward, for the case where
the key was used by something this database does not know about.

**A successful receipt is not proof that anything happened.** A call to an
address holding no code succeeds trivially -- there is no code to revert -- so a
misconfigured token address produces a healthy receipt with an empty log list
while no tokens move at all. The worker therefore checks the receipt for a
matching `Transfer` event before settling, and the CLI refuses to start if
nothing is deployed at the configured token address. Without that check the
ledger records payouts the chain never made.

**Destination addresses are checksummed at the API boundary.** viem rejects a
mixed-case address with a bad EIP-55 checksum, and it rejects it at signing
time -- deep inside the worker, after a nonce has already been committed to the
row. That transaction can then never be broadcast and every later nonce queues
behind it. Rejecting it with a 400 costs the caller nothing and costs the queue
nothing.

**A withdrawal that cannot be sent is abandoned, not retried forever.** After a
few failed broadcasts the worker spends the nonce on an empty self-transfer,
refunds the user, and lets the queue move. A nonce held by a transaction that
will never exist is the worst state this system can reach.

**Stuck transactions are replaced at the same nonce.** A replacement must reuse
the nonce it is replacing, which is why the nonce lives on the row. The fee is
raised by more than the 10% nodes demand, because one underpriced withdrawal
freezes every later one behind it.

**Funds are debited on request, not on settlement.** They wait in
`PENDING_WITHDRAWALS`, so the same balance cannot be spent twice while a
transaction is in flight, and a refund is always funded -- it moves money out of
a system account rather than inventing it.

---

[All phases](README.md) · [Project README](../../README.md)
