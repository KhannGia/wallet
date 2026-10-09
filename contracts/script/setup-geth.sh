#!/bin/sh
# Prepares the geth dev chain the ERC-7562 tests run against: funds the
# deterministic devnet keys the stack uses, then deploys the canonical
# EntryPoint exactly as on anvil.
#
# geth's dev mode ships the CREATE2 deployer, like anvil, and unlocks a single
# developer account holding the chain's ether; it pays everyone else.
set -eu

DEV=$(cast rpc eth_accounts | tr -d '[]" ' | cut -d, -f1)

# Public devnet keys, worthless anywhere else: anvil's account 0 deploys, and
# the first account of Ganache's published test mnemonic signs the bundles.
for ADDRESS in \
    0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
    0x627306090abaB3A6e1400e9345bC60c78a8BEf57
do
    if [ "$(cast balance "$ADDRESS")" = "0" ]; then
        cast send --unlocked --from "$DEV" "$ADDRESS" --value 1000ether >/dev/null
    fi
done

sh "$(dirname "$0")/deploy-entrypoint.sh"
