# Robinhood Chain wallet WebSocket probe

Standalone experiment for testing Alchemy wallet-filtered subscriptions. It does not import Tracker420RH source code, poll blocks, or use `alchemy_minedTransactions` without an address filter.

## Run

From the repository root, provide the endpoint and wallet through the environment. The endpoint is never printed by the probe.

```bash
RPC_WS_URL="$RPC_WS_URL" TARGET_WALLET=0xYourWallet \
  PROBE_METHOD=mined PROBE_DURATION_MS=60000 \
  node experimental/wallet-websocket-probe/probe.mjs

RPC_WS_URL="$RPC_WS_URL" TARGET_WALLET=0xYourWallet \
  PROBE_METHOD=pending PROBE_DURATION_MS=60000 \
  node experimental/wallet-websocket-probe/probe.mjs
```

`PROBE_METHOD` is `mined` or `pending`. `DISCOVERY_DELAY_MS` defaults to 1000 and represents candidate discovery: the socket first connects with no wallet subscription, then creates the wallet subscription. `RECONNECT_DELAY_MS` defaults to 1000.

The probe exits with status 0 only after an actual notification whose `from` or `to` matches `TARGET_WALLET` is received. Status 3 means the observation ended without matching delivery, including the case where the subscription was accepted. WebSocket or subscription errors are printed without the endpoint.

## Exact requests

Mined:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_subscribe",
  "params": [
    "alchemy_minedTransactions",
    {
      "addresses": [{ "from": "TARGET_WALLET" }],
      "includeRemoved": false,
      "hashesOnly": false
    }
  ]
}
```

Pending:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_subscribe",
  "params": [
    "alchemy_pendingTransactions",
    {
      "fromAddress": ["TARGET_WALLET"],
      "toAddress": ["TARGET_WALLET"]
    }
  ]
}
```

Every JSON line is labelled. `SUBSCRIPTION_ACCEPTED` is acknowledgement only. `TRANSACTION_NOTIFICATION_RECEIVED` records the hash, from, to, block number, status, provider timestamp when present, and local receipt time. `WALLET_TRANSACTION_CONFIRMED` is the delivery result used by the summary.

The probe cannot create a blockchain transaction. For the dynamic reproduction, run it while the discovered wallet is expected to transact after the `CANDIDATE_WALLET_DISCOVERED` line. A matching notification is the evidence needed for the Solana-like sequence: discover, subscribe, receive, then analyze only that transaction.

## Reporting

For each method, record:

- whether `SUBSCRIPTION_ACCEPTED` appeared;
- whether `WALLET_TRANSACTION_CONFIRMED` appeared;
- `latencyMs` from probe start and, if available, compare provider timestamp to local receipt time;
- the exact request shape and any provider error;
- any CU/billing information visible in provider responses or dashboard data;
- whether observed delivery is sufficient to replace the all-mined stream.

An acknowledgement without a matching notification is not a working result.
