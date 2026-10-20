# How it was built, phase by phase

Each phase added one capability and wrote down what it had to get right: the
decision, the bug the tests found, the mutation that survived until a test
was added for it. The roadmap they follow is in [PROJECT.md](../../PROJECT.md).

| Phase | What it added |
| ----- | ------------- |
| [P1](p01-ledger.md) | A double-entry ledger: row locks in a fixed order, idempotency enforced by the database |
| [P2](p02-hd-wallet.md) | Deposit addresses derived from an xpub; the API never holds a private key |
| [P3](p03-indexer.md) | An indexer that credits a deposit only once its block is final |
| [P4](p04-reorgs.md) | Reorgs: a deposit whose block disappears is reversed, and the cursor rewound |
| [P5 & P6](p05-p06-withdrawals-and-sweeping.md) | Payouts with nonces from the database, stuck transactions replaced, deposit addresses swept |
| [P7](p07-multisig-vault.md) | An M-of-N multisig vault for the reserves, signed with EIP-712 |
| [P8](p08-attack-tests.md) | Twelve attacks that have drained real multisigs, each one refused |
| [P9](p09-vault-operations.md) | Proposals over the API, a timelock, and the hot wallet kept in a band |
| [P10](p10-smart-accounts.md) | ERC-4337 smart accounts through a real bundler |
| [P11](p11-paymaster.md) | A paymaster, so users need no ether, with a policy and a daily cap |
| [P12](p12-social-recovery.md) | Guardians who can hand a lost account to a new key, after 48 hours |
| [P13](p13-session-keys.md) | Session keys bounded in time, scope and spend; ERC-7562 enforced |
| [P14](p14-graduation.md) | Graduation: a custodial balance moved to an account only its user controls |
| [P15](p15-proof-of-reserves.md) | Proof of reserves: a Merkle sum tree, its root published on chain |

P16 added sign-in, the frontend, the [security review](../security-review.md)
and the [threat model](../threat-model.md).
