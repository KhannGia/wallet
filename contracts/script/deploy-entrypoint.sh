#!/bin/sh
# Deploys the canonical ERC-4337 EntryPoint v0.8 onto the local chain, at the
# same address it has on every public network.
#
# Not a fresh compile: the creation code is the reference repository's own
# deployment artifact, and the salt is the one used on mainnet, sent through the
# same CREATE2 deployer that anvil ships with. Bundlers recognise an EntryPoint's
# version by its address, so a copy anywhere else would not be served at all.
#
# Idempotent, and checks the result rather than trusting the transaction.
set -eu

ENTRYPOINT=0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108
CREATE2_DEPLOYER=0x4e59b44847b379578588920ca78fbf26c0b4956c
SALT=0a59dbff790c23c976a548690c27297883cc66b4c67024f9117b0238995e35e9
ARTIFACT=lib/account-abstraction/deployments/ethereum/EntryPoint.json

# anvil's first account. Printed in anvil's own banner; worthless anywhere else.
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

if [ "$(cast code "$ENTRYPOINT")" != "0x" ]; then
    echo "EntryPoint v0.8 already at $ENTRYPOINT"
    exit 0
fi

if [ ! -f "$ARTIFACT" ]; then
    echo "Missing $ARTIFACT. Run ./wallet install-forge first." >&2
    exit 1
fi

BYTECODE=$(sed -n 's/.*"bytecode": "0x\([0-9a-f]*\)".*/\1/p' "$ARTIFACT" | head -n 1)
cast send "$CREATE2_DEPLOYER" "0x$SALT$BYTECODE" --private-key "$DEPLOYER_KEY" >/dev/null

if [ "$(cast code "$ENTRYPOINT")" = "0x" ]; then
    echo "Deployment did not produce code at $ENTRYPOINT" >&2
    exit 1
fi
echo "EntryPoint v0.8 deployed at $ENTRYPOINT"
