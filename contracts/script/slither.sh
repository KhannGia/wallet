#!/bin/sh
# Static analysis with Slither, run by `./wallet slither` inside Trail of
# Bits' own image.
#
# Slither reads foundry.toml and then calls forge, which that image lacks, so
# it runs over a directory holding only src/ and lib/, compiling each contract
# with the same solc and optimiser settings as forge. Findings are triaged in
# docs/security-review.md; the run is not a CI gate, since most of what it
# reports is by design and says so there.
set -eu

export PATH=/app/bin:$PATH
solc-select install 0.8.35 >/dev/null
solc-select use 0.8.35 >/dev/null

REMAPS="@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/ account-abstraction/=lib/account-abstraction/contracts/"

for contract in \
    src/vault/MultisigVault.sol \
    src/aa/SmartAccount.sol \
    src/aa/AccountFactory.sol \
    src/aa/VerifyingPaymaster.sol \
    src/aa/GuardianModule.sol \
    src/reserves/ReservesRegistry.sol; do
    echo "=== $contract"
    slither "$contract" \
        --compile-force-framework solc \
        --solc-remaps "$REMAPS" \
        --solc-args "--optimize --optimize-runs 200" \
        --filter-paths "lib/" || true
done
