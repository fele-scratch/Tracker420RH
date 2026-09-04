# Tracker420RH

Tracker420RH is a real-time Robinhood Chain listener. It watches the Pons V2 mothership, identifies wallets that initiate qualifying bundle interactions, follows those wallets for their next mined transactions, reports verified token launches, and can prepare a GMGN-routed unsigned BUY plan.

The production listener uses address-filtered `alchemy_minedTransactions` subscriptions:

1. A `from`-filtered subscription for the OKX funder, which pre-collects fresh funded wallets.
2. A `to`-filtered subscription for the Pons launch router.
3. A `to`-filtered subscription for the monitored mothership contract when enabled.
4. A `from`-filtered subscription that is rebuilt for currently active candidate wallets.

## Production flow

### 1. Watch the mothership

On each WebSocket connection, the bot subscribes to mined transactions sent to the configured mothership, which defaults to:

```text
0x6bed168687c1bca3466f1f3fb188c2dd058f4597
```

The request uses `alchemy_minedTransactions` with `addresses: [{ to: MOTHERSHIP_ADDRESS }]`, `includeRemoved: false`, and `hashesOnly: false`. This filter receives only mined transactions addressed to the mothership. Testing on Robinhood Chain with a high-activity contract delivered real transaction notifications through this filter.

### 2. Validate the bundle interaction

For each mothership transaction notification, the bot fetches that transaction's receipt with `eth_getTransactionReceipt`. It registers the initiating wallet when the successful transaction is sent to the mothership with the observed `createBundle(bytes32,uint8,uint64)` selector `0x33b8ac0e`. Candidate discovery does not depend on a hardcoded event topic; receipt logs are retained for the later launch analysis.

The transaction's `from` address is the initiating wallet. The bot uses the transaction hash as the candidate's source preparation transaction and the transaction block number as its first-seen block metadata.

### 3. Register the candidate wallet

The initiating wallet is normalized to lowercase and stored with its wallet address, source preparation transaction hash, first-seen block number, and an expiration time based on `CANDIDATE_TTL_MS`. Registering or refreshing a candidate immediately rebuilds the wallet subscription.

### 4. Subscribe to candidate wallets

The bot subscribes to active candidate wallets with the same verified mined-transaction method, filtering by sender:

```json
{
  "method": "eth_subscribe",
  "params": [
    "alchemy_minedTransactions",
    {
      "addresses": [{ "from": "DISCOVERED_WALLET" }],
      "includeRemoved": false,
      "hashesOnly": false
    }
  ]
}
```

When the candidate set changes, the previous candidate subscription is removed and replaced with a subscription containing the current wallet set. At most 1,000 wallets are included in one request; the bot logs when the candidate set exceeds that limit.

### 5. Receive and inspect wallet transactions

A candidate notification marked `removed` is ignored. For each remaining notification, the bot fetches the receipt for that transaction hash and requires receipt status `0x1`. It then attempts `trace_transaction` and `debug_traceTransaction`, treating traces as optional, and extracts token candidates from the receipt and any available trace data.

The HTTP RPC endpoint is used only for targeted lookups after filtered notifications: receipts, optional traces, deployed bytecode, and token metadata calls. The bot does not fetch blocks or scan unrelated transactions.

### 6. Identify and validate the token

The existing launch analysis checks these evidence paths:

- a direct contract-creation address in the receipt;
- an ERC-20 `Transfer` event minted from the zero address;
- a configured Pons launch event containing an address candidate;
- receipt log addresses and addresses encoded in log topics or data; and
- recursive trace call or creation addresses when trace data is available.

Known launch method selectors provide classification context. A selector alone is not enough to confirm a launch. The receipt must be successful and the analysis must identify a valid token candidate.

Generic token candidates must have deployed bytecode and respond successfully to at least one configured ERC-20 metadata or supply call. A token identified through a zero-address mint or the Pons launch event is trusted after bytecode validation.

### 7. Emit `LAUNCH_DETECTED`

The bot emits `LAUNCH_DETECTED` only after it has received a transaction from an active candidate wallet, confirmed a successful receipt, found launch evidence, and validated at least one token address.

The event includes the candidate wallet, source preparation transaction, launch transaction, destination, selector, block metadata, token addresses, evidence details, and the current dry-run action state. After emission, the candidate wallet is removed and the wallet subscription is refreshed.

## BUY planning

When `BUY_RECIPIENT` is configured and a validated token is detected, the bot requests a route from GMGN for Robinhood Chain using native ETH as the input asset and the detected token as the output asset. It then submits the returned route to GMGN's documented simulation endpoint. A valid response must provide a complete transaction envelope including the route entry contract, calldata, value, chain ID, nonce, gas limit, and fee fields.

With `BUY_ENABLED=true`, the bot submits `POST /v1/trade/swap` to GMGN's Agent API using `X-APIKEY`, `X-Signature`, `timestamp`, and `client_id`. The signature follows GMGN's documented `{sub_path}:{sorted_query}:{raw_body}:{timestamp}` format. This is a real hosted-wallet trade, not an unsigned transaction plan; the matching `GMGN_PRIVATE_KEY` must belong to the public key registered with GMGN. Keep `BUY_ENABLED=false` while testing.

## Configuration

Copy the template and provide the required endpoints:

```bash
cp .env.example .env
pnpm install
pnpm build
pnpm start:production
```

Use `pnpm dev` or `pnpm start` for the TypeScript development runner. The production command runs the compiled output from `dist/`. The listener validates required endpoints and numeric settings at startup, reconnects after an unexpected WebSocket close, and closes its socket cleanly on `SIGINT` or `SIGTERM`.

Environment variables defined by the bot are:

| Variable | Required | Purpose |
|---|---:|---|
| `RPC_HTTP_URL` | Yes | HTTP JSON-RPC endpoint for targeted transaction, receipt, trace, bytecode, and token validation calls. |
| `RPC_WS_URL` | Yes | WebSocket endpoint supporting address-filtered `alchemy_minedTransactions`. |
| `MOTHERSHIP_ADDRESS` | No | Monitored contract. Defaults to the Pons V2 mothership address. |
| `MIN_FUND_ETH` / `MAX_FUND_ETH` | No | Inclusive native funding bounds for OKX funder discovery. Defaults to `0.56` and `3.6`. |
| `CANDIDATE_TTL_MS` | No | Candidate lifetime in milliseconds. Defaults to `172800000` (48 hours). |
| `FUND_ALERT_BOT_TOKEN` / `FUND_ALERT_CHAT_ID` | No | Separate Telegram destination for qualifying `0.6` to `1.1` ETH funding alerts. |
| `INITIAL_CANDIDATE_WALLETS` | No | Comma-separated wallet addresses to seed as candidates at startup. The template includes the explicitly requested wallet as an example; remove or replace it as needed. Each seeded wallet follows the same expiry and launch validation rules as a discovered wallet. |
| `BUY_PLAN` | No | Preferred prepare-only flag. If `true`, the bot prepares and logs a GMGN route plan but never submits or broadcasts it. |
| `BUY_EXECUTE` | No | Must remain `false` for this repo. It hard-disables send/submit logic; no eth_sendRawTransaction or GMGN execution path is allowed. |
| `BUY_ENABLED` | No | Backward-compatible alias for `BUY_PLAN`; treated as prepare-only mode and never executes. |
| `BUY_RECIPIENT` | No | Bot wallet that receives purchased tokens and is sent to GMGN as `from_address`. A BUY plan is omitted when unset. |
| `BUY_AMOUNT_WEI` | No | Native ETH input amount. Accepts decimal ETH such as `0.0008` or an integer wei value. Defaults to `0.0008 ETH`. |
| `BUY_EXECUTION_MODE` | No | `gmgn_agent_swap` is the supported Agent API execution mode. |
| `GMGN_API_KEY` | Required for GMGN quote/plan creation | GMGN Agent API key created at `gmgn.ai/ai` and sent as `X-APIKEY`. |
| `GMGN_PRIVATE_KEY` | Required for GMGN quote/plan creation | PEM Ed25519 or RSA private key matching the public key registered with GMGN. Used locally to sign Agent API requests. |
| `GMGN_SLIPPAGE_PERCENT` | No | Slippage percentage passed to GMGN simulation. Defaults to `15`. |

Do not place API keys, private keys, or credential-bearing files in source control. The bot redacts the credential portion of `/v2/<key>` WebSocket URLs in its connection log.

## Current limitations

- WebSocket reconnects are automatic after a connection closes, and subscriptions are recreated on the new connection.
- A subscription acknowledgement confirms provider acceptance; it does not by itself prove transaction delivery.
- Candidate wallets are held in process memory and expire after `CANDIDATE_TTL_MS`; a periodic cleanup removes expired wallets from the active subscription. Reusing a wallet in a later successful `createBundle` registers it again with a fresh expiry. Candidates do not survive a process restart.
- At most 1,000 candidate wallets are included in one candidate subscription refresh.
- Receipt, bytecode, metadata, and trace calls depend on the configured HTTP provider. Trace support is optional; receipt evidence remains the primary analysis input.
- The bot does not persist candidates or replay missed WebSocket notifications after a process restart.
- `BUY_ENABLED=false` is the intended current mode. The bot detects launches but does not call GMGN.
- BUY execution requires a configured recipient, `GMGN_API_KEY`, matching `GMGN_PRIVATE_KEY`, funded GMGN Robinhood trading wallet, and a valid Agent API response. Agent API swaps are real transactions.
- A candidate wallet must be discovered before its wallet-specific subscription exists. Transactions before discovery or during a WebSocket outage may not be observed.

## Tests

Run the typecheck and complete test suite:

```bash
pnpm typecheck
pnpm test
```

The tests cover launch-evidence extraction, candidate registration, filtered subscription request shape, failed transactions, direct creation, mint events, Pons launch payloads, and optional trace evidence. The historical replay test requires the corresponding JSON fixtures under `audit/`.

The standalone research probe under `experimental/wallet-websocket-probe/` is not part of the production listener.
