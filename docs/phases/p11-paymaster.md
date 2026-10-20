# P11 — A paymaster, so users need no ether

A smart account still pays its own gas, in ether -- which a user holding only
USDC does not have. A **paymaster** pays instead, out of its deposit in the
EntryPoint. That deposit is the platform's money, so the paymaster pays only for
an operation carrying the platform's signature over *that exact operation*:

```
wallet -> sponsorship service: "will you pay for this?"   (policy decides)
       <- signature over the operation, valid until T
wallet -> bundler -> EntryPoint -> VerifyingPaymaster checks the signature, pays
```

**The sponsorship covers everything that sets the bill.** The paymaster pays up
to gas limit times fee, so the signed EIP-712 struct includes the account's gas
limits, `preVerificationGas`, the fees and the paymaster's own gas limit, along
with the sender, nonce, initCode and call. Raising any of them after the sponsor
signs -- tested one by one -- invalidates the sponsorship.

**Every sponsorship expires.** ERC-4337 reads a `validUntil` of zero as
"forever"; this paymaster treats it as a failed signature, so a bug in the
service cannot mint a sponsorship that never runs out. The time range itself is
enforced by the EntryPoint (`AA32`), since validation may not read the clock.

**Validation reads only immutables.** ERC-7562 restricts what a paymaster may
read while validating, and bundlers throttle one that breaks the rules. The
signer is fixed at deployment; rotating it means deploying a new paymaster.

**Deposit and stake are separate.** The deposit pays for gas; the stake is
locked collateral bundlers look at before trusting a paymaster, returned only
after an unstake delay. Only the owner (`Ownable2Step`) can withdraw either.

Fourteen attack tests -- a stranger's sponsorship, a swapped call, reuse for the
next nonce, raised gas or fees, expired, not yet valid, never expiring, another
chain, another paymaster, truncated data, an empty deposit, an outsider
withdrawing -- and 100% coverage. Of thirteen mutations, twelve fail a test; the
thirteenth is equivalent because the signer can never be the zero address.

## The sponsorship service

```
./wallet deploy-aa    # factory + paymaster on the local chain; prints their addresses
./wallet paymaster    # the ERC-7677 service, holding the sponsor's key
```

**ERC-7677, not a bespoke API.** The service answers `pm_getPaymasterStubData`
and `pm_getPaymasterData` over JSON-RPC, so any wallet or SDK that speaks the
standard -- viem's paymaster client included -- uses it unchanged. The stub
lets the bundler estimate gas with a placeholder signature; only the second
call signs.

**Its own process, because its key spends money.** A sponsorship spends the
paymaster's deposit, so the sponsor key is a spending key in all but name. It
runs apart from the API, is checked against every other signer for reuse, and
the service refuses to start if the deployed paymaster trusts a different key.

**The policy, before anything is signed:**

- the sender is an account the platform registered;
- deployment only through the platform's own factory;
- only `transfer` of the platform's token, alone or batched, no ether attached,
  no trailing bytes -- a paymaster pays even when a call reverts, and pays for
  whatever a call does, `approve` to a stranger included -- and, since P14, the
  owner setting up recovery when the account is activated;
- the paymaster gas limits are exactly the ones offered;
- and the operation's most expensive case, every gas limit times the max fee,
  fits under the account's rolling daily cap.

**The cap counts promises, not receipts.** A signed sponsorship can be spent
whether or not the wallet ever sends it, so what counts is the signature. One
nonce can only execute once, though, so asking again for the same nonce -- a
wallet retrying -- replaces the earlier promise instead of counting twice; a test
fills the cap exactly, retries, and is still served. Requests for one account are
serialised with a row lock, so two arriving together cannot both squeeze under a
cap only one fits.

---

[All phases](README.md) · [Project README](../../README.md)
