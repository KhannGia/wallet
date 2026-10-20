# P2 — HD wallet, watch-only API

**The server derives addresses it cannot spend from.** `./wallet keygen` runs
offline and is the only code that ever holds a private key. It prints a
mnemonic once, writes nothing to disk, and emits the extended *public* key at
`m/44'/60'/0'/0`. Only that xpub is deployed. `loadWatchOnlyKey` refuses an
xprv and refuses a key at the wrong depth, so a misconfiguration fails at
startup instead of quietly granting spending authority.

**Addresses are checked against an independent source.** The tests derive from
the public Foundry mnemonic and compare against the addresses anvil prints in
its own startup banner. That matters because the two ways to get this wrong --
passing a compressed public key to `publicKeyToAddress`, or deriving from the
wrong depth -- both produce valid-looking addresses that nobody holds keys to.
Only comparison against a known vector catches them.

**Indices come from a sequence, not `MAX(index) + 1`.** `nextval` is safe under
concurrency without taking a lock. The alternative would hand two simultaneous
signups the same address, silently merging two users' deposits into one
balance. A test creates 25 accounts at once and asserts every index and address
is distinct.

---

[All phases](README.md) · [Project README](../../README.md)
