# Custodial Wallet with a Path to Self-Custody

A hybrid crypto wallet: an off-chain double-entry ledger for instant internal
transfers, on-chain settlement for deposits and withdrawals, an M-of-N multi-sig
vault for reserves, and ERC-4337 smart accounts so users can graduate to real
self-custody without the risk of losing a seed phrase.

**Status:** P1 — off-chain ledger complete. See [Roadmap](#part-iii--roadmap).

---

## Part I — The Problem

### Crypto forces users to pick one of two bad options

|                      | Custodial (exchange holds funds)  | Self-custody (user holds keys)      |
| -------------------- | --------------------------------- | ----------------------------------- |
| Onboarding           | Email + password, 30 seconds      | Write down 12 words, learn gas       |
| Losing access        | Password reset                    | **Funds gone forever, no recourse**  |
| Counterparty risk    | Platform insolvency wipes you out | Nobody can take your funds           |
| Internal transfer    | Free and instant                  | Gas on every transfer, wait for confirmation |

Newcomers cannot start with self-custody: the barrier is too high and mistakes
are irreversible. But staying custodial forever repeats Mt. Gox, Celsius and FTX.

### Thesis: custody should be a dial, not a switch

Users move through three tiers at their own pace.

```
  Tier 1: STARTER            Tier 2: SMART               Tier 3: SOVEREIGN
  ---------------            -------------               -----------------
  Platform holds funds       User holds funds via        User holds funds
  (omnibus ledger)           a smart account             outright
                      -->                          -->
  - Email login              - ERC-4337 account          - Any external address
  - Free instant             - Social recovery           - Platform retains
    internal transfers       - Paymaster pays gas          no control at all
  - Gas is invisible         - Scoped session keys
  - Must TRUST platform      - Platform CANNOT
                               touch the funds

  ===================== Platform reserves =====================
                 Multi-sig vault (M-of-N + timelock)
        The platform itself cannot unilaterally move funds
```

The two contract layers each solve one half of the trust problem:

- **ERC-4337** solves the user side — *hold your own funds without the risk of
  losing your key*. This removes the only real reason to stay custodial.
- **Multi-sig vault** solves the platform side — *while you are in Tier 1, your
  funds sit somewhere even we cannot drain on our own*. "Trust us" becomes a
  constraint enforced by code.
- **Proof of Reserves** ties both together: at any moment, prove that on-chain
  assets are greater than or equal to total liabilities owed to users.

### One-paragraph statement

> Beginners cannot safely hold their own keys, and experienced users should not
> have to trust an exchange. This project builds the road between those two
> points: start with a custodial experience that is genuinely easy to use,
> graduate to a self-custodied smart account with social recovery, and for as
> long as the platform does hold funds, keep them in a multi-sig vault backed by
> publicly verifiable proof of reserves.

Background context: international remittance still costs around 6% and takes
days, while a stablecoin transfer on an L2 costs cents and settles in seconds.
The gap is not the rails — it is the user experience of custody.

### Scope and legal note

This is a **learning and research project**. It runs on **testnet only** and must
never hold third-party funds. Operating a real custody service requires a license
in essentially every jurisdiction, and using crypto as a means of payment is not
legal in Vietnam. Testnet still produces real reorgs, real nonce races and real
finality, so none of the engineering value is lost.

---

## Part II — Architecture

### II.1 System overview

```
                            +------------------+
                            |     Frontend     |
                            +--+------------+--+
              REST + JWT       |            |   signs UserOperation locally
         +---------------------+            +------------+
         v                                               v
+------------------+                            +------------------+
|   API server     |                            |     Bundler      |
|  (holds no keys) |                            |  (alto/rundler)  |
+----+--------+----+                            +--------+---------+
     |        |                                          |
     |        | request gas sponsorship                  | handleOps()
     |        v                                          |
     |   +------------------+                            |
     |   | Paymaster service|---- signs EIP-712 ---+     |
     |   |  (policy engine) |                      |     |
     |   +------------------+                      |     |
     v                                             |     |
+-----------------+                                |     |
|    Postgres     |<-----+                         |     |
| off-chain ledger|      |                         |     |
|  (double-entry) |      |                         |     |
+-----------------+      |                         |     |
     ^        ^          |                         |     |
     |        |          |                         |     |
+----+-----+ ++----------+--+  +------------------+ |    |
| Indexer  | | Withdrawal   |  | Vault signer     | |    |
| (scanner | |  worker      |  |  service         | |    |
| + reorg) | | (nonce mgr)  |  | (collects sigs)  | |    |
+----+-----+ +------+-------+  +--------+---------+ |    |
     |              |                   |           |    |
     | eth_getLogs  | sendRawTx         | execute   |    v
     v              v                   v                v
=================== Base Sepolia / Anvil ======================
                              |
   +--------------+-----------+------------+--------------+
   v              v           v            v              v
+--------+  +----------+ +---------+ +----------+ +------------+
| Hot    |  | Deposit  | |Multisig | |EntryPoint| | Paymaster  |
| wallet |  |addresses | |  Vault  | |(singleton| | contract   |
| (EOA)  |  | (HD)     | | M-of-N  | |          | | + deposit  |
+--------+  +----------+ +---------+ +----+-----+ +------------+
                                          | validateUserOp / execute
                                          v
                                   +--------------+
                                   | SmartAccount |  <- Tier 2 user wallet
                                   |  + Factory   |
                                   +--------------+
```

**Key separation:** the API server holds **no private keys at all**. It only has
an extended public key (xpub) used to derive deposit addresses. Keys live in the
withdrawal worker (hot, encrypted) and with the multi-sig signers (cold, offline).
Compromising the API server does not lose funds.

### II.2 Money flow per tier

| Flow                        | Path                                             | Mechanism                          |
| --------------------------- | ------------------------------------------------ | ---------------------------------- |
| Deposit                     | chain -> deposit address -> indexer -> ledger     | HD wallet, finality check          |
| Internal transfer (T1 <-> T1) | Postgres only                                  | Double-entry, free, instant        |
| Withdrawal                  | ledger -> withdrawal worker -> hot wallet -> chain | Nonce manager, idempotency         |
| Sweeping                    | deposit addresses -> hot wallet                  | Gas funding + threshold            |
| Reserve rebalancing         | hot wallet <-> multi-sig vault                    | M-of-N signatures, EIP-712         |
| **Graduation T1 -> T2**     | ledger -> vault/hot -> SmartAccount              | The bridge between both worlds     |
| Tier 2 activity             | user signs UserOp -> bundler -> EntryPoint -> SmartAccount | Paymaster sponsors gas   |

### II.3 The hard problems

These are the parts worth building. Everything else is plumbing.

#### Chain reorganisation

A deposit is observed in block N, credited, and withdrawn. Then the chain
reorganises, block N is replaced, and the deposit never existed. Real money lost.

Post-Merge Ethereum has actual finality, and JSON-RPC exposes the `safe` and
`finalized` block tags (finalized is roughly two epochs, about 13 minutes).

```
seen in a non-finalized block  -> write ledger entry, status = PENDING
                                  (available balance does NOT increase)
block is finalized             -> status = CONFIRMED, withdrawal allowed
block disappears first         -> write reversing entry, status = REORGED
```

This is why every real exchange distinguishes **available** from **pending**
balance. The indexer must persist `last_scanned_block` to resume after restart,
and re-verify the block hashes of the most recent N blocks on every pass.

#### Nonce management

Every transaction from the hot wallet carries a sequentially increasing nonce.
If two workers both call `eth_getTransactionCount` and both receive `42`, they
sign two transactions with the same nonce. The node accepts one; the other is
treated as a replacement and rejected for not raising gas by at least 10%. A
user withdrawal silently disappears.

Worse: if the transaction at nonce 42 gets stuck with too low a gas price, every
transaction at 43, 44, 45 queues behind it and withdrawals freeze entirely.

Allocate nonces from the database under a lock, never from the node:

```sql
BEGIN;
SELECT next_nonce FROM hot_wallets WHERE id = 1 FOR UPDATE;
UPDATE hot_wallets SET next_nonce = next_nonce + 1 WHERE id = 1;
COMMIT;
```

Plus a stuck-transaction job: not mined after 5 minutes, resubmit with the **same
nonce** and `maxFeePerGas` raised by at least 10% (speed-up). To cancel, send a
zero-value self-transfer at that nonce.

#### Concurrency in the ledger

Classic lost update: a wallet holds 100k, two withdrawals of 100k arrive
simultaneously, both read the balance before either writes, both succeed.

Use `SELECT ... FOR UPDATE`. To avoid deadlock when A pays B while B pays A,
**always lock accounts in a fixed order** (ascending account id):

```
first, second = sorted([from_account_id, to_account_id])
lock(first); lock(second)
```

#### Idempotency

Users retry, mobile clients retry on timeout. Every money-moving `POST` requires
an `Idempotency-Key` header stored under a `UNIQUE` constraint. The database
constraint is what guarantees correctness — an application-level `if exists`
check is itself racy.

#### Sweeping and the gas problem

USDC accumulates across hundreds of deposit addresses. Moving it requires calling
`transfer()`, which requires native ETH for gas — and those addresses hold only
USDC. So: fund the address with a little ETH from the hot wallet, then sweep, and
only when the balance exceeds a threshold that makes the gas worth spending.

#### Key management

| Tier          | Holds                            | Where                                  |
| ------------- | -------------------------------- | -------------------------------------- |
| Cold          | Majority of funds                | Offline keys, manual signing           |
| Hot           | ~5%, enough for daily withdrawals | Encrypted, readable only by the worker |
| API server    | Nothing                          | xpub only                              |

Plus daily withdrawal limits and manual approval above a threshold. For a
learning project, encrypting with a master key from the environment is
acceptable — but the README must state that production requires a KMS or HSM.

#### Proof of Reserves

```
Invariant:  balanceOf(hot) + balanceOf(vault)  >=  SUM(user balances in ledger)
                    ^ read from chain                    ^ read from Postgres
```

Run every 5 minutes and alert on divergence. Then build a Merkle tree of user
balances and publish the root hash, so each user can fetch their own Merkle proof
and verify their balance is included in the published total without revealing
anyone else's.

### II.4 Repository layout

```
wallet/
|-- contracts/                  # Foundry
|   |-- src/
|   |   |-- vault/MultisigVault.sol
|   |   |-- account/SmartAccount.sol      # IAccount
|   |   |-- account/AccountFactory.sol    # CREATE2
|   |   |-- account/GuardianModule.sol    # social recovery
|   |   |-- account/SessionKeyModule.sol
|   |   +-- paymaster/VerifyingPaymaster.sol
|   +-- test/                             # includes deliberate attack tests
|-- services/
|   |-- api/                    # REST, JWT, ledger
|   |-- indexer/                # block scanning, reorg handling
|   |-- withdrawal/             # nonce manager
|   |-- paymaster/              # sponsorship policy + signing
|   |-- vault-signer/           # EIP-712 signature collection
|   +-- reserves/               # proof of reserves job
|-- packages/shared/            # ABIs, types, chain config
|-- db/migrations/
+-- web/
```

---

## Part III — Roadmap

The ordering is deliberate: **multi-sig comes before ERC-4337**. Multi-sig
teaches EIP-712 signature verification in its simplest form, and `validateUserOp`
in ERC-4337 reuses exactly that knowledge. Doing it the other way round is twice
as hard.

Total is roughly 13–15 weeks part-time. Every phase is independently
demonstrable.

### Track A — Backend foundation (weeks 1–5)

| Phase  | Work                                                                                                          | Demo                                                                | Days |
| ------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---- |
| ~~**P0**~~ | Monorepo, Foundry + anvil, Postgres, CI running `forge test` and backend tests, everything in Docker            | Done: `./wallet up` brings the whole stack up locally               | 2    |
| ~~**P1**~~ | Off-chain ledger: double-entry, accounts, idempotency keys, `SELECT FOR UPDATE`, ordered locking                | Done: interleaved-transaction test fails without the lock; `SUM = 0` holds | 5 |
| **P2** | HD wallet (BIP-44), derive addresses from xpub, API server never touches a private key                          | Every user gets a deposit address; no keys in the database          | 3    |
| **P3** | Indexer: scan blocks, catch USDC `Transfer` events, resume from `last_scanned_block`                            | Send USDC on anvil -> balance appears in the app                    | 5    |
| **P4** | **Reorg + finality**: pending vs available balance, `finalized` block tag, re-verify recent block hashes, reversing entries | `anvil_reorg` -> deposit rolls back correctly, ledger stays balanced | 4    |

> **Safe stopping point #1** (week 4) — already a strong project.

### Track B — Withdrawals and operations (weeks 5–7)

| Phase  | Work                                                                                                        | Demo                                                        | Days |
| ------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---- |
| **P5** | Withdrawal worker: DB-allocated nonces under lock, `PENDING -> SUBMITTED -> CONFIRMED` state machine, stuck-tx replacement (same nonce, +10% gas) | 20 concurrent withdrawals -> contiguous nonces, no gaps, no duplicates | 5 |
| **P6** | Sweeping: gas funding for deposit addresses, gas-price-aware thresholds, batching                            | Automatic consolidation from 50 addresses into the hot wallet | 3    |

### Track C — Multi-sig vault (weeks 7–9)

| Phase  | Work                                                                                                                                   | Demo                                            | Days |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---- |
| **P7** | `MultisigVault.sol`: M-of-N owners, EIP-712 domain including `chainId` and `verifyingContract`, replay-protecting nonce, `ecrecover` with signers **sorted ascending and unique** | `forge test` green, coverage above 90%          | 5    |
| **P8** | **Attack tests** — one test per real vulnerability, each proving the contract blocks it: same signature submitted M times, signature malleability (high `s`), cross-chain replay, reentrancy in `execute`, empty owner set / zero threshold | A dedicated test file where every case is a real CVE | 3 |
| **P9** | Vault signer service: propose a transaction, collect signatures off-chain over REST, submit once the threshold is met; timelock for large amounts; automatic hot/cold rebalancing | Withdrawing 10k USDC requires 3 of 5 approvals   | 5    |

> **Safe stopping point #2** (week 9) — backend plus Solidity, enough for most roles.

### Track D — ERC-4337 Account Abstraction (weeks 9–13)

> **Pin the EntryPoint version up front and never change it.** The
> `UserOperation` struct differs between v0.6, v0.7 and v0.8 and they are not
> compatible. Blog posts mixing versions are the single biggest source of bugs
> here — read the EntryPoint source directly.

| Phase   | Work                                                                                                                                        | Demo                                                    | Days |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---- |
| **P10** | `SmartAccount.sol` implementing `IAccount.validateUserOp()` plus `AccountFactory` using CREATE2 (counterfactual address, lazy deploy on first use). Run a local bundler against anvil | First UserOperation goes through the bundler             | 6    |
| **P11** | `VerifyingPaymaster`: off-chain signed sponsorship, staked deposit in the EntryPoint, backend policy engine (per-user daily caps, allowed selectors only) | A user with **zero ETH** transfers USDC successfully     | 5    |
| **P12** | Social recovery: guardian set, owner-rotation proposal with a **timelock** (e.g. 48h) to blunt guardian collusion, plus emergency cancel     | Key lost -> three guardians restore access after timelock | 5    |
| **P13** | Session keys: scoped secondary keys (expiry, allowed selectors, spending cap). Mind the **ERC-7562 validation rules** — `validateUserOp` may not touch out-of-scope storage or certain opcodes, or bundlers reject the UserOp | A 24h session key that can only call `transfer`          | 4    |

### Track E — Integration and polish (weeks 13–15)

| Phase   | Work                                                                                                                                                       | Demo                                                          | Days |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---- |
| **P14** | **Graduation flow** — "upgrade to self-custody": deploy a SmartAccount via the factory, transfer funds on-chain from vault/hot, write the liability-reducing ledger entry, and handle a failed on-chain transfer by rolling the ledger back correctly | One button moves a user from Tier 1 to Tier 2 with real ownership transfer | 5 |
| **P15** | Proof of Reserves: compare `balanceOf(hot) + balanceOf(vault)` against total liabilities; Merkle tree of user balances, published root, per-user proof endpoint | A user independently verifies their balance is in the published total | 4 |
| **P16** | Frontend, README, architecture diagram, threat model, security review pass over the contracts                                                                | A stranger understands the repo in five minutes                | 5    |

### Timeline

```
Week  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15
      |--A---------|
                   |--B----|
                           |--C------|
                                     |--D----------|
                                                   |--E---|
      +---- stop #1      +---- stop #2         +-- complete
```

**If time runs short** (about 9 weeks): drop P6 (sweeping), P13 (session keys),
and ship the paymaster as sponsor-everything with no policy engine. Never drop
P4 (reorg), P5 (nonce), P8 (attack tests) or P15 (proof of reserves) — those four
are what make this project different from every other exchange clone.

### The four things that lead the README

1. A test that induces a reorg on anvil and proves the indexer loses no money.
2. A test firing 20 concurrent withdrawals proving no nonce collision.
3. A multi-sig attack test file where every case is a vulnerability that has
   drained real funds.
4. Proof of Reserves with a Merkle proof any user can verify themselves.

//
