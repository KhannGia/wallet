# P7 — The multisig vault

**The multisig logic is ours; the dangerous primitives are not.** Threshold,
signer ordering, the nonce and the signed struct are written here, because that
is the part worth understanding. Signature recovery, the EIP-712 domain and the
reentrancy guard come from OpenZeppelin v5.7.0, pinned: recovering a signature
without rejecting malleable ones, or building an EIP-712 domain by hand, is the
class of mistake that has drained real vaults.

**Signers must be strictly ascending.** That is what makes them distinct.
Without it, one owner's signature repeated three times would satisfy a 3-of-5
quorum. The ordering also rules out duplicates without a second loop or a
storage write.

**Everything that decides what the call does is signed.** Target, value,
calldata, nonce and deadline are all in the struct, so whoever submits the
transaction cannot alter any of them after the owners approved it. A test tries
to send five ether with signatures for one.

**The domain binds the chain and the contract.** A signature collected for one
vault, or on one chain, is worthless anywhere else. A test recomputes the digest
independently, the way an off-chain signer would, and checks it matches.

**A failed call does not spend the approval.** It reverts everything, the nonce
included, so the same signatures can be retried -- once the vault is funded, say
-- until the deadline passes.

**The vault cannot judge success for its target.** A generic call to an ERC-20
that signals failure by returning false will look like a success. The return
data is surfaced so whoever proposes a transfer can check it, the same lesson as
the payout worker checking for a `Transfer` event.

Every line, statement, branch and function of the vault is covered.

---

[All phases](README.md) · [Project README](../../README.md)
