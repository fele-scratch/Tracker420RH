# Tracker420RH

**Tracker420RH is a live, real-time Robinhood Chain launch listener.** Its job is to watch the `0x6bed` Pons V2 mothership, identify the wallet behind a preparation or bundle transaction, immediately begin listening to that wallet, recognize the wallet’s launch transaction, identify the token contract, and emit `LAUNCH_DETECTED` as soon as launch evidence is available.

This is a **streaming bot**, not a block-scanning bot. The primary path uses persistent JSON-RPC WebSocket subscriptions so new mothership events and candidate-wallet transactions are delivered as they occur. The bot does not wait for a loop to pull every block from the last checkpoint before it can react.

## Live streaming architecture

Robinhood Chain is EVM-compatible. Tracker420RH uses EVM `eth_subscribe` over a compatible WebSocket endpoint. Solana’s `logsSubscribe` method is not used here.

The bot maintains two live streams:

| Stream | Purpose |
|---|---|
| Mothership log stream | Watches `0x6bed168687c1bca3466f1f3fb188c2dd058f4597` for the configured bundle/preparation event topic. |
| Candidate-wallet mined-transaction stream | Dynamically subscribes to each discovered wallet with Alchemy’s address-filtered `alchemy_minedTransactions` subscription using `{ from: candidateWallet }`. |

When a mothership event arrives, Tracker420RH resolves the outer transaction sender and immediately adds that wallet to the candidate set. The wallet subscription is then refreshed so the wallet’s next mined transaction can be inspected directly, without waiting for a block-by-block catch-up process.

## Launch detection

The developer’s subsequent buy is **not required**. A candidate transaction is considered launch evidence only when it is successful and the token can be identified from reliable execution evidence. The detector currently checks:

- a direct contract-creation address in the receipt;
- an ERC-20 `Transfer` event minted from the zero address;
- verified Pons launch-event payloads, including the observed `0x916d099c` path;
- receipt-level token and factory events emitted by nested execution; and
- optional recursive trace targets when the connected provider exposes transaction traces.

Known selectors such as `0x70237117`, `0x3c05c981`, and `0x916d099c` are classification hints only. A selector by itself cannot trigger a launch. The bot requires a successful receipt and an identified token contract before emitting `LAUNCH_DETECTED`.

The core sequence is:

```text
0x6bed preparation event
        ↓
outer transaction sender discovered
        ↓
wallet-specific WebSocket subscription created
        ↓
candidate wallet transaction arrives
        ↓
receipt, input, logs, and optional trace inspected
        ↓
actual token contract identified
        ↓
LAUNCH_DETECTED emitted immediately
```

## Current execution mode

The repository is currently configured for safe detection and dry-run development. `BUY_ENABLED=false` is the default, and the listener contains no live signing or trading call. The simulated buy tests use an exact amount of `0.0008 ETH`, but they do not contact a router, sign a transaction, or broadcast anything.

Any future execution adapter must be reviewed separately for the selected Pons-only route, token filters, slippage limits, gas policy, nonce handling, retry policy, and signing method.

## Configuration

Copy `.env.example` to `.env` and provide a Robinhood Chain HTTP endpoint plus a compatible WebSocket endpoint:

```bash
cp .env.example .env
pnpm install
pnpm typecheck
pnpm start
```

The WebSocket provider must support the address-filtered `alchemy_minedTransactions` subscription. The public HTTP RPC endpoint is not used as the primary wallet listener. `ENABLE_BLOCK_RECONCILIATION=false` should remain disabled for the normal live streaming path; it exists only as an optional recovery mechanism for missed provider messages or reconnect gaps.

Do not commit `.env`, private keys, PATs, API keys, or raw credential-bearing files. GMGN is used for analysis and is not required by this listener core.

## Tests

Run the complete local suite with:

```bash
pnpm test
```

Run only the fast dry-run buy simulation with:

```bash
pnpm test:buy-dry-run
```

The tests cover synthetic mothership discovery, dynamic wallet registration, candidate-wallet launch detection, direct creation, zero-address minting, Pons event payloads, nested trace fixtures, failed transactions, missed-transaction regression cases, and the simulated `0.0008 ETH` buy/retry path.

## Known provider limitation

The streaming design is primary, but enhanced subscription support is provider-specific. A WebSocket handshake acknowledgement proves that the request was accepted; it does not by itself prove that every Robinhood Chain mined transaction will be delivered through the enhanced address filter. The listener therefore records subscription errors and reconnects automatically. If the provider does not deliver enhanced wallet notifications reliably, use a provider with confirmed Robinhood Chain support for this subscription type or add a second independent real-time wallet-activity feed. Block reconciliation must remain recovery-only, not the main detection mechanism.

## Repository status

This is the event-driven listener core for Tracker420RH. It is suitable for local dry-run testing and further integration work. It is not a live-money trading system until an execution adapter is deliberately implemented, tested, and enabled.
