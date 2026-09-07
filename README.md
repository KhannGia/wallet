# wallet

A custodial crypto wallet with a real path to self-custody: an off-chain
double-entry ledger for instant internal transfers, on-chain settlement for
deposits and withdrawals, an M-of-N multi-sig vault for reserves, and ERC-4337
smart accounts so users can graduate to holding their own funds without the risk
of losing a seed phrase.

Read [PROJECT.md](PROJECT.md) for the problem statement, architecture and full
roadmap.

> **Testnet only.** This is a learning project. It must never hold third-party
> funds, and it is not a licensed custody service.

**Current status: P2 — HD deposit addresses.** On top of the P1 ledger, every user
now gets their own on-chain deposit address derived from an extended public key, so
the API server can generate addresses without holding anything that can spend.
Watching the chain for incoming deposits starts in P3.

## Requirements

Docker. That is the entire list.

Everything -- Node, npm, Foundry, Postgres -- runs in containers, and every
generated directory (`node_modules`, `contracts/lib`, build output) lives in a
Docker volume rather than on the host.

## Quick start

```bash
cp .env.example .env
./wallet install     # install npm + Solidity dependencies into volumes
./wallet up          # start Postgres, anvil and the API
./wallet migrate     # create the ledger schema
./wallet test        # run both test suites
```

Then:

```bash
curl -s localhost:3000/health/ready | jq
```

`make` works too if you prefer it (`make test`), but it is not required.

## Commands

Run `./wallet help` for the full list. The ones used most:

| Command             | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `./wallet up`       | Start the whole stack, waiting until it is healthy     |
| `./wallet dev`      | Same, then follow logs                                 |
| `./wallet test`     | Backend tests and Solidity tests                       |
| `./wallet typecheck`| Type-check the workspace                               |
| `./wallet keygen`   | Generate an HD wallet offline (prints a mnemonic once)  |
| `./wallet migrate`  | Apply pending database migrations                      |
| `./wallet db-reset` | Drop the schema and re-apply migrations (destroys data)|
| `./wallet psql`     | psql shell against the dev database                    |
| `./wallet cast ...` | Run `cast` against the local chain                     |
| `./wallet accounts` | Print the deterministic anvil test accounts            |
| `./wallet clean`    | Drop dependency volumes but keep the database          |
| `./wallet nuke`     | Drop every volume, database included                   |

## Trying the ledger

```bash
BASE=localhost:3000/api/v1

# Create an account, then fund it.
ACCOUNT=$(curl -s -X POST $BASE/users -H 'content-type: application/json' \
    -d '{"email":"alice@example.com"}' | jq -r .accountId)

curl -s -X POST $BASE/deposits -H 'content-type: application/json' \
    -H 'Idempotency-Key: dep-1' -d "{\"accountId\":\"$ACCOUNT\",\"amount\":\"100000\"}"

# Send the exact same request again: it returns the stored result with 200
# instead of 201, and the balance does not move.
curl -s -X POST $BASE/deposits -H 'content-type: application/json' \
    -H 'Idempotency-Key: dep-1' -d "{\"accountId\":\"$ACCOUNT\",\"amount\":\"100000\"}"

# The ledger must always sum to zero.
curl -s $BASE/admin/reconciliation
```

## What P2 demonstrates

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

## What P1 demonstrates

**Double-entry.** Money never changes, it only moves. Every transaction writes at
least two entries summing to zero, so `SUM(amount)` across the entire ledger is
always zero. `postEntries` is the single door money passes through, and it
rejects any set of postings that does not balance.

**Row-level locking.** `services/api/src/ledger/postings.ts` locks accounts with
`SELECT ... FOR UPDATE` in ascending id order. The ordering is what prevents a
deadlock when A pays B while B pays A.

**Idempotency.** Retrying a request with the same `Idempotency-Key` returns the
stored result instead of moving money twice. Correctness comes from the `UNIQUE`
constraint on `transactions.idempotency_key`, not from checking whether the key
exists first -- that check would itself be racy.

**Tests that would fail if the locking were removed.** In
`ledger/concurrency.test.ts`, the interleaving test drives two transactions by
hand and waits on `pg_stat_activity` until the second is provably parked on a
lock before committing the first. Removing `FOR UPDATE` fails it every run. The
20-parallel-withdrawal test is kept as the headline acceptance check, but it is
timing-dependent and can pass even against broken code -- which is exactly why
the deterministic one exists.

## Layout

```
contracts/          Foundry: vault, smart account, paymaster (P7 onward)
db/migrations/      SQL migrations, applied in filename order
docker/             Dockerfiles for the Node and Foundry toolchains
packages/shared/    Shared config, chain definitions, money helpers
services/api/       REST API
  src/db/           Connection pool and the migration runner
  src/ledger/       Double-entry core, idempotency, operations
  src/routes/       HTTP layer
  src/wallet/       Offline key generation (never runs in the server)
wallet              Task runner -- the entry point for everything
```

## Notes on the setup

**Money is never a float.** Balances are integers in minor units, stored as
`BIGINT` and parsed into JavaScript `BigInt`. Amounts cross the HTTP boundary as
strings, because a JSON number is an IEEE-754 double and silently loses
precision above 2^53.

**Two Postgres traps this codebase hits.** `node-postgres` returns `BIGINT` as a
string, so `pool.ts` installs an int8 parser; and `SUM()` over `BIGINT` returns
`NUMERIC`, which that parser does not cover, so the reconciliation queries cast
back with `::BIGINT`. Both produce wrong answers rather than errors.

**No build step.** Node 26 strips TypeScript types at runtime, so `tsc` is only
a type checker here and there is no bundler or `dist/`. `erasableSyntaxOnly` is
enabled so the compiler rejects syntax that runtime stripping cannot handle
(enums, namespaces, parameter properties) rather than letting it fail in
production.

**Container users are uid 1000.** Both the `node` and `foundry` images run as
uid 1000, matching the host user, so bind-mounted files keep their ownership
instead of turning up root-owned.

**Fixed dependency versions live in the lockfile**, and `solc` is pinned in
`contracts/foundry.toml` so bytecode is reproducible.

## Secrets

`.env` is gitignored and holds local development defaults only. No private key,
mnemonic or API key ever belongs in this repository.

`WALLET_XPUB` is an extended *public* key and is safe to deploy: it derives
deposit addresses and cannot move funds. The default in `.env.example` belongs
to the public Foundry test mnemonic. Generate your own with `./wallet keygen`,
and keep the mnemonic it prints offline -- it is never written to disk, and
losing it loses the funds. The anvil mnemonic in
`docker-compose.yml` is the well-known public Foundry test mnemonic and controls
nothing of value.

Production key material belongs in a KMS or HSM. See the key management section
in [PROJECT.md](PROJECT.md).
