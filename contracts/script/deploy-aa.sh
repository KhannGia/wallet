#!/bin/sh
# Deploys the account factory, the paymaster and the guardian module onto the
# local chain, funds the paymaster's deposit and stake, and prints the addresses
# for .env.
#
# Devnet only. The EntryPoint must already be there: ./wallet up starts the
# bundler, which waits for it.
set -eu

ENTRYPOINT=0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108
# anvil's first account, as for every devnet deployment here. Public key.
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_KEY")

if [ "$(cast code "$ENTRYPOINT")" = "0x" ]; then
    echo "No EntryPoint at $ENTRYPOINT. Start the stack first (./wallet up)." >&2
    exit 1
fi
if [ -z "${PAYMASTER_SIGNER_PRIVATE_KEY:-}" ]; then
    echo "Set PAYMASTER_SIGNER_PRIVATE_KEY in .env first; the paymaster trusts its address." >&2
    exit 1
fi
SIGNER=$(cast wallet address --private-key "$PAYMASTER_SIGNER_PRIVATE_KEY")

# Flags first: --constructor-args takes every value after it.
deploy() {
    forge create --broadcast --private-key "$DEPLOYER_KEY" "$@" | sed -n 's/^Deployed to: //p'
}

FACTORY=$(deploy src/aa/AccountFactory.sol:AccountFactory --constructor-args "$ENTRYPOINT")
PAYMASTER=$(deploy src/aa/VerifyingPaymaster.sol:VerifyingPaymaster \
    --constructor-args "$ENTRYPOINT" "$SIGNER" "$DEPLOYER")

MODULE=$(deploy src/aa/GuardianModule.sol:GuardianModule)

cast send "$PAYMASTER" "deposit()" --value 10ether --private-key "$DEPLOYER_KEY" >/dev/null
cast send "$PAYMASTER" "addStake(uint32)" 86400 --value 1ether --private-key "$DEPLOYER_KEY" >/dev/null

echo "ACCOUNT_FACTORY_ADDRESS=$FACTORY"
echo "PAYMASTER_ADDRESS=$PAYMASTER"
echo "GUARDIAN_MODULE_ADDRESS=$MODULE"
