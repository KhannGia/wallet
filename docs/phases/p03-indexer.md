# P3 — The deposit indexer

**The scanner asks the node to filter, not JavaScript.** `fetchIncomingTransfers`
passes the watched addresses as the indexed `to` topic, so the response stays
small however busy the token is. It also short-circuits an empty address list:
an empty topic filter matches *every* transfer rather than none, so a wallet
with no accounts would otherwise ingest the token's entire traffic.

**Scanning happens in bounded chunks.** Nodes cap how many blocks one
`eth_getLogs` may span. A test scans the same range whole and one block at a
time and asserts both produce an identical set, so the chunking cannot quietly
drop or duplicate a log.

**The cursor only moves forward.** `advanceCursor` uses `GREATEST`, so a stale
or out-of-order result cannot rewind the indexer and cause a range to be
credited twice. Rewinding after a reorg is a separate, deliberate operation,
which is what P4 adds. A missing cursor resumes from a configured start block
rather than from "now" -- the latter would silently skip every deposit that
arrived while the indexer was down.

**Each transfer carries its block hash.** Not needed to credit a deposit, but
required to notice later that the block it arrived in is no longer on the
canonical chain.

**A deposit takes two steps, and the split is the point.** While its block can
still be reorganised away the money sits in the `PENDING_DEPOSITS` system
account and the user's balance does not move. Only once the block is final is
it released to them. So a balance always means "spendable", and undoing a
reorged deposit never has to claw funds back from someone who already spent
them.

**The chain supplies the idempotency key.** A log's `(transactionHash,
logIndex)` is unique by definition, so rescanning a range -- which happens on
every restart -- cannot credit the same transfer twice. No key has to be
invented for it.

**Finality is configurable because devnets have none.** `finalized` is correct
on a real network. anvil pins its `finalized` tag to genesis forever, so a
devnet must count confirmations instead or nothing would ever be credited. The
default is the safe one, and a devnet opts out explicitly.

**The cursor advances only after a range is recorded.** Advancing first and
crashing would skip those deposits permanently. Recording first and crashing
merely rescans, which is harmless. At-least-once is the only safe direction to
fail in.

---

[All phases](README.md) · [Project README](../../README.md)
