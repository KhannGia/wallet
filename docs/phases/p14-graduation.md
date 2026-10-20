# P14 — Graduation

Graduation is the bridge between the two halves of the project: money leaves
the ledger, crosses the chain through the hot wallet, and lands in an account
the platform cannot touch.

```
POST /api/v1/accounts/:id/graduation   { owner }   -> AWAITING_ACTIVATION, the account's address
   user: deploy + adopt the guardian module + name guardians, one sponsored operation
POST /api/v1/graduations/:id/funding               -> FUNDING, the whole balance reserved
   withdrawal worker: transfer from the hot wallet  -> COMPLETED | FAILED (refunded)
```

**Activate first, fund second.** The account's address is fixed by the user's
key before it exists, so funds could be sent there at once -- and if the user
lost the key before deploying, no guardian could help, because none would have
been named yet. Funding waits until the chain shows code at the address
answering to that key. Code there can only have come from the platform's
factory, since CREATE2 ties an address to its deployer and bytecode.

**Activation costs the user nothing.** A user arriving from custody holds no
ether, and the account holds no tokens yet, so the paymaster policy from P11 --
token transfers only -- would refuse to pay. The policy now also sponsors the
owner setting up recovery: the account adopting the platform's guardian module
(that module, on itself, nothing else) and naming at most ten guardians in it.
Both calls are compared byte for byte with their canonical encoding; session
keys still reach token transfers only.

**A graduation is a payout.** Funding reserves the balance in
`PENDING_WITHDRAWALS` as a `GRADUATION` withdrawal, so everything P5 built
carries it: nonces from the database, stuck transactions replaced, abandonment
after repeated broadcast failures. The graduation follows its payout in the same
database transaction as the ledger movement, so it never reads `COMPLETED` while
the balance is still reserved:

| On chain | Ledger | Graduation |
| -------- | ------ | ---------- |
| transfer confirmed | `PENDING_WITHDRAWALS -> BANK_GATEWAY`: the liability is gone | `COMPLETED` |
| reverted, abandoned, or no `Transfer` emitted | `PENDING_WITHDRAWALS -> user`, a `REVERSAL` | `FAILED`, the user may try again |

**Races, closed by the database.** One graduation may be open per account (a
partial unique index), so a double click cannot open two accounts for one
balance. Funding twice at once reserves once, under an idempotency key derived
from the graduation. A cancellation arriving while funding checks the chain is
seen, because funding re-reads the status under a row lock -- a test holds that
lock to land a cancellation in exactly that gap.

**Custody stays open.** Graduating is not leaving: a later deposit can be
graduated to the same account, which needs no second activation.

**What the platform can do afterwards: nothing.** A test takes every platform key
in the flow -- the hot wallet, the paymaster's signer, the deployer, the
recovery relayer -- and has each try to move the graduated funds. Called
directly, the account answers `OnlyEntryPoint` (execute, batch, sessions,
module) or `OnlyOwnerOrRecovery` (ownership). Through the EntryPoint, the
paymaster's policy sees a token transfer from a known account and agrees to pay
-- and the account still rejects the signature (`AA24`). Starting a recovery
without guardians' approvals fails `SignatureCountMismatch`. The balance and the
owner are unchanged.

**Hard to test, so tested on purpose.** An on-chain revert needs a transfer that
passes estimation and then fails. anvil estimates against pending state, so
queuing a draining payout first only makes the graduation fail to broadcast.
Instead, the hot wallet grants an allowance in setup, and once the graduation is
broadcast a `transferFrom` with a higher tip takes the tokens in the same block,
ahead of it.

**What testing found.** Mutations were run over funding, settlement and the
policy. One survived until a test landed a cancellation mid-funding; another
showed the policy refusing a stray module call only by accident -- the call
decoded as `setRecoveryModule` and its address failed the guardian count --
so module calls are now decoded against `setGuardians` alone. Of twenty-two
mutations, twenty-one fail a test; the last, a `FUNDING` guard on the status
update, is equivalent, since a graduation with a payout in flight is always
funding.

**Who may graduate.** Since P16, only the account's signed-in owner: anyone
else is answered 404, as if the account or the graduation did not exist.

---

[All phases](README.md) · [Project README](../../README.md)
