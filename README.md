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

**Current status: P9 complete — the multisig vault in operation.** A proposal to
move reserves is opened through the API, owners sign the EIP-712 typed data it
returns with their own wallets, and a separate worker submits it once a quorum
exists. The vault enforces an on-chain timelock: anything but a small
hot-wallet top-up is queued and waits out a delay, during which any single
owner can cancel it, and the submitter carries a proposal through the queue.
The hot wallet is kept inside a band automatically: a top-up is proposed to the
vault's owners when it runs low, and the excess goes back when it holds too
much.

**P10 complete — ERC-4337 smart accounts.** A user's `SmartAccount` exists at a
known address before it is deployed, and its first UserOperation -- sent through
a real bundler to the canonical EntryPoint v0.8 on the local chain -- deploys it
and moves funds in one step.

**P11 complete — a paymaster, so users need no ether.** An account that has
never held ether deploys itself and pays USDC through the real bundler, its gas
paid by `VerifyingPaymaster` on the strength of a sponsorship the platform's
ERC-7677 service signed after checking its policy.

**P12 complete — social recovery.** An owner who loses their key is restored by
a quorum of guardians they chose: guardians approve over the API from their own
wallets, a relayer starts the recovery, and after a 48-hour delay -- in which
the owner or the guardians can cancel -- hands the account to the new key, which
then drives it through the bundler. Next is P13, session keys.

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
| `./wallet test-node [core\|chain\|vault\|aa]` | Backend tests, all or one group (CI runs the groups in parallel) |
| `./wallet coverage` | Solidity coverage for contracts under `src/`           |
| `./wallet typecheck`| Type-check the workspace                               |
| `./wallet keygen`   | Generate an HD wallet offline (prints a mnemonic once)  |
| `./wallet deploy-token` | Deploy the devnet ERC-20 and print its address     |
| `./wallet indexer`  | Watch the chain and credit deposits                    |
| `./wallet withdrawer` | Sign and broadcast payouts (holds the spending key)  |
| `./wallet sweeper`  | Consolidate deposit addresses into the hot wallet       |
| `./wallet vault-submitter` | Submit vault proposals that have reached quorum |
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

## Watching a deposit arrive

```bash
./wallet up
./wallet deploy-token          # prints USDC_ADDRESS=0x...; paste it into .env
./wallet indexer               # in another terminal

ACCOUNT=$(curl -s -X POST localhost:3000/api/v1/users \
    -H 'content-type: application/json' -d '{"email":"a@example.com"}')
echo "$ACCOUNT"                # note depositAddress and accountId

# Send tokens to that deposit address, then watch the balance.
./wallet cast "send $USDC_ADDRESS 'mint(address,uint256)' <depositAddress> 250000000 \
    --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

curl -s localhost:3000/api/v1/accounts/<accountId>
```

The deposit appears first as `pendingBalance` and moves into `balance` once its
block is final. Raise `FINALITY_CONFIRMATIONS` to watch it sit in pending for
longer.

Note that `./wallet restart` restarts anvil too, and a devnet keeps no state:
every deployment is lost and `USDC_ADDRESS` has to be set again.

## Paying out on chain

```bash
./wallet cast "wallet new"     # a throwaway devnet key; put it in HOT_WALLET_PRIVATE_KEY
./wallet up                    # `restart` does NOT re-read .env; `up` recreates
./wallet withdrawer            # in another terminal

curl -s -X POST localhost:3000/api/v1/payouts -H 'content-type: application/json' \
    -H 'Idempotency-Key: p1' \
    -d '{"accountId":"5","to":"0x...","amount":"320000000"}'
```

The balance drops immediately and appears as `reservedBalance` until the chain
settles it. The hot wallet needs both the token and some native currency for
gas.

## What P12 demonstrates

A smart account with one owner is lost with its key: nothing can be upgraded,
and nobody can step in. **Social recovery** lets the owner name guardians in
advance -- friends, a second device, the platform -- a quorum of whom can hand
the account to a new key:

```
guardians sign (3 of 5) -> initiateRecovery(newOwner) -> 48h -> executeRecovery() -> new owner
                                                          |
                                                          +- the owner (key still works) or a
                                                             guardian quorum may cancel
```

**The delay is what stops colluding guardians.** If the owner still has the
key, the recovery was never needed, and they have 48 hours to veto it with a
signed operation. A test has three guardians try to take the account and the
owner cancel. Guardians can also withdraw a recovery they started, by the same
quorum signing over its nonce -- so that cancellation cannot be replayed later
against a different recovery.

**A module with exactly one power.** Recovery lives in `GuardianModule`, one
contract serving every account. The account trusts it with `transferOwnership`
and nothing else: not a general module system that could make the account call
anything, which would be a second owner. The owner chooses the module, and can
remove it, only through their own signed operations.

**The vault's signature rules, reused.** Guardians sign EIP-712 approvals
off-chain, so they need no ether; anyone submits them. Exactly a quorum,
strictly ascending by signer, bound to the account, the chain and a nonce that
every recovery, cancellation and change of guardians spends. Changing guardians
also cancels a recovery in progress, so approvals from removed guardians cannot
complete it. A matured recovery lapses after seven days.

**What it does not do.** Recovery protects against a lost key, not a stolen one:
a thief with the key can move the funds at once, without waiting for anyone.

**What testing found.** Removing the nonce increment when a recovery starts
survived every test: the approvals' one-hour deadline expired before the 48-hour
delay ended, so expiry masked the gap. With a long deadline, the same approvals
could start a second recovery after the first completed. A test now holds
approvals to a single use. And `forge coverage` compiles without the optimiser:
the account had grown enough that deploying it from initCode ran out of the
test helper's verification gas, which first looked like a collapse in coverage.

Coverage is 100% for every contract; fifteen mutations to the recovery
defences each fail a test.

### Approvals over the API, and a relayer

```
POST /api/v1/recovery/requests                   open a request; returns the typed data guardians sign
POST /api/v1/recovery/requests/:id/approvals     a guardian's approval
POST /api/v1/recovery/requests/:id/cancellation  open a guardians' cancellation of a started recovery
POST /api/v1/recovery/requests/:id/cancellations a guardian's vote to cancel
GET  /api/v1/recovery/requests/:id               status, signers, executable time
./wallet recovery-relayer                         starts, executes and cancels on chain
```

**Several requests may collect at once.** Anyone may open a request -- only
guardian signatures count -- so "one open request per account" would let a
stranger block a genuine recovery with a bogus one until its deadline passed.
Whichever request starts first spends the module's nonce; the rest become
`STALE`, which a test shows with two competing requests.

**The relayer's key only pays gas.** Guardians' signatures authorise every step,
and the module checks them again on chain. It is still a key, so it runs apart
from the API and is checked against every other signer.

**The module is the record.** A veto the owner sends from their own wallet, or a
cancellation guardians submit themselves, never passes through the relayer; it
reads the module's pending recovery every pass and notices it is gone. A moved
nonce is checked against the module before a request is called stale, so a
start whose receipt was lost is recognised -- the same lesson as the vault's.

**After recovery the account keeps its address.** The factory derives addresses
from the owner an account was created with, so the account adapter takes an
explicit address for an account whose owner has since changed; a test has the
new key send a UserOperation through the bundler.

Mutation testing covers the relayer and the request checks as well as the
contracts.

## What P11 demonstrates

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

### The sponsorship service

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
  whatever a call does, `approve` to a stranger included;
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

## What P10 demonstrates

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

### Through a real bundler

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

**Safe mode is off locally, and that is a known gap.** Alto enforces ERC-7562 --
what `validateUserOp` may read and write -- by tracing every operation, and
anvil lacks the tracer it needs. Those rules go unchecked here; P13's session
keys are where they start to matter, and tests will have to cover them.

**Nonces run in one sequence.** An ERC-4337 nonce is a 192-bit key plus a
64-bit sequence. viem draws a fresh time-based key for every operation by
default, so each is first in its own sequence and they may land in any order.
For a wallet, where one payment can depend on the one before, the account
adapter pins the key to 0. A test caught this: the second operation's nonce came
back as a timestamp, not 1.

**A forged signature never reaches the chain.** The bundler simulates before
accepting, the account reports the bad signature, and the operation is refused
with `AA24` -- nothing deployed, nothing spent.

## What P9 demonstrates

**The digest is computed off-chain and checked against the contract.** Owners
sign what the service computes, and a test compares it to the vault's own
`hashExecute`. If they ever disagreed, every signature collected would be
rejected on submission -- after the owners' time had already been spent.

**Every check the vault makes is repeated before a signature is accepted.**
Signer must be an owner, must not have signed already, and the signature must be
65 bytes with `s` in the lower half. Skipping any of them would not make the
vault unsafe -- it would still refuse -- but a proposal would look ready when
its submission was certain to fail.

**Proposals are tied to a vault nonce.** Every execution consumes one, so a
proposal is valid for exactly one position in the queue. Only one may collect
per nonce, and one whose nonce the vault has moved past is marked stale: those
signatures can never be used, however many times they are retried.

**There is no "failed" state.** A reverted `execute` reverts the vault's nonce
too, so the approval stays valid and can be resubmitted until its deadline.

**Wei does not fit in a BIGINT.** Postgres BIGINT tops out near 9.22 * 10^18,
about 9.22 ether, so a ten-ether reserve transfer would overflow it. The value
column is `NUMERIC(78, 0)`, wide enough for any uint256, and a test moves ten
ether through it.

**Deadlines are measured in chain time.** The vault compares against
`block.timestamp`, so that is the clock the service consults, and tests reach a
deadline with `evm_increaseTime` rather than by sleeping.

**Recording a status and raising an error are separate steps.** The first
version marked a proposal stale inside a transaction and then threw, which
rolled the mark back: the caller heard "stale" while the row still said
"collecting". The status now commits first. The same mistake was in the expiry
path, which had no test until this was found.

Mutation checks confirm each of those guards is load-bearing: removing the
low-s check, the owner check, the signer sort, or the nonce check each fails a
test, as does putting the expiry throw back inside the transaction.

### Over HTTP

| Endpoint | Purpose |
| -------- | ------- |
| `POST /api/v1/vault/proposals` | Open a proposal; returns the `eth_signTypedData_v4` JSON for owners |
| `GET /api/v1/vault/proposals/:id` | Status, signers so far, and the typed data for late signers |
| `POST /api/v1/vault/proposals/:id/signatures` | An owner submits a signature |
| `POST /api/v1/vault/proposals/:id/retry` | Hand a failed proposal back to the submitter |

**There is no submit endpoint.** Submitting costs gas, so it needs a key, and
the API server holds none. `./wallet vault-submitter` submits whatever has
reached its quorum. Its key only pays gas -- the owners' signatures authorise
the transfer -- but it is refused if it equals the hot wallet's key, whose
nonces the withdrawal worker allocates itself.

**The routes need no login to be safe.** Anyone may propose; a signature is
accepted only if it recovers to a vault owner, and the vault checks every one
again on chain. A real deployment would still put proposing behind
authentication, to keep the queue free of noise.

**A failed submission is not retried automatically.** Whatever made the vault
revert -- usually too little balance -- will still be true a few seconds later,
and a worker that kept trying would spend gas every pass to learn nothing. The
reason is recorded on the proposal and a person clears it with `/retry`.

**A lost receipt is not mistaken for a stale proposal.** If the submitter
broadcasts and then loses its connection before recording the hash, the next
pass finds the vault's nonce moved. Before calling the proposal stale it looks
for the vault's `Executed` event at that nonce, and if the call matches, records
the proposal as executed with that transaction.

**Integers travel as strings, including in the typed data.** A wei amount does
not survive a JSON number, and a test hashes the JSON exactly as a wallet would
receive it and compares it to the contract's own digest.

### The timelock

Whoever steals a quorum of keys could empty a plain multisig in one
transaction. The vault now refuses to do that at once:

```
                    +- hot-wallet top-up within today's allowance -> execute now
quorum of owners ---+
                    +- anything else -> queue -> wait `delay` -> executeQueued
                                           |
                                           +- any ONE owner may cancel meanwhile
```

**It is enforced on chain.** A delay kept by the backend protects nothing: a
thief holding the keys calls the contract directly.

**One owner can cancel.** If a thief holds a quorum, the honest owners left are
by definition fewer than one. A cancel that needed a quorum would never come.
The price is that a rogue owner can stall calls -- stall, never move funds.

**The fast path recognises exactly two shapes:** ether to the hot wallet, and a
token's own `transfer(hotWallet, amount)` with no ether attached and no trailing
bytes. `approve`, `transferFrom`, transfers to anyone else, and every call to the
vault itself wait. Each token has its own daily allowance.

**Allowances are daily, not per call.** A per-call cap only changes how many
transactions a thief needs; a test splits a drain into fifty small top-ups and
gets exactly one day's allowance out.

**Configuration goes through the timelock too.** Changing the hot wallet, an
allowance or the delay is a call the vault makes to itself, which is never
fast-path. A thief cannot raise the allowance and use it in the same breath.

**A queued call does not block the queue.** The nonce is spent when a call is
queued, so a payout waiting out its delay does not hold up the top-ups behind
it. A queued call expires 14 days after it matures.

**A delay of zero switches the timelock off** -- which is how the older suites
deploy it, so they keep testing the multisig on its own.

**The backend asks the vault rather than copying its rules.** The submitter
tries `execute`; if the vault answers `TimelockRequired`, it queues instead. A
second copy of the fast-path rules in TypeScript could only ever disagree with
the contract. A queued proposal then moves through the same worker:

| Status | Meaning |
| ------ | ------- |
| `QUEUED` | The vault spent the nonce and holds the call until `eta` |
| `EXECUTED` | `executeQueued` ran it after the delay |
| `CANCELLED` | An owner cancelled it on chain |
| `EXPIRED` | Nobody executed it within the 14-day grace period |

**Cancelling is an owner's own transaction.** The vault accepts `cancel` only
from an owner, and the backend holds no owner key, so `GET` on a queued proposal
returns the exact call to send from an owner's wallet. The submitter checks the
vault's queue on every pass and records the cancellation when the entry is gone.

**A lost receipt is recognised for queueing too.** If the vault's nonce moved
and it holds a `Queued` event for this proposal's call, the proposal is
recorded as queued with that transaction, not as stale.

Coverage stays at 100% of lines, statements, branches and functions. Of fourteen
mutations to the new defences, thirteen fail a test outright. The fourteenth --
dropping the reentrancy guard from `executeQueued` -- survives because the
queued entry is already deleted before the external call; removing both fails
the reentrancy attack test, so each layer holds on its own.

### Hot/cold rebalancing

The hot wallet's key is online, so what it holds is what a breach costs; but a
hot wallet that runs dry stalls every payout. Rebalancing keeps its
*available* balance -- on chain, minus payouts already promised -- inside a
band set by three marks:

```
  above HIGH  -> the withdrawal worker returns the excess to the vault
  ---- TARGET   (where a rebalance in either direction lands)
  below LOW   -> the vault submitter proposes a top-up for owners to sign
```

**Two marks, not one.** A balance hovering around a single threshold would
rebalance on every pass, each time costing gas or an owner's signature.
Between LOW and HIGH nothing happens.

**A top-up is proposed, never signed.** Moving reserves out of the vault takes
owners' signatures; a process signing for them would make the multisig a
formality. The proposal is sized to the vault's daily fast-path allowance, so
the signatures are all it takes -- no timelock wait while payouts stall. It is
refused outright if the vault's `hotWallet()` is not the account the withdrawal
worker registered.

**A return rides the payout machinery.** Sending from the hot wallet needs the
hot wallet's key, and only the withdrawal worker may use it. So the return is a
`chain_withdrawals` row of kind `REBALANCE`, getting the same nonce allocation,
stuck replacement and abandonment as a payout -- but no account and no ledger
entries, which the schema enforces both ways. The platform moving its own
tokens changes nobody's balance.

**Reconciliation had to learn the difference.** It compared every in-flight
withdrawal against `PENDING_WITHDRAWALS`. A rebalance reserves nothing there, so
counting it would report a healthy ledger as unbalanced; a test checks the
ledger reconciles while a return is in flight. Seven mutations to these
defences each fail a test.

## What P8 demonstrates

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

## What P7 demonstrates

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

## What P6 demonstrates

**Deciding and acting are separate.** The planner reads balances and returns a
verdict per address. Nothing signs, so the decision can be inspected -- and got
wrong -- without moving anyone's funds.

**Sweeping dust destroys value.** An ERC-20 transfer costs gas whether it moves
a million tokens or five, so below a threshold the tokens are better left where
they are. Judging that properly means comparing a token amount against a
native-currency cost, which needs a price feed this project does not have; the
threshold is the honest stand-in, and the estimate is reported so an operator
can revisit it.

**A deposit address cannot pay its own way.** It receives tokens and nothing
else, so it holds no native currency and the sweep costs two transactions: fund
it, then transfer. The estimate says which case an address is in.

**Tests get their own derivation range.** The chain outlives the database, so a
test that funds an address leaves it funded for every later run. A fixed index
made the suite pass once and fail from the second run onward, which is how this
was found.

**The sweeper holds the mnemonic, so it runs nowhere near the API.** Moving
funds that have arrived at a deposit address requires the key for that address,
which means the phrase every deposit address is derived from. That is the most
dangerous secret in the system, so it lives in its own process -- the API server
still holds nothing that can spend.

**Every signing process has its own account.** The sweeper first paid gas
from the hot wallet, letting the node pick the nonce, while the withdrawal
worker handed out the same account's nonces from the database. Running both,
a gas funding could take a nonce a payout had been promised, and the payout
failed for no reason it could explain. The sweeper now pays gas from
`GAS_FUNDER_PRIVATE_KEY`, and the withdrawer, sweeper and vault submitter all
refuse to start if any two of their keys are the same account. As a side
effect the sweeper no longer holds a key that can spend the hot wallet's
tokens: it reads the hot wallet's address from the row the withdrawal worker
registered, and warns when fewer than ten gas fundings are left.

**A mismatched mnemonic is caught before anything is signed.** A phrase that
does not match the deployed xpub derives a perfectly valid key for a completely
different address. Signing would succeed, the transaction would be accepted, and
the tokens would sit untouched while the wallet reported success. Every
derivation is checked against the address the xpub produced; removing that check
fails a test.

**Sweeping is stateless, and deliberately so.** It moves tokens between two
addresses the wallet already controls, so no user's balance changes and there is
nothing to record -- the deposit was credited when it arrived, and where the
tokens physically sit afterwards is a custody detail. Re-reading balances every
pass makes a crash halfway harmless: the next run simply picks up what is left.

**One failing address does not strand the rest.** A single unsweepable deposit
holding up every other user's funds would be worse than the failure itself, so
failures are collected and reported rather than thrown.

**Nonces come from the database, not the chain.** Two workers that both call
`eth_getTransactionCount` receive the same answer, sign two transactions with
the same nonce, and the node keeps one -- the other withdrawal disappears with
no error anywhere. Postgres can serialise the request; the chain cannot.

**Allocation is a single `UPDATE ... RETURNING`.** Postgres holds the row lock
for the duration of one statement, so callers are serialised without explicit
locking. Reading the nonce and writing back `nonce + 1` as two statements
reintroduces exactly the race the table exists to remove, and doing so fails two
of these tests.

**A rollback returns the nonce.** Gaps are worse than duplicates: a nonce that
is allocated but never broadcast blocks every transaction queued behind it.
Allocation therefore happens inside the caller's transaction, so a withdrawal
that fails after allocating does not consume one.

**The counter is never wound backwards.** Running ahead of the chain is normal
while transactions are in flight, and "correcting" it would reissue nonces
already sitting in the mempool. Sync only ever moves forward, for the case where
the key was used by something this database does not know about.

**A successful receipt is not proof that anything happened.** A call to an
address holding no code succeeds trivially -- there is no code to revert -- so a
misconfigured token address produces a healthy receipt with an empty log list
while no tokens move at all. The worker therefore checks the receipt for a
matching `Transfer` event before settling, and the CLI refuses to start if
nothing is deployed at the configured token address. Without that check the
ledger records payouts the chain never made.

**Destination addresses are checksummed at the API boundary.** viem rejects a
mixed-case address with a bad EIP-55 checksum, and it rejects it at signing
time -- deep inside the worker, after a nonce has already been committed to the
row. That transaction can then never be broadcast and every later nonce queues
behind it. Rejecting it with a 400 costs the caller nothing and costs the queue
nothing.

**A withdrawal that cannot be sent is abandoned, not retried forever.** After a
few failed broadcasts the worker spends the nonce on an empty self-transfer,
refunds the user, and lets the queue move. A nonce held by a transaction that
will never exist is the worst state this system can reach.

**Stuck transactions are replaced at the same nonce.** A replacement must reuse
the nonce it is replacing, which is why the nonce lives on the row. The fee is
raised by more than the 10% nodes demand, because one underpriced withdrawal
freezes every later one behind it.

**Funds are debited on request, not on settlement.** They wait in
`PENDING_WITHDRAWALS`, so the same balance cannot be spent twice while a
transaction is in flight, and a refund is always funded -- it moves money out of
a system account rather than inventing it.

## What P4 demonstrates

**Reorgs are induced, not simulated.** `anvil_reorg` rewrites real blocks, so
the tests exercise the same conditions a live chain produces: a height keeps its
number and receives a new hash. Removing the hash comparison from the detector
and leaving a height check in its place fails two of these tests every run.

**Block data must not be cached.** viem holds block reads for its polling
interval by default. That is a good default and precisely wrong here: after a
reorg the cache keeps serving the old hash, so the check compares a stale hash
against itself and concludes nothing changed -- silently leaving deposits from a
replaced block credited forever. `createChainClient` sets `cacheTime: 0` for
every service, and the tests use that same constructor so they cannot pass
against a client configured differently from production.

**Detection reports; reversal acts.** They are separate functions so detection
can be exercised on its own and a bug in reporting cannot move money by itself.

**Reversal takes nothing from anyone.** A reorged deposit is still parked in
`PENDING_DEPOSITS`, so returning it to the gateway touches no user account. This
is the payoff of the two-step deposit introduced in P3.

**A confirmed deposit is not clawed back automatically, and that is deliberate.**
Its funds are in a user account and may already be spent, so an automated
reversal would either fail or push a real person negative. The indexer reports
it for manual review on every pass instead. It should also never happen:
confirmation waits for finality, and a finalised block being replaced means
something far worse than routine churn.

**The cursor rewinds, which is why `advanceCursor` refuses to.** Rewinding is
correct in exactly one situation, so it is a separate, explicitly named
operation that a stale scan result cannot trigger by accident.

**Reconciliation checks where the money is, not just that it sums to zero.** A
reversal that marks a deposit reorged but forgets to move the funds leaves the
total at zero and every cached balance accurate, while the amount stranded in
the system account quietly grows. So reconciliation also asserts that
`PENDING_DEPOSITS` holds exactly what the still-pending deposits are owed --
an invariant that catches a class of bug the first two checks are blind to.

## What P3 demonstrates

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
contracts/          Foundry: devnet mock token now; vault and smart account from P7
db/migrations/      SQL migrations, applied in filename order
docker/             Dockerfiles for the Node and Foundry toolchains
packages/shared/    Shared config, chain definitions, money helpers
services/api/       REST API
  src/db/           Connection pool and the migration runner
  src/ledger/       Double-entry core, idempotency, operations
  src/routes/       HTTP layer
  src/wallet/       Offline key generation (never runs in the server)
  src/chain/        Log scanning, the cursor, finality and the indexer loop
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
