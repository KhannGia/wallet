# Security review: the contracts

A review of every contract under `contracts/src/`, done in P16. It is a
learning project's own review, not an audit: nobody independent has looked at
this code, and nothing here should hold real funds.

| Contract | What it guards |
| -------- | -------------- |
| `vault/MultisigVault.sol` | The platform's reserves: M-of-N owners, a timelock, a daily fast path to the hot wallet |
| `aa/SmartAccount.sol` | A graduated user's funds: one owner key, a recovery module, session keys |
| `aa/AccountFactory.sol` | Deploys accounts at addresses fixed by their owner |
| `aa/VerifyingPaymaster.sol` | The platform's gas deposit, spent on sponsorships its signer signs |
| `aa/GuardianModule.sol` | Hands a lost account to a new key, after a quorum and a delay |
| `reserves/ReservesRegistry.sol` | The append-only record of proof-of-reserves roots |

## How

1. **Static analysis** with [Slither](https://github.com/crytic/slither) 0.11.6,
   Trail of Bits' analyser, run from its own image pinned by digest:
   `./wallet slither`. Every finding is triaged below.
2. **A manual pass** over each contract against the checklist further down:
   who may call what, the order of state changes and external calls, how a
   signature is bound, and what each value can be at its extremes.
3. **What the tests already prove.** The vault, the account, its session
   keys, the paymaster and the guardian module each have an `*.attacks.t.sol`
   file of exploits that have drained real funds elsewhere, each expected to
   fail here; the factory and the registry have their refusals tested
   alongside their behaviour. Coverage is 100% of lines, statements, branches
   and functions;
   and every phase mutated its own code until each surviving mutation was
   shown to be equivalent. Account validation also runs against a bundler
   that enforces ERC-7562 (`./wallet test-node erc7562`).

## Fixed

| Finding | Where | Change |
| ------- | ----- | ------ |
| An external call in a loop: `owner()` read once per guardian | `GuardianModule.setGuardians` | Read once, before the loop. Gas only -- the value cannot change during the call |
| An event's address not indexed, so it could not be filtered | `MultisigVault.HotWalletChanged` | `indexed` |

Reviewing the frontend's flows also found a ledger bug, fixed in P16 slice 2:
`/transfers` could pay into a system account, such as `BANK_GATEWAY`, moving a
user's money onto the platform's books with nothing on chain behind it.

## Slither, triaged

Counted once each, though Slither repeats a finding in every contract that
imports the code it is in.

| Detector | Where | Verdict |
| -------- | ----- | ------- |
| `arbitrary-send-eth` | `MultisigVault._call`, `SmartAccount._call` | **By design.** Sending value to a caller-chosen address is what a vault and a wallet are for. The vault sends only what a quorum signed for; the account only what its owner, or a session within its limits, signed for |
| `low-level-calls` | `MultisigVault._call`, `SmartAccount._call`, `executeUserOp`, `validateUserOp` | **By design.** A generic call needs `call`. Every result is checked: a failed call reverts with its return data. `validateUserOp` pays the EntryPoint its prefund and deliberately ignores the result, as the ERC-4337 reference account does -- the EntryPoint itself checks it was paid |
| `calls-loop` | `SmartAccount.executeBatch` | **By design.** A batch is a loop of calls the owner signed. One failing reverts them all |
| `timestamp` | Timelock, grace period, daily window, deadlines, recovery delay, lapse | **Accepted.** A block producer can skew `block.timestamp` by seconds; every window here is minutes to days |
| `incorrect-equality` | `executableAt == 0`, `total == 0`, `idPlusOne == 0` | **False positive.** Zero is a sentinel for "none", not a balance that someone could push a contract off |
| `uninitialized-local` | `SmartAccount._permitted`: `selector` | **False positive.** Its zero value is deliberate: plain ether, with no call data, is matched as selector `0x00000000`, so a session can be allowed to send ether to one address |
| `missing-zero-check` | `SmartAccount.setRecoveryModule`, `executeUserOp` target | **By design.** Setting the module to zero is how an owner turns recovery off. A call to the zero address does nothing and is the owner's own choice |
| `unused-return` | `ECDSA.tryRecover` | **False positive.** The error and the recovered address are both checked; the ignored third value only details the error |
| `unused-state` | `VerifyingPaymaster.GAS_LIMITS_OFFSET`, `VALIDITY_OFFSET` | **False positive.** Both are used, inside calldata slices `[a:b]`, which Slither does not follow |
| `assembly` | `SmartAccount._conditionsHold`, `_charge` | **Reviewed.** Each reads one 32-byte word of call data after checking it exists -- a mutation found the one place that did not, and a test with a lenient token now covers it |
| `too-many-digits` | `AccountFactory.getAddress` | **False positive.** The literal is the account's creation code |

## The manual checklist

**Access control.** Every state-changing function was listed with who may
call it, and the list checked against the tests.

- Vault configuration is callable only by the vault itself, so only through
  its own quorum and timelock; `cancel` by any one owner, by design.
- The account's configuration -- sessions, recovery module -- only through the
  EntryPoint or itself; ownership only by itself or its chosen module.
- The factory deploys only from the EntryPoint's `SenderCreator`, so nobody can
  deploy an account first and break its owner's first operation.
- The registry accepts attestations only from its publisher.

**Signatures.** Every signed message is EIP-712, binding the chain id and the
verifying contract, and a nonce or deadline:

- Vault approvals bind the nonce and a deadline; signers must be strictly
  ascending, so one owner cannot count twice; OpenZeppelin's `ECDSA` rejects
  malleable and malformed signatures.
- Guardian approvals bind the account, the new owner, the module's per-account
  nonce and a deadline, so an approval cannot outlive a change of guardians.
- Sponsorships cover every gas field and an expiry, so the bundler cannot
  inflate what the paymaster pays for.
- User operations are signed over the EntryPoint's EIP-712 hash; session
  signatures name the session key, which validation then checks.

**Reentrancy and ordering.** The vault is `nonReentrant` and spends its nonce
before any call; a queued call is cleared before it runs. The account's calls
come only from the EntryPoint or itself. The guardian module changes state
before calling the account. The registry makes no external calls.

**Replay and front-running.** Nonces make every approval single-use. A
recovery approved under old guardians stops counting once they change. The
factory's addresses are fixed by the owner, so front-running a deployment
gains nothing.

**Arithmetic and bounds.** Solidity 0.8 checks overflow. Guardians are capped
at ten, a session's spend is capped per token, and unlimited `approve` is
counted against that cap like a transfer.

**ERC-7562.** Validation reads only the account's own storage and no banned
opcodes; an enforcing bundler accepts it and refuses two deliberately
violating accounts.

## Accepted risks

These are properties of the design, written down rather than fixed.

| Risk | Why it stands |
| ---- | ------------- |
| A quorum of vault owners can move all reserves | That is the trust a multisig places, and the timelock gives the rest time to see it and cancel |
| A single vault owner can delay any queued call | Cancelling needs one owner so a stolen quorum cannot block it. Delay is the worst a rogue owner can do |
| The paymaster's owner can withdraw its deposit | It is the platform's own money; it can stop sponsoring, never take a user's funds |
| A stolen paymaster signer key can spend the deposit on others' gas | Bounded by the deposit; each account's daily cap limits any one beneficiary |
| A quorum of colluding guardians can take an account | After 48 hours, during which the owner sees an alarm in the app and can veto with one sponsored operation |
| Accounts cannot be upgraded | A bug cannot be patched in place: a user would move to a new account. Nothing can be slipped in through an upgrade either |
| A stolen publisher key can publish a false reserves root | It cannot rewrite the past, and users whose balances it omits find their proofs fail |
| Everything trusts the EntryPoint v0.8 | The canonical, audited deployment, at its canonical address |

## Running it again

```bash
./wallet install-forge   # once: Slither compiles against lib/
./wallet slither         # findings per contract
./wallet test-forge      # attack tests included
./wallet coverage        # 100% expected
```
