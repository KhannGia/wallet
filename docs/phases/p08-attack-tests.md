# P8 — Attack tests

`contracts/test/vault/MultisigVault.attacks.t.sol` holds one test per attack:
one signature repeated as a quorum, outsiders forming a quorum (fuzzed),
malleated signatures, the all-zero signature, the 64-byte compact encoding, a
signature obtained through `personal_sign`, cross-chain replay, cross-vault
replay, a future nonce submitted early, reentrancy with the same approval, a
front-runner submitting the approval, and a vault with no owners.

**Each defence was removed on purpose to see which attack got through.**

| Defence removed                        | Attacks that then get through             |
| -------------------------------------- | ----------------------------------------- |
| Strictly ascending signers             | one signature repeated as a quorum        |
| OpenZeppelin `ECDSA.recover` -> raw `ecrecover` | malleated signature executes; zero and compact signatures change how they fail |
| Chain id and contract in the domain    | cross-chain replay, cross-vault replay    |
| Reentrancy guard *and* nonce-before-call | the same approval spent twice           |

**Some defences are layered, and the tests say so rather than pretend
otherwise.** Removing only the reentrancy guard, or only the
nonce-before-call ordering, lets nothing through: each on its own is enough to
stop the same approval being spent twice, so the test fails only when both go.
Likewise, with raw `ecrecover` the all-zero signature is still refused -- by the
ascending-order check, since it recovers to the zero address -- and the compact
encoding by an out-of-bounds read. Those are incidental backstops, not designs;
OpenZeppelin is the intended defence.

**Malleability is defence in depth here, not the last line.** A malleated
signature recovers to the same owner, so with raw `ecrecover` it executes
exactly what that owner approved. It becomes a theft vector only in contracts
that key state on signatures -- "has this signature been used?" -- which this
vault deliberately does not. Rejecting it anyway costs nothing.

---

[All phases](README.md) · [Project README](../../README.md)
