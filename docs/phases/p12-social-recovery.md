# P12 — Social recovery

A smart account with one owner is lost with its key: nothing can be upgraded,
and nobody can step in. **Social recovery** lets the owner name guardians in
advance -- friends, a second device, the platform -- a quorum of whom can hand
the account to a new key:

```
guardians sign (3 of 5) -> initiateRecovery(newOwner) -> 48h -> executeRecovery() -> new owner
                                                          |
                                                          +- the owner (key still works) or a
                                                             guardian quorum may cancel
```

**The delay is what stops colluding guardians.** If the owner still has the
key, the recovery was never needed, and they have 48 hours to veto it with a
signed operation. A test has three guardians try to take the account and the
owner cancel. Guardians can also withdraw a recovery they started, by the same
quorum signing over its nonce -- so that cancellation cannot be replayed later
against a different recovery.

**A module with exactly one power.** Recovery lives in `GuardianModule`, one
contract serving every account. The account trusts it with `transferOwnership`
and nothing else: not a general module system that could make the account call
anything, which would be a second owner. The owner chooses the module, and can
remove it, only through their own signed operations.

**The vault's signature rules, reused.** Guardians sign EIP-712 approvals
off-chain, so they need no ether; anyone submits them. Exactly a quorum,
strictly ascending by signer, bound to the account, the chain and a nonce that
every recovery, cancellation and change of guardians spends. Changing guardians
also cancels a recovery in progress, so approvals from removed guardians cannot
complete it. A matured recovery lapses after seven days.

**What it does not do.** Recovery protects against a lost key, not a stolen one:
a thief with the key can move the funds at once, without waiting for anyone.

**What testing found.** Removing the nonce increment when a recovery starts
survived every test: the approvals' one-hour deadline expired before the 48-hour
delay ended, so expiry masked the gap. With a long deadline, the same approvals
could start a second recovery after the first completed. A test now holds
approvals to a single use. And `forge coverage` compiles without the optimiser:
the account had grown enough that deploying it from initCode ran out of the
test helper's verification gas, which first looked like a collapse in coverage.

Coverage is 100% for every contract; fifteen mutations to the recovery
defences each fail a test.

## Approvals over the API, and a relayer

```
POST /api/v1/recovery/requests                   open a request; returns the typed data guardians sign
POST /api/v1/recovery/requests/:id/approvals     a guardian's approval
POST /api/v1/recovery/requests/:id/cancellation  open a guardians' cancellation of a started recovery
POST /api/v1/recovery/requests/:id/cancellations a guardian's vote to cancel
GET  /api/v1/recovery/requests/:id               status, signers, executable time
./wallet recovery-relayer                         starts, executes and cancels on chain
```

**Several requests may collect at once.** Anyone may open a request -- only
guardian signatures count -- so "one open request per account" would let a
stranger block a genuine recovery with a bogus one until its deadline passed.
Whichever request starts first spends the module's nonce; the rest become
`STALE`, which a test shows with two competing requests.

**The relayer's key only pays gas.** Guardians' signatures authorise every step,
and the module checks them again on chain. It is still a key, so it runs apart
from the API and is checked against every other signer.

**The module is the record.** A veto the owner sends from their own wallet, or a
cancellation guardians submit themselves, never passes through the relayer; it
reads the module's pending recovery every pass and notices it is gone. A moved
nonce is checked against the module before a request is called stale, so a
start whose receipt was lost is recognised -- the same lesson as the vault's.

**After recovery the account keeps its address.** The factory derives addresses
from the owner an account was created with, so the account adapter takes an
explicit address for an account whose owner has since changed; a test has the
new key send a UserOperation through the bundler.

Mutation testing covers the relayer and the request checks as well as the
contracts.

---

[All phases](README.md) · [Project README](../../README.md)
