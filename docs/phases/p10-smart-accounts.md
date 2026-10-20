# P10 — ERC-4337 smart accounts

A smart account is a contract that is a wallet: the user signs a
`UserOperation`, a bundler submits it to the EntryPoint, and the EntryPoint asks
the account whether the signature is good before letting it act.

```
user signs UserOp -> bundler -> EntryPoint.handleOps()
                                  1. account.validateUserOp()  checks the signature, pays for gas
                                  2. account.execute(...)      does the work
```

**EntryPoint v0.8, pinned for good.** The `UserOperation` layout and its hash
differ between versions; an account built for one does not work with another.
`./wallet install-forge` pins `eth-infinitism/account-abstraction` at v0.8.0 the
same way it pins OpenZeppelin. In v0.8 the `userOpHash` is an EIP-712 digest
over the operation, the EntryPoint and the chain, which is what makes a
signature worthless anywhere else -- tests replay one across chains, accounts
and EntryPoints.

**The address exists before the account does.** The factory deploys with
CREATE2 and the owner is part of the constructor arguments, so
`getAddress(owner, salt)` is known up front. Funds can arrive there first; the
owner's first operation carries `initCode`, deploys the account, and pays for
its own deployment out of what is already there.

**A bad signature is a verdict, not a revert.** `validateUserOp` uses
`tryRecover` and returns `SIG_VALIDATION_FAILED`, so a bundler simulating an
operation -- or estimating gas with a placeholder signature -- gets an answer
instead of an error.

**Only the EntryPoint's SenderCreator may deploy.** Anyone deploying a victim's
account first could not take it -- the owner is fixed by the address -- but
would make the owner's first operation fail with `AA10`.

**Not upgradeable.** An upgrade path is a second way to take an account over,
and an owner can always move funds to a new one.

**A mutation found a real gap.** Dropping the recover-error check survived the
tests, because a malformed signature recovers to the zero address and no test
account was owned by it. Nothing stopped one from being: an account owned by
the zero address would have answered to anyone sending garbage, guarded by that
single check. The constructor now rejects it. Twelve attack tests and 100%
coverage; of nine mutations, eight fail a test and the ninth is now equivalent.

## Through a real bundler

`docker compose` now runs Alto, Pimlico's bundler, next to anvil, and the
backend sends UserOperations to it with viem's bundler client:

```
./wallet test-node aa   # first UserOperation deploys the account and pays USDC
```

**The EntryPoint is the canonical one, at its canonical address.** Alto
recognises an EntryPoint's version by its address, so a fresh compile deployed
anywhere else is not served at all. `entrypoint-setup` replays the mainnet
deployment instead: the reference repository's own artifact, the salt from the
mainnet transaction, sent through the CREATE2 deployer anvil ships with. The
salt was checked locally -- with that artifact it yields exactly
`0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` -- and the script verifies the code
is there afterwards rather than trusting the transaction.

**Safe mode is off on anvil.** Alto enforces ERC-7562 -- what `validateUserOp`
may read and write -- by tracing every operation, and anvil lacks the tracer it
needs. P13 closes the gap with a second chain where the rules are enforced; see
below.

**Nonces run in one sequence.** An ERC-4337 nonce is a 192-bit key plus a
64-bit sequence. viem draws a fresh time-based key for every operation by
default, so each is first in its own sequence and they may land in any order.
For a wallet, where one payment can depend on the one before, the account
adapter pins the key to 0. A test caught this: the second operation's nonce came
back as a timestamp, not 1.

**A forged signature never reaches the chain.** The bundler simulates before
accepting, the account reports the bad signature, and the operation is refused
with `AA24` -- nothing deployed, nothing spent.

---

[All phases](README.md) · [Project README](../../README.md)
