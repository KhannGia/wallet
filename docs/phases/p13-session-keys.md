# P13 — Session keys

A session key is a second key the owner signs into the account through an
ordinary operation:

| Bound | Example |
| ----- | ------- |
| Time | valid for the next 24 hours |
| Scope | only `transfer` on USDC, recipient must be X, amount at most 50 |
| Total | at most 100 USDC, and no ether, across the whole session |

Leaking one costs at most what its limits allow. The owner keeps full power and
can revoke a session at any time.

**Scope is checked in validation, the total in execution.** Permissions are a
list of `(target, selector, conditions)`, a condition being "argument *n* is
equal to / at most / at least a value", so an operation outside them is refused
before it costs anything. The running total is counted when the call runs: an
operation past the cap reverts there, though the gas for trying is spent.

**Counting in execution needs the whole operation.** The EntryPoint validates
every operation in a bundle before executing any, so remembering "a session is
acting" in storage during validation would be overwritten by the next
operation's validation before this one runs -- a hostile bundler could arrange
exactly that. Sessions act only through `executeUserOp` (EntryPoint v0.8's
`IAccountExecute`), which hands execution the full operation -- signature
included. Tests put two session operations in one bundle, and an owner's
revocation ahead of a session operation the bundler already validated; both are
stopped.

**The signature names the session.** A session's signature is its address, then
its ECDSA signature: `[address, 20 bytes][signature, 65 bytes]`; the owner's is
the bare 65 bytes. The first design recovered the session from the signature in
execution, and the end-to-end test through a real bundler broke it: to estimate
gas, a bundler simulates with a placeholder signature, which recovers to nobody
-- so execution found no session, reverted, and no session operation could ever
be estimated. Foundry and the ERC-7562 tests both used fixed gas and never
noticed. Stated in the signature, the session is charged correctly whatever the
signature; validation has already proved the signature is that session's
before anything executes.

**The clock and the storage follow ERC-7562.** Validation may not read
`block.timestamp`, so the session's window goes back to the EntryPoint in
`validationData` -- which treats the `validAfter` second itself as not yet due.
Session data lives in the account's own storage: a separate module's nested
`mapping(account => mapping(key => ...))` would not count as storage associated
with the sender, and real bundlers would refuse the operation.

**What a session can never reach.** The account itself (new sessions, owner,
recovery module), the EntryPoint (its deposit and nonces), and the recovery
module -- even if the owner grants a permission on one by mistake. A capped
token moves only through `transfer` and `approve`, both counted; an unlimited
approve would otherwise hand the balance to the spender outside the cap.

**What testing found.** A transfer cut short of its amount would have its amount
read from beyond the call data -- typically zero, so uncounted. A standard token
reverts on that call, which hid the gap; a test with a token that tolerates it
showed the transfer going through, and a capped token's calls must now carry
their full arguments. Two more mutations survived until tests granted
permissions on the forbidden targets on purpose. Of twenty-one mutations,
twenty fail a test; the twenty-first is equivalent, since a revoked session has
no permissions left to match. Coverage is 100% for every contract.

## The session manager

```
./wallet session-manager
POST   /sessions                  create a key for an account; returns the addSession call for the owner
POST   /sessions/:id/operations   spend with it: { to, value, data, sponsored }
GET    /sessions/:id
DELETE /sessions/:id              shred the key; returns the revokeSession call for the owner
```

An app or a bot that should act on an account without its owner's key gets a
session the owner grants. The session manager holds the key so the app never
does: the app holds a bearer token, and asks.

| Concern | Answer |
| ------- | ------ |
| Where the key lives | its own process, apart from the API |
| At rest | AES-256-GCM under a master key only in its environment; a random IV per key; the account and session address as authenticated data, so a ciphertext swapped onto another row does not open |
| Who may ask | only callers presenting the bearer token, compared in constant time; whoever holds it can spend within every session's limits |
| Database leaked | ciphertext only |
| Database and master key leaked | the keys -- still bounded by every session's scope, cap and expiry on chain, which is the point of a session |
| Revoking | the ciphertext is deleted at once -- not even the service can sign again -- and the `revokeSession` call is returned for the owner, since only that stops everyone |
| Expiry | keys of expired sessions are shredded on a timer |
| Wasted gas | the cap is enforced in execution, so a call past it would revert at a cost; the service reads what is left on chain and refuses first |

Granting is the owner's act, from their own wallet: the service only returns the
`addSession` call. It notices on its own when the owner revokes on chain, and
shreds its copy. The paymaster's policy now also covers `executeUserOp`, with
the same rules, so a session operation can be sponsored: tests drive an app
spending through the service, gas paid by the paymaster, the account's ether
untouched.

## ERC-7562, enforced

```
./wallet test-node erc7562   # geth dev chain + the reference bundler in safe mode
```

A bundler simulates `validateUserOp` before accepting an operation. If
validation read the clock, or another contract's storage, the operation could
pass simulation and fail on chain -- and one transaction could invalidate
thousands of operations in the mempool at once. ERC-7562 forbids both, and real
bundlers enforce it by tracing every operation.

anvil cannot trace the way that needs, so the `erc7562` profile runs a **geth
dev chain** -- which ships the CREATE2 deployer and the tracer -- with the
canonical EntryPoint and the **reference bundler** from the authors of ERC-4337
and ERC-7562, in safe mode. Tests go both ways:

| Operation | Verdict |
| --------- | ------- |
| Owner's first operation, deploying the account through the factory | accepted |
| Owner granting a session, then the session key transferring within its rules | accepted |
| An account that reads `block.timestamp` while validating | refused, `OP-011` banned opcode |
| An account that reads another contract's storage (someone's token balance) | refused, `STO-010` unstaked access |

The refusals are what make the acceptances mean something: a "safe mode" that
let those through would not be checking anything.

**Why not Alto.** It was tried first. Its safe mode routes the simulation
through a helper contract and the EntryPoint's `delegateAndRevert`, and its
tracer does not record the outermost call frame -- so it decodes the
EntryPoint's `DelegateAndRevert(true, result)` instead of the result inside, and
refuses every v0.8 operation, compliant or not. The trace showed the account's
validation had in fact succeeded. Alto still serves the main stack, where safe
mode is off.

---

[All phases](README.md) · [Project README](../../README.md)
