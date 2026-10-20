# P15 — Proof of reserves

```
./wallet deploy-reserves     # the registry; prints RESERVES_REGISTRY_ADDRESS
./wallet reserves            # snapshot + publish, every RESERVES_POLL_MS

curl -s localhost:3000/api/v1/reserves/latest
curl -s localhost:3000/api/v1/reserves/<id>/proof/<accountId> -H "Authorization: Bearer $TOKEN" > proof.json
./wallet verify-proof proof.json
```

Two questions, answered separately.

**Does the platform hold what it owes?** Assets are the token balances of every
address it controls -- hot wallets, the vault, and every deposit address, since
a credited deposit sits there until it is swept. Liabilities are, per user,
their balance, their deposits not yet final, and their payouts and graduations
not yet on chain. The hard part is reading both at one moment:

| Money in motion | Handled by |
| --------------- | ---------- |
| A sweep, a rebalance | every balance is read at the same block, so moving tokens between the platform's own addresses changes nothing |
| A deposit the indexer has not reached | the block is the indexer's cursor, read in the same `REPEATABLE READ` snapshot as the ledger: every deposit the ledger counts arrived by then |
| A payout mined but not yet settled | its receipt is checked: mined by the block, it is no longer owed |

What remains can only err towards a surplus. A shortfall answers 500 on the
admin endpoint and goes to the worker's stderr.

To make this honest the ledger lost its simulated bank: `POST /deposits` and
`POST /withdrawals` credited and debited balances with nothing on chain behind
them. Money now enters only through a deposit the indexer sees.

**Is my balance in that total?** Each snapshot builds a **Merkle sum tree**:
every node carries a hash and the total beneath it, and its hash commits to
both. A plain Merkle tree would prove a balance is in a list, not that the
published total is the list's sum. Here a user walking their proof to the root
adds up every sibling's total on the way; a branch given a smaller total than it
holds makes the hashes disagree for everyone under it, and sums are unsigned,
so no branch hides a debt behind a negative balance.

| Design choice | Why |
| ------------- | --- |
| A fresh random salt per user per snapshot, in the leaf | account ids are sequential; without it anyone could hash each id with each plausible balance until a leaf matched, and leaves would link across snapshots |
| Leaves ordered by their salted hash | a leaf's position says nothing about which account it is |
| Leaf and node hashed with different tags (and lengths) | a leaf can never be passed off as a node |
| The root published on chain, in `ReservesRegistry` | a root served only by the API could differ for every user who asks -- each would find themselves in a tree built just for them. The registry holds one append-only sequence, the same for everybody, and accepts only the publisher's key |
| The verifier computes the root itself | it looks that root up on chain and requires the proof's sum to equal the total published with it; the API's own claim of a root is never used |

The registry checks what it can: only the publisher writes, the block must
already exist, and the record never goes backwards in time. A shortfall is
published like anything else -- the point is that the platform cannot choose
which snapshots the world sees. A publication whose receipt is lost to a crash
is found again by its root on the next pass.

**Limits, stated.** A sum tree catches an understated branch only if someone
under it checks; a test shows a user elsewhere in the tree accepting a proof
that passes the shrunk node as a sibling. Sibling totals reveal neighbours'
balances, though not whose. The assets figure is the platform's claim, not
proven: anyone can re-read the hot wallet and vault at the attested block, but
nothing proves the platform owns every address it counts, nor lists every
deposit address publicly. A proof is handed only to its account's signed-in
owner (since P16), so its salt stays theirs.

**What testing found.** Mutations across the reserves read, the tree, the
snapshot, the registry, the publisher and the verifier: of forty-seven,
forty-six fail a test. Several needed a new test first -- a payout mined after
the snapshot's block, a deposit recorded past the cursor, a salt swapped with
the total unchanged, the right root published with the wrong total, an empty
tree's root (shared by every empty snapshot) mistaken for another's
publication. The survivor is equivalent: the leaf and node tags, since their
inputs already differ in length. Left out as equivalent too: the receipt status
check in the reserves read, since a reverted transfer emits no `Transfer`.
The registry has 100% coverage, like every contract here.

---

[All phases](README.md) · [Project README](../../README.md)
