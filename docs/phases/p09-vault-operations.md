# P9 — The vault in operation

**The digest is computed off-chain and checked against the contract.** Owners
sign what the service computes, and a test compares it to the vault's own
`hashExecute`. If they ever disagreed, every signature collected would be
rejected on submission -- after the owners' time had already been spent.

**Every check the vault makes is repeated before a signature is accepted.**
Signer must be an owner, must not have signed already, and the signature must be
65 bytes with `s` in the lower half. Skipping any of them would not make the
vault unsafe -- it would still refuse -- but a proposal would look ready when
its submission was certain to fail.

**Proposals are tied to a vault nonce.** Every execution consumes one, so a
proposal is valid for exactly one position in the queue. Only one may collect
per nonce, and one whose nonce the vault has moved past is marked stale: those
signatures can never be used, however many times they are retried.

**There is no "failed" state.** A reverted `execute` reverts the vault's nonce
too, so the approval stays valid and can be resubmitted until its deadline.

**Wei does not fit in a BIGINT.** Postgres BIGINT tops out near 9.22 * 10^18,
about 9.22 ether, so a ten-ether reserve transfer would overflow it. The value
column is `NUMERIC(78, 0)`, wide enough for any uint256, and a test moves ten
ether through it.

**Deadlines are measured in chain time.** The vault compares against
`block.timestamp`, so that is the clock the service consults, and tests reach a
deadline with `evm_increaseTime` rather than by sleeping.

**Recording a status and raising an error are separate steps.** The first
version marked a proposal stale inside a transaction and then threw, which
rolled the mark back: the caller heard "stale" while the row still said
"collecting". The status now commits first. The same mistake was in the expiry
path, which had no test until this was found.

Mutation checks confirm each of those guards is load-bearing: removing the
low-s check, the owner check, the signer sort, or the nonce check each fails a
test, as does putting the expiry throw back inside the transaction.

## Over HTTP

| Endpoint | Purpose |
| -------- | ------- |
| `POST /api/v1/vault/proposals` | Open a proposal; returns the `eth_signTypedData_v4` JSON for owners |
| `GET /api/v1/vault/proposals/:id` | Status, signers so far, and the typed data for late signers |
| `POST /api/v1/vault/proposals/:id/signatures` | An owner submits a signature |
| `POST /api/v1/vault/proposals/:id/retry` | Hand a failed proposal back to the submitter |

**There is no submit endpoint.** Submitting costs gas, so it needs a key, and
the API server holds none. `./wallet vault-submitter` submits whatever has
reached its quorum. Its key only pays gas -- the owners' signatures authorise
the transfer -- but it is refused if it equals the hot wallet's key, whose
nonces the withdrawal worker allocates itself.

**The routes need no login to be safe.** Anyone may propose; a signature is
accepted only if it recovers to a vault owner, and the vault checks every one
again on chain. A real deployment would still put proposing behind
authentication, to keep the queue free of noise.

**A failed submission is not retried automatically.** Whatever made the vault
revert -- usually too little balance -- will still be true a few seconds later,
and a worker that kept trying would spend gas every pass to learn nothing. The
reason is recorded on the proposal and a person clears it with `/retry`.

**A lost receipt is not mistaken for a stale proposal.** If the submitter
broadcasts and then loses its connection before recording the hash, the next
pass finds the vault's nonce moved. Before calling the proposal stale it looks
for the vault's `Executed` event at that nonce, and if the call matches, records
the proposal as executed with that transaction.

**Integers travel as strings, including in the typed data.** A wei amount does
not survive a JSON number, and a test hashes the JSON exactly as a wallet would
receive it and compares it to the contract's own digest.

## The timelock

Whoever steals a quorum of keys could empty a plain multisig in one
transaction. The vault now refuses to do that at once:

```
                    +- hot-wallet top-up within today's allowance -> execute now
quorum of owners ---+
                    +- anything else -> queue -> wait `delay` -> executeQueued
                                           |
                                           +- any ONE owner may cancel meanwhile
```

**It is enforced on chain.** A delay kept by the backend protects nothing: a
thief holding the keys calls the contract directly.

**One owner can cancel.** If a thief holds a quorum, the honest owners left are
by definition fewer than one. A cancel that needed a quorum would never come.
The price is that a rogue owner can stall calls -- stall, never move funds.

**The fast path recognises exactly two shapes:** ether to the hot wallet, and a
token's own `transfer(hotWallet, amount)` with no ether attached and no trailing
bytes. `approve`, `transferFrom`, transfers to anyone else, and every call to the
vault itself wait. Each token has its own daily allowance.

**Allowances are daily, not per call.** A per-call cap only changes how many
transactions a thief needs; a test splits a drain into fifty small top-ups and
gets exactly one day's allowance out.

**Configuration goes through the timelock too.** Changing the hot wallet, an
allowance or the delay is a call the vault makes to itself, which is never
fast-path. A thief cannot raise the allowance and use it in the same breath.

**A queued call does not block the queue.** The nonce is spent when a call is
queued, so a payout waiting out its delay does not hold up the top-ups behind
it. A queued call expires 14 days after it matures.

**A delay of zero switches the timelock off** -- which is how the older suites
deploy it, so they keep testing the multisig on its own.

**The backend asks the vault rather than copying its rules.** The submitter
tries `execute`; if the vault answers `TimelockRequired`, it queues instead. A
second copy of the fast-path rules in TypeScript could only ever disagree with
the contract. A queued proposal then moves through the same worker:

| Status | Meaning |
| ------ | ------- |
| `QUEUED` | The vault spent the nonce and holds the call until `eta` |
| `EXECUTED` | `executeQueued` ran it after the delay |
| `CANCELLED` | An owner cancelled it on chain |
| `EXPIRED` | Nobody executed it within the 14-day grace period |

**Cancelling is an owner's own transaction.** The vault accepts `cancel` only
from an owner, and the backend holds no owner key, so `GET` on a queued proposal
returns the exact call to send from an owner's wallet. The submitter checks the
vault's queue on every pass and records the cancellation when the entry is gone.

**A lost receipt is recognised for queueing too.** If the vault's nonce moved
and it holds a `Queued` event for this proposal's call, the proposal is
recorded as queued with that transaction, not as stale.

Coverage stays at 100% of lines, statements, branches and functions. Of fourteen
mutations to the new defences, thirteen fail a test outright. The fourteenth --
dropping the reentrancy guard from `executeQueued` -- survives because the
queued entry is already deleted before the external call; removing both fails
the reentrancy attack test, so each layer holds on its own.

## Hot/cold rebalancing

The hot wallet's key is online, so what it holds is what a breach costs; but a
hot wallet that runs dry stalls every payout. Rebalancing keeps its
*available* balance -- on chain, minus payouts already promised -- inside a
band set by three marks:

```
  above HIGH  -> the withdrawal worker returns the excess to the vault
  ---- TARGET   (where a rebalance in either direction lands)
  below LOW   -> the vault submitter proposes a top-up for owners to sign
```

**Two marks, not one.** A balance hovering around a single threshold would
rebalance on every pass, each time costing gas or an owner's signature.
Between LOW and HIGH nothing happens.

**A top-up is proposed, never signed.** Moving reserves out of the vault takes
owners' signatures; a process signing for them would make the multisig a
formality. The proposal is sized to the vault's daily fast-path allowance, so
the signatures are all it takes -- no timelock wait while payouts stall. It is
refused outright if the vault's `hotWallet()` is not the account the withdrawal
worker registered.

**A return rides the payout machinery.** Sending from the hot wallet needs the
hot wallet's key, and only the withdrawal worker may use it. So the return is a
`chain_withdrawals` row of kind `REBALANCE`, getting the same nonce allocation,
stuck replacement and abandonment as a payout -- but no account and no ledger
entries, which the schema enforces both ways. The platform moving its own
tokens changes nobody's balance.

**Reconciliation had to learn the difference.** It compared every in-flight
withdrawal against `PENDING_WITHDRAWALS`. A rebalance reserves nothing there, so
counting it would report a healthy ledger as unbalanced; a test checks the
ledger reconciles while a return is in flight. Seven mutations to these
defences each fail a test.

---

[All phases](README.md) · [Project README](../../README.md)
