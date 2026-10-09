#!/bin/sh
# Starts eth-infinitism's reference bundler -- written by the authors of
# ERC-4337 and ERC-7562 -- in safe mode against the geth dev chain.
#
# Safe mode is its default: every operation is traced, and one that reads the
# clock or storage not associated with its sender is refused.
#
# It signs bundles with the first account of a mnemonic. This one is Ganache's
# published test phrase: public, worthless anywhere but this devnet, and kept
# apart from anvil's so the bundler never shares a nonce with the tests.
set -eu

mkdir -p /tmp/bundler
echo "candy maple cake sugar pudding cream honey rich smooth crumble sweet treat" > /tmp/bundler/mnemonic

cat > /tmp/bundler/config.json <<JSON
{
  "chainId": ${CHAIN_ID},
  "network": "${RPC_URL}",
  "beneficiary": "0x627306090abaB3A6e1400e9345bC60c78a8BEf57",
  "mnemonic": "/tmp/bundler/mnemonic",
  "gasFactor": "1",
  "minBalance": "0",
  "maxBundleGas": 10000000,
  "autoBundleInterval": 1,
  "autoBundleMempoolSize": 0
}
JSON

exec /app/bundler.sh --config /tmp/bundler/config.json --auto --port 3000
