# Tracker420RH Listener Core

This is the first implementation of the Tracker420RH discovery listener. It monitors the Robinhood Chain Pons V2 mothership contract, discovers candidate wallets from the BundleCreated event, watches those wallets’ later transactions, identifies ERC-20 mint receipts, and emits a structured `LAUNCH_DETECTED` record.

The listener is **dry-run only**. `BUY_ENABLED=false` is the default, and the current code deliberately contains no trading call. This is intentional until the Pons-only criteria, buy route, slippage limits, gas policy, and signing method are reviewed separately.

## Important Robinhood Chain detail

Robinhood Chain is EVM-compatible. The correct JSON-RPC subscription method is `eth_subscribe` over a compatible JSON-RPC WebSocket provider. `logsSubscribe` is Solana terminology and is not the method used by this listener.

The public Robinhood RPC endpoint is suitable for HTTP development reads but its root does not accept the JSON-RPC WebSocket handshake used by this program. Set `RPC_WS_URL` to a compatible provider endpoint, such as an Alchemy, QuickNode, dRPC, or equivalent Robinhood Chain WebSocket URL. The endpoint must support Alchemy’s enhanced `alchemy_minedTransactions` subscription on Robinhood Chain.

## Detection flow

The listener subscribes to mothership logs filtered by the known BundleCreated topic. When a matching log appears, it resolves the outer transaction sender and places that wallet in a time-limited candidate map. It then refreshes an Alchemy `alchemy_minedTransactions` WebSocket subscription with `{ addresses: [{ from: candidateWallet }] }`, so candidate-wallet transactions arrive directly without scanning every new block. Transactions are inspected regardless of destination contract or method selector.

A candidate wallet transaction becomes launch-like when its successful receipt contains an ERC-20 `Transfer` event whose `from` topic is the zero address, or when it is a successful call to the mothership using one of the currently known Pons launch selectors. Minted token contracts are validated with `eth_getCode`. The program then emits a `LAUNCH_DETECTED` JSON record and removes the wallet from the candidate map.

The selector set is intentionally only a hint. The primary discovery bridge is the wallet: `0x6bed` preparation event → candidate sender → later wallet transaction → receipt/token confirmation.

## Local setup

Copy `.env.example` to `.env`, set a compatible `RPC_WS_URL`, and leave `BUY_ENABLED=false`. Install dependencies with `pnpm install`. Validate with the TypeScript compiler, then run the dry-run listener with `pnpm start`.

Do not put a private key or GMGN API key in this project. GMGN is an analysis service in this workflow; the listener core does not need it to discover on-chain launches.

## Current limitations

This first core does not yet decode every Pons event ABI, recover internal traces, classify Pons versus non-Pons launches, submit transactions, or persist candidates across process restarts. The primary candidate-wallet path is event-driven through Alchemy’s address-filtered `alchemy_minedTransactions` subscription. Block reconciliation is retained only as an optional recovery mode through `ENABLE_BLOCK_RECONCILIATION=true`, and is disabled by default. The next implementation phase should add a durable state store, exact verified Pons event ABIs, and a reviewed execution adapter.
