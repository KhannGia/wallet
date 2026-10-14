#!/bin/sh
# Deploys the proof-of-reserves registry onto the local chain and prints its
# address for .env.
#
# Devnet only. The registry accepts attestations from one key, the publisher's,
# fixed at deployment.
set -eu

# anvil's first account, as for every devnet deployment here. Public key.
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

if [ -z "${RESERVES_PUBLISHER_PRIVATE_KEY:-}" ]; then
    echo "Set RESERVES_PUBLISHER_PRIVATE_KEY in .env first; the registry trusts its address." >&2
    exit 1
fi
if [ -z "${USDC_ADDRESS:-}" ]; then
    echo "Set USDC_ADDRESS in .env first (./wallet deploy-token)." >&2
    exit 1
fi
PUBLISHER=$(cast wallet address --private-key "$RESERVES_PUBLISHER_PRIVATE_KEY")

# Flags first: --constructor-args takes every value after it.
REGISTRY=$(forge create --broadcast --private-key "$DEPLOYER_KEY" \
    src/reserves/ReservesRegistry.sol:ReservesRegistry \
    --constructor-args "$PUBLISHER" "$USDC_ADDRESS" | sed -n 's/^Deployed to: //p')

echo "RESERVES_REGISTRY_ADDRESS=$REGISTRY"
