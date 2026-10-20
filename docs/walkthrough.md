# Driving the API by hand

The frontend (`./wallet demo up`) does all of this with buttons. These are the
same steps with `curl`, against the development stack, one service at a time --
the way to see what each worker does on its own.

## Watching a deposit arrive

```bash
./wallet up
./wallet deploy-token          # prints USDC_ADDRESS=0x...; paste it into .env
./wallet indexer               # in another terminal

# Signing up opens an account and signs in: the response carries a token.
ACCOUNT=$(curl -s -X POST localhost:3000/api/v1/users -H 'content-type: application/json' \
    -d '{"email":"a@example.com","password":"correct horse battery staple"}')
echo "$ACCOUNT"                # note depositAddress, accountId and token
TOKEN=$(echo "$ACCOUNT" | jq -r .token)

# Send tokens to that deposit address, then watch the balance.
./wallet cast "send $USDC_ADDRESS 'mint(address,uint256)' <depositAddress> 250000000 \
    --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

curl -s localhost:3000/api/v1/accounts/<accountId> -H "Authorization: Bearer $TOKEN"
```

The deposit appears first as `pendingBalance` and moves into `balance` once its
block is final. Raise `FINALITY_CONFIRMATIONS` to watch it sit in pending for
longer.

Note that `./wallet restart` restarts anvil too, and a devnet keeps no state:
every deployment is lost and `USDC_ADDRESS` has to be set again.

## Moving money inside the ledger

A balance comes only from a deposit like the one above: there is no endpoint
that credits an account out of nothing, since nothing on chain would back it.
Between users, money moves in the ledger alone -- free and instant.

```bash
BASE=localhost:3000/api/v1
BOB=$(curl -s -X POST $BASE/users -H 'content-type: application/json' \
    -d '{"email":"bob@example.com","password":"another long passphrase"}' | jq -r .accountId)

# Spending needs the owner's token; receiving needs only an account id.
curl -s -X POST $BASE/transfers -H 'content-type: application/json' \
    -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: t-1' \
    -d "{\"fromAccountId\":\"<accountId>\",\"toAccountId\":\"$BOB\",\"amount\":\"100000\"}"

# Send the exact same request again: it returns the stored result with 200
# instead of 201, and the money does not move twice.
curl -s -X POST $BASE/transfers -H 'content-type: application/json' \
    -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: t-1' \
    -d "{\"fromAccountId\":\"<accountId>\",\"toAccountId\":\"$BOB\",\"amount\":\"100000\"}"

# The ledger must always sum to zero. Admin endpoints take API_ADMIN_TOKEN.
curl -s $BASE/admin/reconciliation -H "Authorization: Bearer $API_ADMIN_TOKEN"
```

## Paying out on chain

```bash
./wallet cast "wallet new"     # a throwaway devnet key; put it in HOT_WALLET_PRIVATE_KEY
./wallet up                    # `restart` does NOT re-read .env; `up` recreates
./wallet withdrawer            # in another terminal

curl -s -X POST localhost:3000/api/v1/payouts -H 'content-type: application/json' \
    -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: p1' \
    -d '{"accountId":"5","to":"0x...","amount":"320000000"}'
```

The balance drops immediately and appears as `reservedBalance` until the chain
settles it. The hot wallet needs both the token and some native currency for
gas.

---

[Project README](../README.md)
